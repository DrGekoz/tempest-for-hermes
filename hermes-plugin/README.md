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
  (blow-the-blast-radius-to-zero, the Tempest model). Review each agent's log
  and a `git diff` before merging.
- **Local & private.** The whole graph, index and agents live on your machine.

## Layout

```
hermes-plugin/
  __init__.py         plugin entry (register() -> tool + hooks + HTTP dashboard)
  plugin.yaml         manifest
  web/index.html      dark dashboard: projects / context / parallel agents
  runtime/            Node runtime wrapping @usetempest/atlas
    atlas-bridge.mjs  CLI bridge: index | context | stats | search | projects
    package.json      deps: @usetempest/atlas
  scripts/install.py  one-shot setup into ~/.hermes/plugins
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

Set the active project from the dashboard (Projects tab) so the tool resolves
the right repo, or pass `project` explicitly.

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
- `TEMPEST_HERMES_PY` — Python interpreter used to run Hermes agents
  (`-m hermes_cli.main`). Auto-detected on Windows.
- `TEMPEST_AGENT_CMD` — template to override the per-agent command
  (`{project}` / `{prompt}` substituted). Useful for testing the orchestrator.
- `TEMPEST_OPEN_DASHBOARD=1` — open the dashboard in a browser on plugin load.

## Tests

```bash
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
