# Tempest Roadmap

This document describes where Tempest is going and why. It is a living record of intent, not a promise list. Priorities shift as we learn what engineers actually need. The direction does not. It also doubles as the on-ramp for contributors: each active area below names concrete, pick-up-able work.

## The direction

Parallel agent sessions are the foundation. Tempest is an engineering platform where multiple agents work on a codebase the way a team does — with isolation guarantees, shared context, and full tooling to review and ship their work. Every workstream below serves that: making each agent smarter and safer, and making the surface you orchestrate them from feel like one coherent space rather than a stack of terminals.

## Now building: Threads — the canvas workspace

We are migrating Tempest's single, linear chat into **Threads**: a spatial, node-based canvas where research, discussion, and agent-launching happen as **nodes** instead of one scrolling pane. The canvas is the planning and orchestration surface; execution (agents, terminals) binds to git branches.

Why this matters: a linear chat can only hold one line of thought. Real engineering work forks — you are weighing three approaches, running two agents on two branches, and keeping notes alongside both. A canvas lets those coexist and share ambient context without collapsing into one thread.

The model, in short:

- **One canvas per tab.** A project has many canvases (listed in the sidebar Threads dropdown); each is a flat surface of nodes.
- **Nodes** are the atomic unit: `chat`, `text`, `agent`, `terminal`. Thinking nodes (chat, text) carry no branch; execution nodes (agent, terminal) bind to a git branch and a real PTY session.
- **Ambient context, not file dumps.** The canvas shares node types, titles, and output summaries. Full code enters context only through a specific agent node's own working directory.
- **Reuse over rebuild.** Agent/terminal nodes render existing PTY sessions; the chat node reuses the existing streaming and tool infrastructure. Git context is a callable tool, not a silent prepend.

Chat nodes are **BYOK** (bring your own key) for now — direct API via the existing streaming path.

## Tempest Bridge: connect any CLI agent

Separate from the BYOK chat node, we want to build the **bridge between Tempest and the CLI coding agents developers already use** — driving an existing agent (starting with Claude Code, via its Agent SDK) as a first-class backend inside Tempest, without hand-parsing terminal bytes. A user with no API key should be able to point Tempest at their installed CLI and get the same node experience.

This is an open, wanted workstream and a great place to collaborate directly. It needs a design pass first (transport, account- vs per-node connection, which CLIs, how the agent's own tools coexist with ours). The plan's §12 captures the current thinking and the known risk (Windows process spawning). If you want to help build the bridge, this is the front door.

## Foundation

**Token Intelligence.** A local code-knowledge graph, built per project, that agents query directly instead of firing repeated file reads and blind searches. Benchmarked across 7 real-world projects (TypeScript, Python, Rust, Go, Java, Swift): up to 64% fewer tokens on large codebases and 58% fewer tool calls on average. Built in — no configuration, no separate service.

**Database Branches.** Every agent gets its own live, isolated Postgres connection — a real copy of your source database it can migrate, break, and reset without ever touching production or another agent's database. When the session ends, the branch is cleaned up. Real backend work, in parallel, with zero blast radius.

## On the roadmap

**macOS support** — the core architecture is cross-platform; macOS packaging and testing is in progress, Linux follows.

**Multi-agent coordination** — agents aware of each other's work, not just isolated from it: shared task context, merge-ready handoffs, composable workflows without giving up the isolation guarantees.

**Enterprise controls** — audit logs, SSO, team workspaces, usage governance, for environments where those are not optional.

**Context / retrieval layer** — semantic search across a canvas and RAG fallback when connected context overflows the model's window. Deliberately deferred until a real canvas hits that ceiling; the ambient metadata graph covers the common case today.

## Feature requests welcome

Threads is young and the node model is meant to grow — document, web, image, and diff nodes; @mention-a-node context; richer canvas search. If you want a node type or a canvas capability that isn't here, open an issue. Requests that sharpen the orchestration surface are exactly what we're looking for.

## How this document works

Shipping order changes. This document reflects current priorities, not a fixed timeline. When something ships, it moves out of this file and into the changelog. Star the repo to get notified when that happens.
