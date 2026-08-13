#!/usr/bin/env node
// Parse an agent run log into structured metrics.
// Auto-detects the format:
//   - Claude Code stream-json     (--output-format stream-json)
//   - opencode run --format json  (NDJSON of step_start / tool_use / text / step_finish / error)
//
// Usage: node parse-run.mjs <path/to/run.jsonl> [--json]
//   default: prints a human summary
//   --json:  prints the metrics object as one JSON line (used by 2-agent-ab.ps1)

import { readFileSync } from 'node:fs';

const file = process.argv[2];
const asJson = process.argv.includes('--json');
if (!file) { console.error('usage: parse-run.mjs <run.jsonl> [--json]'); process.exit(2); }

// PowerShell 5.1 native-redirect files are not always UTF-8: it emits a UTF-8
// BOM for some processes and UTF-16LE for others. Sniff the BOM and decode with
// TextDecoder, which also strips the leading BOM for the matched encoding.
function readText(p) {
  const buf = readFileSync(p);
  if (buf[0] === 0xFF && buf[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf);
  if (buf[0] === 0xFE && buf[1] === 0xFF) { // utf-16be (rare on Windows)
    const swapped = Buffer.alloc(buf.length);
    for (let i = 0; i + 1 < buf.length; i += 2) { swapped[i] = buf[i + 1]; swapped[i + 1] = buf[i]; }
    return new TextDecoder('utf-16le').decode(swapped);
  }
  return new TextDecoder('utf-8').decode(buf);
}

const lines = readText(file).split('\n').filter(Boolean);

const OPENCODE_TYPES = new Set(['step_start', 'step_finish', 'tool_use', 'text', 'error', 'attachment', 'part_updated', 'abort', 'snapshot']);

function detectFormat() {
  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev && typeof ev.type === 'string') return OPENCODE_TYPES.has(ev.type) ? 'opencode' : 'claude';
  }
  return 'claude';
}

function firstLine(s) {
  return String(s || '').split(/\r?\n/).find((line) => line.trim())?.trim() || '';
}

function classify(failureText) {
  if (/session limit|hit your session limit/i.test(failureText)) {
    return {
      valid: false,
      failure_kind: 'session_limit',
      failure_reason: firstLine(failureText) || 'Agent session limit reached',
    };
  }
  if (/rate limit|rate_limit|too many requests|quota exceeded|usage limit/i.test(failureText)) {
    return {
      valid: false,
      failure_kind: 'rate_limit',
      failure_reason: firstLine(failureText) || 'Rate limit reached',
    };
  }
  return { valid: true, failure_kind: null, failure_reason: null };
}

// --- Claude Code stream-json ------------------------------------------------
function parseClaude() {
  const toolCalls = [];
  const atlasCalls = [];
  let result = null;
  let initTools = null;
  let mcpServers = [];
  let finalText = '';

  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }

    if (ev.type === 'system' && ev.subtype === 'init') {
      initTools = (ev.tools || []).filter((t) => /^(mcp__)?atlas/i.test(t));
      mcpServers = ev.mcp_servers || [];
    }

    if (ev.type === 'assistant' && ev.message?.content) {
      for (const block of ev.message.content) {
        if (block.type === 'tool_use') {
          const name = block.name;
          let detail = '';
          if (name === 'Task') {
            detail = ` [subagent_type=${block.input?.subagent_type ?? '?'}] ${(block.input?.description ?? '').slice(0, 40)}`;
          } else if (/atlas/i.test(name)) {
            const q = block.input?.query ?? block.input?.question ?? block.input?.task ?? block.input?.symbol ?? '';
            detail = ` ${JSON.stringify(q).slice(0, 80)}`;
            atlasCalls.push(name);
          } else if (name === 'Bash') {
            detail = ` ${(block.input?.command ?? '').slice(0, 60)}`;
          } else if (name === 'Read') {
            detail = ` ${(block.input?.file_path ?? '').split(/[\\/]/).pop()}`;
          } else if (name === 'Grep') {
            detail = ` ${block.input?.pattern ?? ''}`.slice(0, 60);
          }
          toolCalls.push(`${name}${detail}`);
        } else if (block.type === 'text' && typeof block.text === 'string') {
          finalText = block.text; // keep the last one seen
        }
      }
    }

    if (ev.type === 'result') result = ev;
  }

  const counts = {};
  for (const tc of toolCalls) {
    const n = tc.split(' ')[0];
    counts[n] = (counts[n] || 0) + 1;
  }

  const u = result?.usage || {};
  const freshInputTokens = u.input_tokens || 0;
  const cacheReadInputTokens = u.cache_read_input_tokens || 0;
  const cacheCreationInputTokens = u.cache_creation_input_tokens || 0;
  const outTokens = u.output_tokens || 0;
  const totalTokens = freshInputTokens + cacheReadInputTokens + cacheCreationInputTokens + outTokens;

  const failureText = `${finalText}\n${result?.error ?? ''}\n${result?.message ?? ''}`;
  const atlasServer = mcpServers.find((s) => s?.name === 'atlas');
  let failure;
  if (atlasServer?.status === 'failed') {
    failure = {
      valid: false,
      failure_kind: 'infrastructure_failure',
      failure_reason: 'Atlas MCP failed to connect during init',
    };
  } else {
    failure = classify(failureText);
  }

  return {
    atlas_tools_exposed: initTools ? initTools.length : 0,
    mcp_servers: mcpServers,
    atlas_calls: atlasCalls.length,
    atlas_call_names: atlasCalls,
    tool_calls_total: toolCalls.length,
    tool_calls_by_kind: counts,
    counts,
    reads: counts.Read || 0,
    greps: counts.Grep || 0,
    globs: counts.Glob || 0,
    bash: counts.Bash || 0,
    tasks: counts.Task || 0,
    duration_ms: result?.duration_ms ?? null,
    duration_s: result?.duration_ms != null ? +(result.duration_ms / 1000).toFixed(1) : null,
    num_turns: result?.num_turns ?? null,
    input_tokens: freshInputTokens,
    fresh_input_tokens: freshInputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
    cache_creation_input_tokens: cacheCreationInputTokens,
    output_tokens: outTokens,
    total_tokens: totalTokens,
    total_billable_tokens: freshInputTokens + cacheCreationInputTokens + outTokens,
    cost_usd: result?.total_cost_usd ?? null,
    result_subtype: result?.subtype ?? null,
    failure_kind: failure.failure_kind,
    failure_reason: failure.failure_reason,
    valid_run: failure.valid,
    final_text: finalText,
    final_text_len: finalText.length,
  };
}

