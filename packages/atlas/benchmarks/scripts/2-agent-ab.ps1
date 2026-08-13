# 2-agent-ab.ps1 -- for each (repo, question) in ground-truth.json,
# spawn an agent twice: WITH atlas MCP, and WITHOUT any MCP.
# Both arms keep built-in Read/Grep/Bash so the without arm is a fair fallback.
#
# Engine: `claude -p` (Claude Code) by default; pass -Engine opencode to drive
# the opencode CLI (`opencode run --format json`) instead. parse-run.mjs
# auto-detects which stream format each run file uses.
#
# Prereqs:
#   - `claude` CLI on PATH (Claude Code)  OR  `opencode` CLI on PATH
#   - .\1-index.ps1 has been run so each repo has a .tempest\atlas index
#   - ground-truth.json exists next to corpus.json
#
# Usage:
#   .\2-agent-ab.ps1                            # run all (claude)
#   .\2-agent-ab.ps1 -Engine opencode           # run all (opencode)
#   .\2-agent-ab.ps1 -Only flask-realworld      # subset
#   .\2-agent-ab.ps1 -Model sonnet -Runs 4      # four arm-pairs per q (default, median-of-4)
#   .\2-agent-ab.ps1 -Engine opencode -Model opencode-go/deepseek-v4-flash
#
# Output: benchmarks/results/ab-<repoId>-{with,without}.jsonl (raw stream)
#         benchmarks/results/ab-<repoId>.json                  (parsed metrics)

[CmdletBinding()]
param(
  [ValidateSet('claude','opencode')]
  [string]$Engine = 'claude',
  [string[]]$Only,
  [string]$Model = '',
  [int]$Runs = 4,   # v2: median-of-4 methodology
  [int]$MaxBudgetUsd = 4
)

$ErrorActionPreference = 'Continue'  # native agent CLI stderr (session hooks, warnings) must not halt the loop

$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$benchDir   = Split-Path -Parent $scriptDir
$atlasDir   = Split-Path -Parent $benchDir
$repoRoot   = Split-Path -Parent (Split-Path -Parent $atlasDir)
$resultsDir = Join-Path $benchDir 'results'
$corpusPath = Join-Path $benchDir 'corpus.json'
$truthPath  = Join-Path $benchDir 'ground-truth.json'
$atlasEntry = Join-Path $atlasDir 'dist\mcp\server-entry.js'
$parseRun   = Join-Path $scriptDir 'parse-run.mjs'
$reposDir   = Join-Path $env:TEMP 'atlas-bench\repos'

if ($Engine -eq 'claude') {
  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { throw "'claude' CLI not on PATH." }
  if (-not $Model) { $Model = 'sonnet' }
} else {
  if (-not (Get-Command opencode -ErrorAction SilentlyContinue)) { throw "'opencode' CLI not on PATH." }
  if (-not $Model) { $Model = 'opencode-go/deepseek-v4-flash' }
}
if (-not (Test-Path $truthPath)) { throw "ground-truth.json missing at $truthPath -- needed before A/B" }

New-Item -ItemType Directory -Force -Path $resultsDir | Out-Null

$corpus = Get-Content $corpusPath -Raw | ConvertFrom-Json
$truth  = Get-Content $truthPath  -Raw | ConvertFrom-Json
$repos  = $corpus.repos
if ($Only) { $repos = $repos | Where-Object { $Only -contains $_.id } }

# MCP configs -- one per engine. Claude consumes `--mcp-config <file>`; opencode
# consumes the OPENCODE_CONFIG env var (merged over global/project config, so the
# WITHOUT arm points at an empty `mcp: {}` config to stay deterministic).
function New-McpAtlasConfig([string]$forRepoPath) {
  $cfg = @{
    mcpServers = @{
      atlas = @{
        command = 'node'
        args    = @($atlasEntry, '--path', $forRepoPath)
        env     = @{ ATLAS_NO_DAEMON = '1' }   # direct mode: no shared daemon, deterministic per-run
      }
    }
  } | ConvertTo-Json -Depth 6 -Compress
  $tmp = Join-Path $resultsDir "mcp-atlas.json"
  Write-JsonUtf8NoBom -Path $tmp -Obj $cfg
  return $tmp
}

