# Atlas benchmarks

Reproducible A/B benchmark of Atlas — indexing throughput and agent-flow retrieval — driven by a headless agent CLI (Claude Code by default, opencode optional; no API keys needed).

## What this measures

1. **Indexing throughput** — cold-cache `atlas init` on real-world repos across 3 languages and 3 sizes. Reports files/s, MB/s, wall time, peak RSS, on-disk DB size.
2. **Agent A/B** — an agent (default `claude -p`, or `opencode run` with `-Engine opencode`) answers one canonical flow question per repo, twice: **with** atlas MCP wired in and **without** any MCP. Same engine, same model, same prompt, atlas is the only variable. Reports tool-call counts, token totals, wall time, and answer recall against a hand-labeled key-symbol list.

## Why headless agent CLIs (and not the API)

We can drive both arms of the A/B with the user's own agent subscription — no API key required. Claude's stream-json (and opencode's `--format json`) output gives us tool calls, token usage, cost, and wall time in one file per run.

## Layout

```
benchmarks/
├── corpus.json           # pinned repo list (SHAs)
├── ground-truth.json     # {repo: {question, truth, anchors[]}}
├── README.md             # you are here
├── scripts/
│   ├── 1-index.ps1       # clone + `atlas init` + measure
│   ├── 2-agent-ab.ps1    # agent CLI × 2 arms per question (claude | opencode)
│   ├── 3-judge.mjs       # score answers by anchor recall
│   ├── parse-run.mjs     # stream-json → structured metrics
│   ├── mcp-empty.json
│   └── (mcp-atlas.json is generated per run)
└── results/              # gitignored — raw JSONL + per-run JSON
```

## Prereqs

- Node 20+, git on PATH, and one agent CLI on PATH:
  - `claude` (Claude Code, logged in) — the default engine
  - or `opencode` (pass `-Engine opencode`)
- `packages/atlas` built once: `cd packages/atlas && npm run build`
- Windows PowerShell (scripts .ps1) — Node parts run anywhere

## Run it end-to-end

```powershell
cd packages/atlas/benchmarks/scripts

# 1) Index every corpus repo into a temp dir ($env:TEMP\atlas-bench\repos)
.\1-index.ps1                          # or -Fresh to nuke temp first
                                       # or -Only flask-realworld,wagtail

# 2) (One-time) fill in ground-truth.json anchors — see below

# 3) Run the A/B — needs claude on PATH (or opencode with -Engine opencode)
.\2-agent-ab.ps1                       # one run per arm per q by default (claude)
.\2-agent-ab.ps1 -Engine opencode -Model opencode-go/deepseek-v4-flash

# 4) Score answers (raw metrics land in results/judged-summary.json)
node .\3-judge.mjs

# When done — reclaim disk
.\1-index.ps1 -Clean
```

## Ground-truth authoring (the one manual step)

Anchors are the short strings a correct answer must contain (file names, class names, function names). Written after inspecting each repo. Example:

```json
{
  "wagtail": {
    "question": "How does Wagtail render a Page when a visitor hits its URL? ...",
    "truth": "Verified path: URL dispatch → Site.find_for_request → RoutablePageMixin → Page.route → Page.serve → get_context → render_to_response ...",
    "anchors": [
      "Page.route",
      "Page.serve",
      "TemplateResponse",
      "wagtail.core.urls",
      "get_context"
    ]
  }
}
```

Judging is deterministic string-anchor match (case-insensitive, punctuation-stripped). No LLM judge — no API key needed, no run-to-run judge noise.

## Reproducibility guarantees

- Corpus repos pinned to specific SHAs / tags (see `corpus.json`)
- All raw run logs (stream-json) kept in `results/` per run; feel free to inspect
- Machine spec + timestamp emitted into each result file
- `.gitignore`'d: cloned corpora (temp dir) and raw JSONL. Aggregated JSON summaries can be committed as receipts.

## Cost / time

Rough per full run (6 repos × 2 arms × 1 run = 12 headless agent calls, `sonnet` model): ~10 minutes wall, a few dollars from your agent subscription. Indexing pass adds ~5-15 minutes depending on clone speed.