// --- opencode run --format json ---------------------------------------------
function parseOpencode() {
  const toolCalls = [];
  const atlasCalls = [];
  const atlasToolNames = new Set();
  const errors = [];
  let finalText = '';
  let firstTs = null;
  let lastTs = null;
  let numTurns = 0;
  const tok = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  let costUsd = 0;

  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev) continue;
    if (ev.timestamp != null) { if (firstTs == null) firstTs = ev.timestamp; lastTs = ev.timestamp; }

    const p = ev.part;
    if (!p) continue;

    if (ev.type === 'step_start') numTurns++;

    if (ev.type === 'tool_use' && p.type === 'tool') {
      const name = p.tool;
      const input = p.state?.input || {};
      let detail = '';
      if (/^atlas/i.test(name)) {
        const q = input.query ?? input.question ?? input.task ?? input.symbol ?? '';
        detail = ` ${JSON.stringify(q).slice(0, 80)}`;
        atlasCalls.push(name);
        atlasToolNames.add(name);
      } else if (name === 'bash') {
        detail = ` ${(input.command ?? '').slice(0, 60)}`;
      } else if (name === 'read') {
        detail = ` ${(input.filePath ?? input.file_path ?? '').split(/[\\/]/).pop()}`;
      } else if (name === 'grep') {
        detail = ` ${input.pattern ?? ''}`.slice(0, 60);
      }
      toolCalls.push(`${name}${detail}`);
    }

    if (ev.type === 'text' && p.type === 'text' && typeof p.text === 'string') {
      finalText = p.text; // keep the last one seen
    }

    if (ev.type === 'step_finish' && p.tokens) {
      tok.input += p.tokens.input || 0;
      tok.output += p.tokens.output || 0;
      tok.reasoning += p.tokens.reasoning || 0;
      tok.cacheRead += p.tokens.cache?.read || 0;
      tok.cacheWrite += p.tokens.cache?.write || 0;
      if (typeof p.cost === 'number') costUsd += p.cost;
    }

    if (ev.type === 'error') {
      errors.push(ev.error?.data?.message || ev.error?.message || ev.error?.name || JSON.stringify(ev.error || ''));
    }
  }

  const counts = {};
  for (const tc of toolCalls) {
    const n = tc.split(' ')[0];
    counts[n] = (counts[n] || 0) + 1;
  }

  const freshInputTokens = tok.input;
  const cacheReadInputTokens = tok.cacheRead;
  const cacheCreationInputTokens = tok.cacheWrite;
  const outTokens = tok.output;
  const totalTokens = freshInputTokens + cacheReadInputTokens + cacheCreationInputTokens + outTokens;
  const errorText = errors.join('\n');
  const durationMs = firstTs != null && lastTs != null ? lastTs - firstTs : null;

  let failure;
  if (errorText && /atlas|mcp/i.test(errorText)) {
    failure = {
      valid: false,
      failure_kind: 'infrastructure_failure',
      failure_reason: firstLine(errorText) || 'Atlas MCP failed',
    };
  } else {
    failure = classify(`${finalText}\n${errorText}`);
  }

  return {
    atlas_tools_exposed: atlasToolNames.size,
    mcp_servers: [],
    atlas_calls: atlasCalls.length,
    atlas_call_names: atlasCalls,
    tool_calls_total: toolCalls.length,
    tool_calls_by_kind: counts,
    counts,
    reads: counts.read || 0,
    greps: counts.grep || 0,
    globs: counts.glob || 0,
    bash: counts.bash || 0,
    tasks: counts.task || 0,
    duration_ms: durationMs,
    duration_s: durationMs != null ? +(durationMs / 1000).toFixed(1) : null,
    num_turns: numTurns,
    input_tokens: freshInputTokens,
    fresh_input_tokens: freshInputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
    cache_creation_input_tokens: cacheCreationInputTokens,
    output_tokens: outTokens,
    total_tokens: totalTokens,
    total_billable_tokens: freshInputTokens + cacheCreationInputTokens + outTokens,
    cost_usd: costUsd || null,
    result_subtype: errors.length ? 'error' : 'completed',
    failure_kind: failure.failure_kind,
    failure_reason: failure.failure_reason,
    valid_run: failure.valid,
    final_text: finalText,
    final_text_len: finalText.length,
  };
}