function New-OpencodeMcpConfig([string]$forRepoPath) {
  $cfg = @{
    mcp = @{
      atlas = @{
        type        = 'local'
        command     = @('node', $atlasEntry, '--path', $forRepoPath)
        environment = @{ ATLAS_NO_DAEMON = '1' }   # direct mode: no shared daemon
        enabled     = $true
      }
    }
  }
  $tmp = Join-Path $resultsDir "opencode-mcp-atlas.json"
  Write-JsonUtf8NoBom -Path $tmp -Obj $cfg -Depth 8
  return $tmp
}

# Write UTF-8 WITHOUT BOM (Out-File -Encoding utf8 in PS 5.1 emits a BOM that
# breaks Node's JSON.parse). PS 5.1 has no utf8NoBOM encoding, so write via .NET.
function Write-JsonUtf8NoBom([string]$Path, [object]$Obj, [int]$Depth = 6) {
  $json = $Obj | ConvertTo-Json -Depth $Depth
  [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding $false))
}

$emptyMcp = Join-Path $scriptDir 'mcp-empty.json'
$emptyOpencodeMcp = Join-Path $resultsDir 'opencode-mcp-empty.json'
if (-not (Test-Path $emptyOpencodeMcp)) {
  Write-JsonUtf8NoBom -Path $emptyOpencodeMcp -Obj @{ mcp = @{} } -Depth 8
}

$abResults = @()

