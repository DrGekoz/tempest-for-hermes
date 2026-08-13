# 1-index.ps1 -- clone corpus repos to a temp dir, run `atlas init` per repo,
# emit indexing metrics into ../results/index-<repo>.json.
#
# Reproducible: pass -Fresh to nuke the temp dir first (cold index).
# Clean-up: pass -Clean to just delete the temp dir and exit.
#
# Prereqs: node 20+, git on PATH, atlas built (packages/atlas/dist/mcp/server-entry.js).
#
# Usage examples:
#   .\1-index.ps1                       # index each corpus repo (skip if already indexed)
#   .\1-index.ps1 -Fresh                # wipe temp dir first, cold index everything
#   .\1-index.ps1 -Only wagtail,immich  # subset
#   .\1-index.ps1 -Clean                # rm -rf the whole temp dir and exit

[CmdletBinding()]
param(
  [switch]$Fresh,
  [switch]$Clean,
  [string[]]$Only
)

$ErrorActionPreference = 'Continue'  # native git stderr must not halt the loop

# --- paths ---------------------------------------------------------------
$scriptDir    = Split-Path -Parent $MyInvocation.MyCommand.Path
$benchDir     = Split-Path -Parent $scriptDir          # packages/atlas/benchmarks
$atlasDir     = Split-Path -Parent $benchDir           # packages/atlas
$repoRoot     = Split-Path -Parent (Split-Path -Parent $atlasDir)  # tempest-git
$resultsDir   = Join-Path $benchDir 'results'
$corpusPath   = Join-Path $benchDir 'corpus.json'
$tempRoot     = Join-Path $env:TEMP 'atlas-bench'
$reposDir     = Join-Path $tempRoot 'repos'
$atlasEntry   = Join-Path $atlasDir 'dist\mcp\server-entry.js'

if (-not (Test-Path $atlasEntry)) {
  throw "atlas is not built: $atlasEntry missing. Run: cd packages/atlas && npm run build"
}

# Write UTF-8 WITHOUT BOM (Out-File -Encoding utf8 in PS 5.1 emits a BOM that
# breaks Node's JSON.parse). PS 5.1 has no utf8NoBOM encoding, so write via .NET.
function Write-JsonUtf8NoBom([string]$Path, [object]$Obj, [int]$Depth = 6) {
  $json = $Obj | ConvertTo-Json -Depth $Depth
  [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding $false))
}

if ($Clean) {
  if (Test-Path $tempRoot) {
    Write-Host "Removing $tempRoot ..." -ForegroundColor Yellow
    Remove-Item $tempRoot -Recurse -Force
  }
  Write-Host 'clean done.' -ForegroundColor Green
  return
}

