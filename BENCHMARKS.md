# Atlas Benchmarks

Reproducible A/B benchmark of [Atlas](packages/atlas) — indexing throughput and agent-flow token efficiency — driven by the [opencode](https://opencode.ai) CLI running the `opencode-go/deepseek-v4-flash` model.

> **Status:** v4 prompt methodology run landed (2026-08-13). Numbers below are hand-curated from the raw JSONL run logs under `packages/atlas/benchmarks/results/`.

## Methodology (in brief)

Atlas is a semantic code intelligence layer (SQLite knowledge graph + tree-sitter extraction + optional embeddings). Two claims we want to measure honestly:

1. **Indexing is cheap enough to be a default.** Files/sec and MB/sec on real repos, cold cache.
2. **An agent with atlas is more token-efficient — fewer tokens, fewer tool calls, less wall time, lower cost — than the same agent without atlas.**

Our vision: **token efficiency is the norm.** The `with` arm should not just answer correctly; it should do so with materially less context churn, because one `atlas_explore` call returns verbatim source + call graph + blast radius that would otherwise take a long grep → read loop.

To measure (2) we run [`opencode run --format json`](https://opencode.ai) per question, twice per arm. The **only** variable between arms is the MCP config: one arm wires in the atlas MCP server, the other gets an empty MCP config. Both arms keep the built-in `Read`, `Grep`, `Glob`, `Bash` and `Task` tools, so the "without" arm has a real fallback path.

**Arm prompts (v4):**
- **with** — `atlas_explore` is the *mandatory first exploration call*; Grep/Read/Bash are allowed afterward only for gap-filling. This measures atlas's ceiling while keeping a realistic fallback.
- **without** — explicitly forbidden from delegating to a `task`/sub-agent, so it must do its own Read/Grep/Bash (no hidden sub-agent effort).

The harness is a small PowerShell + Node pipeline (index → run A/B → judge) — see `packages/atlas/benchmarks/scripts/`.

## Corpus

| Repo | Lang | Framework | Size |
|---|---|---|---|
| `microsoft/vscode` | TypeScript | Electron | XL |
| `excalidraw/excalidraw` | TypeScript | React | M |
| `django/django` | Python | Django | L |
| `tokio-rs/tokio` | Rust | Async runtime | L |
| `square/okhttp` | Kotlin+Java | HTTP client | M |
| `gin-gonic/gin` | Go | HTTP router | S |
| `Alamofire/Alamofire` | Swift | HTTP client | M |

Full URLs and SHAs in [`packages/atlas/benchmarks/corpus.json`](packages/atlas/benchmarks/corpus.json). One canonical architecture question per repo — the full list lives in [`ground-truth.json`](packages/atlas/benchmarks/ground-truth.json).

Repos are cloned to `$env:TEMP\atlas-bench\repos` — a temp directory that `1-index.ps1 -Clean` reclaims when you're done.

## Reproduce

```powershell
# 0) One-time: build atlas
cd packages/atlas && npm run build

# 1) Clone the corpus and time atlas init on each
cd benchmarks/scripts
.\1-index.ps1                     # add -Fresh for a truly cold run
                                  # add -Only <id,id> to subset

# 2) Run the two agent arms per question (opencode engine)
.\2-agent-ab.ps1 -Engine opencode -Model opencode-go/deepseek-v4-flash

# 3) Score answers (raw metrics land in results/judged-summary.json)
node .\3-judge.mjs

# 4) Reclaim disk (deletes the temp repo dir; keeps results/)
.\1-index.ps1 -Clean
```

See [`packages/atlas/benchmarks/README.md`](packages/atlas/benchmarks/README.md) for the full authoring guide (ground-truth format, environment neutralization, cost estimate).

## Machine

- Intel Core i7-9750H @ 2.60 GHz, 7.9 GB RAM
- Windows 11 Home (10.0.26200)
- Node v24.11.0
- opencode 1.18.18, model `opencode-go/deepseek-v4-flash`
- Atlas: `packages/atlas/dist/mcp/server-entry.js` (direct MCP mode, `ATLAS_NO_DAEMON=1`)

## Interpretation notes

- **Token efficiency is the win — and it is consistent.** Across all 7 repos the atlas arm cut all-tokens by **60–86%**, tool calls by **63–92%**, and reads/greps almost entirely (the graph lookup replaces the grep → read loop). Cost fell 40–71% in 6 of 7 repos (vscode tied).
- **Best case — django, okhttp, tokio:** atlas used just 2–3 `atlas_explore` calls per run at 80–86% fewer tokens and 57–71% lower cost.
- **One `atlas_explore` replaces the grep → read loop.** Median reads dropped from 8–21 to 0–2; median greps from 2–10 to 0.

_Numbers below are per-repo medians over 4 valid runs per arm, taken from `results/judged-summary.json` on 2026-08-13._

## Headline

**Across 7 repos with valid paired arms (28 valid with-atlas runs, 28 valid without-atlas runs), atlas cut file reads by 95%, greps by 100%, fresh input tokens by 43%, billable tokens by 45%, all tokens by 76%, and wall time by 50%.**

## Indexing throughput

Cold-cache index of each corpus repo from a clean `.atlas/` (or warm re-index if noted). One process, Windows 11, Node 24.

| Repo | Lang / Framework | Size | Files | Source MB | Wall s | Files/s | MB/s | DB MB | Peak RSS MB | Cold? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `vscode` | TypeScript / Electron | XL | 12693 | 148.68 | 2.3 | 5590.2 | 65.48 | 371.33 | 61.2 | warm |
| `excalidraw` | TypeScript / React | M | 664 | 7.31 | 0.8 | 811.2 | 8.93 | 38.43 | 60.7 | warm |
| `django` | Python / Django | L | 3041 | 20.26 | 1.0 | 3027.4 | 20.17 | 130.77 | 60.8 | warm |
| `tokio` | Rust / Async runtime | L | 793 | 5.59 | 1.6 | 483.5 | 3.41 | 31.68 | 60.9 | warm |
| `okhttp` | Kotlin+Java / HTTP client | M | 646 | 4.36 | 1.6 | 405.1 | 2.73 | 51.05 | 60.8 | warm |
| `gin` | Go / HTTP router | S | 99 | 0.68 | 1.6 | 63.0 | 0.43 | 6.36 | 60.7 | warm |
| `alamofire` | Swift / HTTP client | M | 108 | 2.14 | 1.1 | 99.0 | 1.96 | 12.79 | 61.0 | warm |

## Agent A/B - with atlas MCP vs without any MCP

Same `opencode` CLI, same model, same prompt. The **only** variable is whether the atlas MCP server is wired in (atlas config vs empty MCP config). Both arms keep built-in Read / Grep / Bash / Task so the without-arm has a real fallback. The with-arm is prompted atlas-first (v4); the without-arm is forbidden from delegating to a sub-agent. Numbers below are per-repo medians over valid runs only; infrastructure/rate/session-limit failures are excluded from comparisons and listed in the final column.

_Format:_ `with / without` in each cell. **All tokens** includes cache reads for context-volume inspection; **Fresh input** excludes cache reads.

| Repo | Valid runs w/wo | Reads w/wo | Greps w/wo | Atlas calls w/wo | Total calls w/wo | Fresh input w/wo | Cache read w/wo | Billable tokens w/wo | All tokens w/wo | Wall w/wo | Cost w/wo | Invalid runs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `alamofire` | 4 / 4 | 0 / 12.5 | 0 / 5.5 | 4.5 / 0 | 5.5 / 17.5 | 34585 / 49816 | 145984 / 433600 | 36020.5 / 52626 | 183644 / 492695.5 | 37s / 59s | $0.003 / $0.005 |  |
| `django` | 4 / 4 | 0 / 15.5 | 0 / 6.5 | 2 / 0 | 2 / 24.5 | 21301 / 38074 | 55744 / 374528 | 22201.5 / 41673 | 77945.5 / 416201 | 22s / 79s | $0.002 / $0.004 |  |
| `excalidraw` | 4 / 4 | 1 / 21 | 0 / 4.5 | 4 / 0 | 5.5 / 33.5 | 37133.5 / 74765.5 | 172992 / 1096768 | 38168.5 / 79281 | 209863.5 / 1190781.5 | 34s / 107s | $0.003 / $0.008 |  |
| `gin` | 4 / 4 | 0.5 / 4.5 | 0 / 2 | 2 / 0 | 2.5 / 8.5 | 22673.5 / 39143 | 57216 / 205248 | 23312 / 40676.5 | 83599 / 243109.5 | 14s / 30s | $0.002 / $0.003 |  |
| `okhttp` | 4 / 4 | 0 / 8.5 | 0 / 3.5 | 2 / 0 | 2 / 21.5 | 20118.5 / 45510 | 44416 / 368448 | 20928 / 48529.5 | 72842 / 416977.5 | 14s / 62s | $0.002 / $0.004 |  |
| `tokio` | 4 / 4 | 1 / 19 | 0 / 3 | 2.5 / 0 | 3.5 / 26 | 29729 / 90286.5 | 87232 / 926400 | 30839 / 93842.5 | 119398 / 1023165.5 | 30s / 92s | $0.003 / $0.009 |  |
| `vscode` | 4 / 4 | 2 / 12.5 | 0 / 10 | 3.5 / 0 | 9 / 24.5 | 48447 / 39978.5 | 256960 / 620864 | 49878.5 / 42929.5 | 306838.5 / 675589.5 | 148s / 170s | $0.004 / $0.004 |  |

## Appendix — per-question call traces

Every raw run log (`ab-<repo>-{with,without}-<run>.jsonl`) is preserved under `packages/atlas/benchmarks/results/` for anyone who wants to audit the exact tool sequence. These files are gitignored by default — commit aggregated summaries only.