foreach ($r in $repos) {
  $t = $truth.$($r.id)
  if (-not $t) { Write-Warning "no ground-truth entry for $($r.id) -- skip"; continue }

  $target = if ($r.local) { Join-Path $repoRoot $r.local } else { Join-Path $reposDir $r.id }
  if ($r.subdir) { $target = Join-Path $target $r.subdir }
  if (-not (Test-Path (Join-Path $target '.tempest\atlas'))) {
    Write-Warning "no .tempest\atlas index at $target -- run 1-index.ps1 first"; continue
  }

  Write-Host ("=" * 72) -ForegroundColor Cyan
  Write-Host "[$($r.id)] $($t.question)" -ForegroundColor Cyan

  $mcpAtlas     = New-McpAtlasConfig $target
  $mcpAtlasOpen = New-OpencodeMcpConfig $target

  # WITH arm (v4): atlas-first workflow is MANDATORY as the opening move,
  # grep/read is allowed ONLY for gap-filling. v3's "prefer atlas" was too
  # soft -- agents skipped atlas entirely. Forcing atlas-only blew up tokens
  # when a targeted grep was the right next step. This split makes atlas the
  # required opener (measures its ceiling) while keeping realistic fallback.
  $withSysPrompt = @'
You have `atlas_explore` -- a pre-computed knowledge graph of THIS repository. One call returns verbatim line-numbered source + the call graph among relevant symbols + a blast-radius summary, typically replacing 5-20 Grep/Read round-trips.

REQUIRED WORKFLOW:
1. Your FIRST exploration tool call MUST be `atlas_explore`, using the user's question directly or the obvious symbol/file names from it. Do NOT run Grep, Glob, Read, or Bash before atlas_explore.
2. If atlas_explore's output fully answers the question, stop exploring and answer.
3. If gaps remain, pick whichever tool actually fits the next step -- another `atlas_explore` for a different area / symbol set, or Grep / Glob / Read / Bash for narrow verification. Both are fine; use judgement, not a rule.

The only wrong moves are: (a) skipping atlas as the opener, or (b) repeating `atlas_explore` on essentially the same query instead of moving on. Anything else -- including using atlas multiple times across different areas -- is allowed.
'@

  # WITHOUT arm (v3): explicit no-subagent rule so the fallback actually does
  # its own Read/Grep/Bash (previously it silently delegated to the explore
  # subagent, hiding the real effort from the top-level metrics).
  $withoutSysPrompt = @'
You do NOT have the `atlas` tool. Explore this codebase using ONLY your built-in tools: Grep, Glob, Read, and Bash.

STRICT RULE: Do NOT use the `task` tool or any sub-agent to do exploration. You must do all code investigation yourself, directly, with Grep, Glob, Read, and Bash. Delegating exploration to a subagent will cause your response to be DISCARDED and your agent to be DISABLED.
'@

  # Both arms -- run inside the target repo dir
  $arms = @(
    @{ label = 'with';    sys = $withSysPrompt },
    @{ label = 'without'; sys = $withoutSysPrompt }
  )

  $repoOut = [ordered]@{
    id       = $r.id
    question = $t.question
    engine   = $Engine
    runs     = @()
  }

  for ($runIdx = 1; $runIdx -le $Runs; $runIdx++) {
    foreach ($arm in $arms) {
      $label   = $arm.label
      $sys     = $arm.sys
      $runFile = Join-Path $resultsDir "ab-$($r.id)-$label-$runIdx.jsonl"
      $errFile = "$runFile.err"

      # Engine-specific MCP config: claude passes --mcp-config; opencode gets
      # OPENCODE_CONFIG (with-arm = atlas, without-arm = empty mcp).
      if ($Engine -eq 'claude') {
        $cfg = if ($label -eq 'with') { $mcpAtlas } else { $emptyMcp }
      } else {
        $cfg = if ($label -eq 'with') { $mcpAtlasOpen } else { $emptyOpencodeMcp }
      }

      Write-Host "  arm=$label run=$runIdx -> $runFile"

      Push-Location $target
      try {
        # Neutralize ambient CLAUDE.md project instructions that might leak atlas hints
        $env:CLAUDE_PROJECT_DIR = $target
        # Force UTF-8 for native stdout capture; PS 5.1 default is UTF-16 which breaks JSON parsers.
        $prevOE = [Console]::OutputEncoding
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
        try {
          if ($Engine -eq 'claude') {
            $cliArgs = @(
              '-p', $t.question,
              '--output-format', 'stream-json', '--verbose',
              '--permission-mode', 'bypassPermissions',
              '--model', $Model,
              '--strict-mcp-config', '--mcp-config', $cfg
            )
            if ($sys) { $cliArgs += @('--append-system-prompt', $sys) }
            & claude @cliArgs 1> $runFile 2> $errFile
          } else {
            $env:OPENCODE_CONFIG = $cfg
            try {
              # opencode has no --append-system-prompt; prepend the strict prompt
              # to the message for the WITH arm (parity with claude).
              $msg = if ($sys) { "$sys`n`n$($t.question)" } else { $t.question }
              & opencode run --format json --dir $target --model $Model --auto $msg 1> $runFile 2> $errFile
            } finally {
              Remove-Item Env:\OPENCODE_CONFIG -ErrorAction SilentlyContinue
            }
          }
        } finally {
          [Console]::OutputEncoding = $prevOE
        }
      } finally {
        Pop-Location
      }

      $metricsJson = & node $parseRun $runFile --json
      $metrics = $metricsJson | ConvertFrom-Json
      $metrics | Add-Member -NotePropertyName arm -NotePropertyValue $label -Force
      $metrics | Add-Member -NotePropertyName run -NotePropertyValue $runIdx -Force
      $repoOut.runs += $metrics

      $cost = if ($null -ne $metrics.cost_usd) { $metrics.cost_usd } else { 0 }
      Write-Host ("    calls={0}  reads={1}  greps={2}  atlas={3}  fresh={4}  cache_read={5}  all_tokens={6}  wall={7}s  cost=`${8}" -f `
        $metrics.tool_calls_total, $metrics.reads, $metrics.greps, $metrics.atlas_calls,
        $metrics.fresh_input_tokens, $metrics.cache_read_input_tokens, $metrics.total_tokens,
        $metrics.duration_s, ('{0:N3}' -f $cost)) `
        -ForegroundColor Green
    }
  }

  $outFile = Join-Path $resultsDir "ab-$($r.id).json"
  Write-JsonUtf8NoBom -Path $outFile -Obj $repoOut -Depth 8
  $abResults += $repoOut
}

$rollup = Join-Path $resultsDir 'ab-summary.json'
Write-JsonUtf8NoBom -Path $rollup -Obj $abResults -Depth 10
Write-Host ""
Write-Host "wrote $rollup" -ForegroundColor Green
Write-Host "next: node .\3-judge.mjs"