// --- main -------------------------------------------------------------------
const metrics = detectFormat() === 'opencode' ? parseOpencode() : parseClaude();
const toolCalls = [];

if (detectFormat() === 'opencode') {
  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev?.part?.type === 'tool') {
      const input = ev.part.state?.input || {};
      let detail = '';
      if (/^atlas/i.test(ev.part.tool)) detail = ` ${JSON.stringify(input.query ?? input.question ?? input.task ?? input.symbol ?? '').slice(0, 80)}`;
      else if (ev.part.tool === 'bash') detail = ` ${(input.command ?? '').slice(0, 60)}`;
      else if (ev.part.tool === 'read') detail = ` ${(input.filePath ?? input.file_path ?? '').split(/[\\/]/).pop()}`;
      else if (ev.part.tool === 'grep') detail = ` ${input.pattern ?? ''}`.slice(0, 60);
      toolCalls.push(`${ev.part.tool}${detail}`);
    }
  }
} else {
  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'assistant' && ev.message?.content) {
      for (const block of ev.message.content) {
        if (block.type === 'tool_use') {
          const name = block.name;
          let detail = '';
          if (name === 'Task') detail = ` [subagent_type=${block.input?.subagent_type ?? '?'}] ${(block.input?.description ?? '').slice(0, 40)}`;
          else if (/atlas/i.test(name)) detail = ` ${JSON.stringify(block.input?.query ?? block.input?.question ?? block.input?.task ?? block.input?.symbol ?? '').slice(0, 80)}`;
          else if (name === 'Bash') detail = ` ${(block.input?.command ?? '').slice(0, 60)}`;
          else if (name === 'Read') detail = ` ${(block.input?.file_path ?? '').split(/[\\/]/).pop()}`;
          else if (name === 'Grep') detail = ` ${block.input?.pattern ?? ''}`.slice(0, 60);
          toolCalls.push(`${name}${detail}`);
        }
      }
    }
  }
}

if (asJson) {
  process.stdout.write(JSON.stringify(metrics) + '\n');
  process.exit(0);
}

console.log(`\n=== ${file.split(/[\\/]/).pop()} ===`);
console.log(`atlas tools exposed: ${metrics.atlas_tools_exposed}`);
console.log(`\nTool calls (${metrics.tool_calls_total}):`);
console.log('  by type:', JSON.stringify(metrics.counts));
toolCalls.forEach((tc, i) => console.log(`  ${i + 1}. ${tc}`));

const valid = metrics.valid_run ? 'valid' : `invalid:${metrics.failure_kind}`;
console.log(`\nResult: ${metrics.result_subtype} (${valid}) | ${metrics.duration_s}s | turns ${metrics.num_turns}`);
console.log(`  tokens: fresh_in=${metrics.fresh_input_tokens} cache_read=${metrics.cache_read_input_tokens} cache_create=${metrics.cache_creation_input_tokens} out=${metrics.output_tokens} total=${metrics.total_tokens} billable=${metrics.total_billable_tokens} | cost $${(metrics.cost_usd || 0).toFixed(3)}`);
if (!metrics.valid_run) console.log(`  failure: ${metrics.failure_reason}`);
