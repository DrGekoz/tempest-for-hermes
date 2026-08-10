![Tempest — parallel AI agent sessions](media/wordmark.png)

<h2 align="center">
  <strong>Run Claude Code, Codex, Gemini and any other CLI Agent with 64% fewer tokens</strong>
</h2>

<p align="center">
  Tempest indexes your codebase once and gives every agent a shared knowledge base, so they spend less context understanding your code and more tokens actually building.
</p>

<p align="center">
  <a href="https://github.com/tempestai-dev/tempest/releases">
    <img src="https://img.shields.io/github/v/release/tempestai-dev/tempest" alt="Version" />
  </a>
  <a href="https://github.com/tempestai-dev/tempest/releases">
    <img src="https://img.shields.io/github/downloads/tempestai-dev/tempest/total?color=2ea043" alt="Downloads" />
  </a>
  <img src="https://img.shields.io/badge/macOS-Supported-grey?logo=apple&logoColor=white&labelColor=000000" alt="macOS" />
  <img src="https://custom-icon-badges.demolab.com/badge/Windows-Supported-grey?logo=windows11&logoColor=white&labelColor=0078D6" alt="Windows" />
  <img src="https://img.shields.io/badge/Linux-Supported-grey?logo=linux&logoColor=black&labelColor=FCC624" alt="Linux" />
  <a href="https://tauri.app/">
    <img src="https://img.shields.io/badge/built%20with-Tauri%202-orange" alt="Tauri" />
  </a>
  <a href="https://github.com/tempestai-dev/tempest/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-Apache%202.0-green" alt="License" />
  </a>
  <a href="https://github.com/tempestai-dev/tempest/actions/workflows/ci.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/tempestai-dev/tempest/ci.yml?branch=main&label=build" alt="CI" />
  </a>
</p>

![Tempest — parallel AI agent sessions](media/tempest.png)

## Why Tempest uses far fewer tokens

Run five agents in parallel and each one reads your entire codebase from scratch — the same files, the same context, five times over. You pay for every token, every time.

**Token Intelligence** is a local code-knowledge graph that lives on your machine and is shared across every parallel agent session. When an agent needs to understand your codebase, it pulls from the shared graph instead of scanning files on its own. The work is done once. Every session benefits.

- **Up to 64% less context token consumption**
- **Up to 58% fewer tool calls**

No other parallel-agent tool does this.

## One window. Every agent. No collisions.

Claude Code, Aider, OpenCode, Copilot CLI, Cline, Goose — all running in parallel, each in its own isolated git worktree and branch. Agents never touch each other's files. No merge conflicts mid-run. No stashing. No detective work about who changed what.

A rogue agent run never touches your main branch or anyone else's work. **Blast radius: zero.**

- **Live status across every session** — know the moment each agent finishes, without babysitting.
- **Full history per session** — close a tab, reopen it, the agent picks up exactly where it left off.
- **Built-in diff and PR** — review each agent's changes, then stage, commit, push, and open a PR without leaving Tempest.

## Process-isolated. Fully autonomous. Out of the box.

Every agent session in Tempest runs inside **Hephaestus** — a first-party process isolation layer built into the app. No configuration required.

| Platform | Isolation |
|----------|-----------|
| Windows | Job Objects — entire process tree confined and killed atomically on session close |
| macOS | Seatbelt (SBPL) — deny-default sandbox via `sandbox-exec` |
| Linux | bubblewrap — `--unshare-pid --die-with-parent --unshare-net` user namespaces |

Agents also run **fully permissionless by default**. Tempest passes each agent's skip-permissions flag at spawn — no mid-run confirmation dialogs, no interruptions. Claude Code gets `--dangerously-skip-permissions`, Gemini CLI gets `--yolo`, Codex CLI gets `--dangerously-bypass-approvals-and-sandbox`.

Both behaviours are toggles in **Settings → Security**. You stay in control.

**Tempest is built using Tempest** — every feature in this repo was shipped by parallel agents running inside the app.


## What's next

**Database Branches** — per-project Docker-based DB isolation is shipping now. Each project gets its own branched database container so agents can migrate, break, and restore data without touching anything else.

See [ROADMAP.md](ROADMAP.md) for the full picture. **Star this repo** — we announce here first.

## Project

- [Roadmap](ROADMAP.md) — where Tempest is going and what's currently being built
- [Contributing](CONTRIBUTING.md) — setup, workflow, and how to send a PR
- [Code of Conduct](CODE_OF_CONDUCT.md) — how we behave in project spaces
- [Security policy](SECURITY.md) — reporting vulnerabilities (please do not open a public issue)
- [License](LICENSE) — Apache 2.0

## Build from source

Pre-built binaries are available for Windows, macOS, and Linux.

```bash
# Prerequisites: Node.js 18+, Rust 1.77+
# Windows also requires WebView2 Runtime:
# https://developer.microsoft.com/en-us/microsoft-edge/webview2/
git clone https://github.com/tempestai-dev/tempest
cd tempest
npm install
npm run dev        # development with hot reload
npm run build      # production build -> dist-installers/
```

## Star History

[![Star Trail](https://star-trail.fun/api/chart/tempestai-dev/tempest)](https://star-trail.fun/tempestai-dev/tempest)

## Community

[X (Twitter)](https://x.com/usetempest) — @usetempest

[GitHub](https://github.com/tempestai-dev/tempest)

[Instagram](https://instagram.com/usetempest)

[LinkedIn](https://linkedin.com/company/usetempest)

