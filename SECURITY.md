# Security Policy

Thank you for helping keep Tempest and its users safe.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Email **[gsvprharsha@tempestai.dev](mailto:gsvprharsha@tempestai.dev)** with:

- A description of the issue and its impact
- Steps to reproduce (proof-of-concept, minimal test case, or screenshots)
- The affected version(s) — see below
- The platform you observed it on (Windows / macOS / Linux)
- Any suggested remediation, if you have one

If you'd prefer an encrypted channel, mention that in your first email and we'll arrange one.

## What to expect

- **Acknowledgement** within 3 business days
- **Initial assessment** (severity, affected versions, whether we can reproduce) within 7 business days
- **Fix or mitigation timeline** shared with you once assessment is done
- **Public disclosure** coordinated with you — typically after a fix has shipped and users have had a reasonable window to update

We'll credit you in the release notes and this file's acknowledgements section unless you'd rather stay anonymous.

## Scope

In scope:

- The Tempest desktop application (Tauri shell, React frontend, Rust core)
- The Claude Code bridge (`src-tauri/resources/claude-bridge/`)
- The Hephaestus isolation layer (Windows Job Objects, macOS `sandbox-exec`, Linux bubblewrap)
- Database Branches (isolation guarantees, credential handling)
- Token Intelligence (local knowledge graph — data handling, path traversal, etc.)
- Automations runtime
- Build & release artifacts published on GitHub Releases

Out of scope:

- Vulnerabilities in upstream dependencies that have already been reported upstream (please report those directly to the maintainer). We're happy to hear about them, but we can't take credit for fixes we don't own.
- Issues that require an attacker to already have code execution on the user's machine or physical access, unless they cross an isolation boundary Tempest claims to enforce (e.g. an agent escaping Hephaestus is in scope).
- Social engineering of users or maintainers.
- Findings from automated scanners without a demonstrated impact.

## Supported versions

Tempest is pre-1.0 and moves fast. We support the **latest released version** on the `main` branch. Security fixes are shipped in a new patch release; we do not backport to older minor versions.

| Version | Supported |
| ------- | --------- |
| 0.1.x (latest) | ✅ |
| < 0.1.12 | ❌ |

## Safe harbor

We consider security research conducted under this policy to be authorized. We will not pursue legal action against researchers who:

- Make a good-faith effort to avoid privacy violations, data destruction, and service disruption
- Report the issue promptly and give us a reasonable opportunity to fix it before public disclosure
- Do not exploit the issue beyond what is necessary to demonstrate it

If in doubt, ask first — email us and we'll work it out.

## Acknowledgements

Researchers who have responsibly disclosed issues will be listed here.
