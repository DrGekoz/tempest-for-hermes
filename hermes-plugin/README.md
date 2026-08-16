# Tempest for Hermes — Hermes plugin

This directory is the **Hermes plugin** half of the `tempest-for-hermes` fork. It
brings Tempest's Token Intelligence (the `@usetempest/atlas` semantic code
knowledge graph) and its parallel worktree-isolated agent orchestration to
Hermes, without needing a Tauri/Rust build.

## What it does

- **Token Intelligence inside Hermes.** Index a codebase *once* with atlas.
  Then any Hermes agent can call the `tempest_context` tool to pull **surgical
  context** for a task from the shared graph — relevant entry points, related
  files and code blocks — instead of reading the whole repo. That is the Tempest
  claim ("86% fewer tokens, 92% fewer tool calls") now applied to Hermes agents.
- **Parallel Hermes agents in isolated worktrees.** Spawn N agents from the
  dashboard; each runs `hermes chat -q <prompt>` in its own `git worktree` +
  branch, so no agent can ever touch another's files or your main branch
  (blow-the-blast-radius-to-zero, the Tempest model). Review each agent's log,
  a full diff, then merge or discard with one click.
- **Local & private.** The whole graph, index and agents live on your machine.

## What changed in v1.1

- **Persistent atlas bridge.** v1.0 spawned a fresh Node subprocess per request
  (Node boot + module load + graph open every time). v1.1 runs one long-lived
  `node atlas-bridge.mjs` process speaking JSON-lines over stdin/stdout —
  requests reuse the warm process, so `tempest_context` calls are dramatically
  faster. The v1.0 one-shot mode is still available (`TEMPEST_BRIDGE=oneshot`)
  and is the automatic fallback if the persistent process can't start.
- **Threaded HTTP server.** Each connection is handled in its own thread, so a
  slow index/context call no longer blocks `/state`, `/health` or the dashboard.
- **cwd-aware project resolution.** With no active project set, the tool now
  resolves the indexed project containing the agent's working directory
  (deepest match wins) instead of arbitrarily picking the first indexed repo.
  Override with `TEMPEST_CWD`.
- **Auto-sync of stale indexes.** Before serving context, the plugin does a
  cheap staleness probe (`git status --porcelain` for git repos, a time-based
  fallback for others) and incrementally refreshes the index if the repo
  changed — so context never drifts from the code on disk.
- **Agent lifecycle control.** Kill a running agent, see its full diff
  (stat + body, capped at 200 KB), merge its branch into the project's default
  branch with `--no-ff`, or clean up (forced worktree removal + branch delete).
  Sessions orphaned by a Hermes restart are detected (dead pid) and marked
  `interrupted` instead of hanging forever as "running".
- **Smarter Hermes Python detection.** Probes uv's tool dir and the `hermes`
  shim in addition to the known install paths.

## Layout

```
hermes-plugin/
  __init__.py         plugin entry (register() -> tool + hooks + HTTP dashboard)
  plugin.yaml         manifest
  web/index.html      dark dashboard: projects / context / parallel agents
  runtime/            Node runtime wrapping @usetempest/atlas
    atlas-bridge.mjs  bridge: server (persistent) or CLI (one-shot) mode
    test-bridge.mjs   smoke test for both bridge modes
    package.json      deps: @usetempest/atlas
  scripts/install.py  one-shot setup into ~/.hermes/plugins
  scripts/test_plugin.py  headless end-to-end test harness
```

## Install

```bash
cd hermes-plugin
python scripts/install.py          # npm-installs runtime + links into ~/.hermes/plugins + enables in config
# restart Hermes (gateway/CLI), then open:
#   http://127.0.0.1:8124
```

Or manually: `npm install` in `runtime/`, put this folder at
`~/.hermes/plugins/tempest-for-hermes/`, add `tempest-for-hermes` to
`plugins.enabled` in `config.yaml`, restart Hermes.

## Using the tool

Once a project is indexed, a Hermes agent can ask for context:

```
> what part of the cart applies discounts and computes totals?
[agent calls tempest_context(query=..., maxCodeBlocks=8)]
> ## Code Context ... src/cart.js:2 ...
```

Project resolution order: explicit `project` argument → active project set in
the dashboard → the indexed project containing the current working directory →
the first indexed project. Indexes are refreshed automatically when the repo
changes (see "Auto-sync" above).

## Config (config.yaml)

```yaml
plugins:
  entries:
    tempest-for-hermes:
      port: 8124
      enabled: true
```

Env vars (all optional):

- `TEMPEST_REGISTRY` — where the project registry JSON lives (default
  `~/.tempest-for-hermes/projects.json`).
- `TEMPEST_BRIDGE=oneshot` — force the v1.0 one-shot subprocess bridge instead
  of the persistent process (debugging/tests).
- `TEMPEST_RUNTIME_DIR` — directory containing `atlas-bridge.mjs` + `node_modules`
  (defaults to the plugin's `runtime/`). Used by the test harness.
- `TEMPEST_HERMES_PY` — Python interpreter used to run Hermes agents
  (`-m hermes_cli.main`). Auto-detected on Windows.
- `TEMPEST_AGENT_CMD` — template to override the per-agent command
  (`{project}` / `{prompt}` substituted). Useful for testing the orchestrator.
- `TEMPEST_CWD` — pretend the working directory is this path when resolving the
  active project (headless/cron runs without a real cwd).
- `TEMPEST_STALE_MS` — time-based staleness threshold for non-git projects
  (default 300000 = 5 minutes).
- `TEMPEST_OPEN_DASHBOARD=1` — open the dashboard in a browser on plugin load.

## Tests

```bash
# bridge smoke test (both one-shot and persistent server mode)
cd runtime
npm test

# headless end-to-end harness (bridge, tool, HTTP endpoints, worktree agents,
# kill / merge / cleanup) against a throwaway HERMES_HOME
python scripts/test_plugin.py

# manual bridge checks
cd runtime
npm install
node atlas-bridge.mjs version '{}'
node atlas-bridge.mjs index '{"project":"/path/to/repo"}'
node atlas-bridge.mjs context '{"project":"/path/to/repo","query":"how does X work?"}'
```

## Credits

Knowledge-graph engine: [`@usetempest/atlas`](https://www.npmjs.com/package/@usetempest/atlas)
by the Tempest team (MIT). This plugin adapts their Token Intelligence + agent
isolation design to Hermes.