if ($Fresh -and (Test-Path $tempRoot)) {
  Write-Host "Fresh run -- wiping $tempRoot" -ForegroundColor Yellow
  Remove-Item $tempRoot -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $reposDir     | Out-Null
New-Item -ItemType Directory -Force -Path $resultsDir   | Out-Null

# --- corpus --------------------------------------------------------------
$corpus = Get-Content $corpusPath -Raw | ConvertFrom-Json
$repos  = $corpus.repos
if ($Only) { $repos = $repos | Where-Object { $Only -contains $_.id } }

Write-Host ""
Write-Host "Atlas indexing benchmark"
Write-Host "  temp:    $tempRoot"
Write-Host "  results: $resultsDir"
Write-Host "  repos:   $($repos.Count)"
Write-Host ""

$summary = @()

foreach ($r in $repos) {
  Write-Host ("=" * 72) -ForegroundColor Cyan
  Write-Host "[$($r.id)] $($r.lang) / $($r.framework) / size=$($r.size)" -ForegroundColor Cyan

  # --- resolve target path (clone or use local) ---
  if ($r.local) {
    $target = Join-Path $repoRoot $r.local
    Write-Host "  local:  $target"
  } else {
    $target = Join-Path $reposDir $r.id
    $gitLog = Join-Path $resultsDir "git-$($r.id).log"
    if (-not (Test-Path (Join-Path $target '.git'))) {
      Write-Host "  clone:  $($r.url)"
      $cloneT0 = Get-Date
      # PS 5.1: never pipe native stderr through PS. Redirect to file with `2>`.
      & git clone --quiet --filter=blob:none $r.url $target *>>$gitLog
      if ($LASTEXITCODE -ne 0) { Write-Warning "  git clone failed (see $gitLog), skipping"; continue }
      $cloneS = ((Get-Date) - $cloneT0).TotalSeconds
      Write-Host ("  cloned in {0:N1}s" -f $cloneS)
    }
    if ($r.sha) {
      Write-Host "  checkout: $($r.sha)"
      & git -C $target fetch --quiet origin $r.sha *>>$gitLog
      & git -C $target -c advice.detachedHead=false checkout --quiet $r.sha *>>$gitLog
      if ($LASTEXITCODE -ne 0) {
        & git -C $target -c advice.detachedHead=false checkout --quiet "refs/tags/$($r.sha)" *>>$gitLog
        if ($LASTEXITCODE -ne 0) {
          & git -C $target -c advice.detachedHead=false checkout --quiet "origin/$($r.sha)" *>>$gitLog
          if ($LASTEXITCODE -ne 0) { Write-Warning "  checkout failed for $($r.sha) (see $gitLog), continuing at HEAD"; }
        }
      }
    } else {
      Write-Host "  checkout: (using HEAD of default branch)"
    }
    # Always resolve current HEAD so the result file records the actual sha we indexed
    $resolvedSha = (& git -C $target rev-parse HEAD 2>$null).Trim()
  }
  if (-not $resolvedSha) { $resolvedSha = 'local' }

  # Optional subdirectory (e.g. immich/server)
  $indexPath = $target
  if ($r.subdir) {
    $indexPath = Join-Path $target $r.subdir
    if (-not (Test-Path $indexPath)) { Write-Warning "  subdir missing: $indexPath"; continue }
  }

  # --- cold vs warm: if .atlas exists we treat this run as WARM ---
  $atlasStateDir = Join-Path $indexPath '.tempest\atlas'
  $wasCold = -not (Test-Path $atlasStateDir)
  if ($wasCold) {
    Write-Host "  cold index (no .tempest/atlas present)"
  } else {
    Write-Host "  warm re-index (.tempest/atlas exists -- measuring incremental)"
  }

  # --- run atlas --init and time it ---
  $t0 = Get-Date
  $rssPeakMB = 0
  # Spawn atlas, poll RSS while it runs
  $proc = Start-Process -FilePath 'node' `
    -ArgumentList @($atlasEntry, '--init', '--path', $indexPath) `
    -NoNewWindow -PassThru -RedirectStandardOutput (Join-Path $resultsDir "index-$($r.id).stdout.log") `
    -RedirectStandardError  (Join-Path $resultsDir "index-$($r.id).stderr.log")
  while (-not $proc.HasExited) {
    try {
      $proc.Refresh()
      $ws = [math]::Round($proc.WorkingSet64 / 1MB, 1)
      if ($ws -gt $rssPeakMB) { $rssPeakMB = $ws }
    } catch {}
    Start-Sleep -Milliseconds 250
  }
  $wallS = ((Get-Date) - $t0).TotalSeconds
  $exit  = $proc.ExitCode

  # --- measure post-index state ---
  $dbPath = Join-Path $atlasStateDir 'atlas.db'
  $dbBytes = if (Test-Path $dbPath) { (Get-Item $dbPath).Length } else { 0 }

  # count source files (approx -- same filter atlas uses in spirit: exclude node_modules, .git)
  $files = 0
  $bytes = 0
  Get-ChildItem $indexPath -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object {
      $_.FullName -notmatch '\\(node_modules|\.git|\.atlas|\.tempest|dist|build|target|__pycache__)\\' -and
      $_.Extension -match '^\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|rb|php|cpp|c|h|hpp|cs|scala|lua|dart|sh|ps1)$'
    } |
    ForEach-Object { $files++; $bytes += $_.Length }

  $mb = [math]::Round($bytes / 1MB, 2)
  $filesPerSec = if ($wallS -gt 0) { [math]::Round($files / $wallS, 1) } else { 0 }
  $mbPerSec    = if ($wallS -gt 0) { [math]::Round($mb / $wallS, 2) }    else { 0 }
  $dbMB        = [math]::Round($dbBytes / 1MB, 2)

  $rec = [PSCustomObject]@{
    id             = $r.id
    lang           = $r.lang
    framework      = $r.framework
    size           = $r.size
    sha            = $r.sha
    resolved_sha   = $resolvedSha
    path           = $indexPath
    cold           = $wasCold
    exit           = $exit
    files          = $files
    source_mb      = $mb
    duration_s     = [math]::Round($wallS, 1)
    files_per_sec  = $filesPerSec
    mb_per_sec     = $mbPerSec
    peak_rss_mb    = $rssPeakMB
    db_mb          = $dbMB
    timestamp      = (Get-Date -Format 'o')
  }

  $outFile = Join-Path $resultsDir "index-$($r.id).json"
  Write-JsonUtf8NoBom -Path $outFile -Obj $rec
  Write-Host ("  files={0}  mb={1}  wall={2}s  f/s={3}  db={4}MB  rss={5}MB  exit={6}" -f `
    $files, $mb, [math]::Round($wallS,1), $filesPerSec, $dbMB, $rssPeakMB, $exit) `
    -ForegroundColor Green

  $summary += $rec
}

# Roll-up
$rollup = Join-Path $resultsDir 'index-summary.json'
Write-JsonUtf8NoBom -Path $rollup -Obj $summary
Write-Host ""
Write-Host "wrote $rollup" -ForegroundColor Green
Write-Host "next: run .\2-agent-ab.ps1 (needs ground-truth.json)"
