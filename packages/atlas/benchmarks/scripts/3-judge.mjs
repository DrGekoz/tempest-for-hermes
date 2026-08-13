#!/usr/bin/env node
// 3-judge.mjs — score each arm's final answer against ground-truth anchors.
//
// Anchors are the "KEY SYMBOLS a correct answer must hit" list embedded in
// each ground-truth entry (see ground-truth.json). We tokenize both sides
// and compute recall = matched-anchors / total-anchors.
//
// No LLM judge (constraint: no API keys). Deterministic string-anchor match,
// case-insensitive, punctuation-normalized. Same rule for both arms so any
// bias affects both — comparison remains fair.
//
// Usage: node 3-judge.mjs
//   reads:  benchmarks/results/ab-*.json + benchmarks/ground-truth.json
//   writes: benchmarks/results/judged-<repo>.json + judged-summary.json

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here     = dirname(fileURLToPath(import.meta.url));
const bench    = dirname(here);
const results  = join(bench, 'results');
const stripBom = (s) => (s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s);
const readJson = (p) => JSON.parse(stripBom(readFileSync(p, 'utf8')));
const truth    = readJson(join(bench, 'ground-truth.json'));

function norm(s) {
  return String(s).toLowerCase().replace(/[`"'()\[\],.;]/g, ' ').replace(/\s+/g, ' ').trim();
}

function scoreAnswer(anchors, answer) {
  const hay = norm(answer);
  const hits = [];
  const misses = [];
  for (const a of anchors) {
    if (hay.includes(norm(a))) hits.push(a); else misses.push(a);
  }
  return {
    anchors_total: anchors.length,
    anchors_hit:   hits.length,
    recall:        anchors.length ? +(hits.length / anchors.length).toFixed(3) : 0,
    hits, misses,
  };
}

function invalidScore(anchors, r) {
  return {
    anchors_total: anchors.length,
    anchors_hit: 0,
    recall: null,
    hits: [],
    misses: anchors,
    invalid: true,
    failure_kind: r.failure_kind || 'invalid',
    failure_reason: r.failure_reason || 'Run marked invalid',
  };
}

const abFiles = readdirSync(results).filter((f) => /^ab-[^.]+\.json$/.test(f) && f !== 'ab-summary.json');

const judgedAll = [];

for (const f of abFiles) {
  const path = join(results, f);
  const data = readJson(path);
  const t = truth[data.id];
  if (!t) { console.warn(`no ground truth for ${data.id} — skip`); continue; }
  const anchors = t.anchors || [];
  if (!anchors.length) { console.warn(`ground truth for ${data.id} has no anchors[] — skip`); continue; }

  const runs = data.runs.map((r) => {
    const valid = r.valid_run !== false;
    return {
      arm: r.arm,
      run: r.run,
      valid_run: valid,
      ...(valid ? scoreAnswer(anchors, r.final_text || '') : invalidScore(anchors, r)),
      atlas_tools_exposed: r.atlas_tools_exposed,
      tool_calls_total: r.tool_calls_total,
      reads: r.reads, greps: r.greps, globs: r.globs, bash: r.bash, atlas_calls: r.atlas_calls,
      input_tokens: r.input_tokens,
      fresh_input_tokens: r.fresh_input_tokens ?? r.input_tokens,
      cache_read_input_tokens: r.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: r.cache_creation_input_tokens ?? 0,
      output_tokens: r.output_tokens,
      total_tokens: r.total_tokens,
      total_billable_tokens: r.total_billable_tokens ?? r.total_tokens,
      duration_s: r.duration_s,
      cost_usd: r.cost_usd,
      result_subtype: r.result_subtype,
      failure_kind: r.failure_kind ?? null,
      failure_reason: r.failure_reason ?? null,
    };
  });

  const judged = { id: data.id, question: data.question, anchors_total: anchors.length, runs };
  writeFileSync(join(results, `judged-${data.id}.json`), JSON.stringify(judged, null, 2));
  judgedAll.push(judged);

  console.log(`\n[${data.id}] anchors=${anchors.length}`);
  for (const r of runs) {
    const status = r.valid_run ? `recall=${r.recall}  hit=${r.anchors_hit}/${r.anchors_total}` : `INVALID ${r.failure_kind}: ${r.failure_reason}`;
    console.log(`  ${r.arm.padEnd(7)} run${r.run}  ${status}  calls=${r.tool_calls_total}  fresh=${r.fresh_input_tokens} cache_read=${r.cache_read_input_tokens} total=${r.total_tokens}  ${r.duration_s}s`);
  }
}

writeFileSync(join(results, 'judged-summary.json'), JSON.stringify(judgedAll, null, 2));
console.log(`\nwrote ${judgedAll.length} judged reports + judged-summary.json`);
