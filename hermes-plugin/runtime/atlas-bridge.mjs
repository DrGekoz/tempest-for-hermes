#!/usr/bin/env node
/**
 * atlas-bridge.mjs — Tempest for Hermes: Atlas knowledge-graph bridge.
 *
 * A thin, dependency-light CLI that wraps the `@usetempest/atlas` semantic code
 * knowledge graph (Tempest's "Token Intelligence") so the Python plugin can
 * index a codebase once and serve surgical, token-cheap context to Hermes
 * agents — without needing a Tauri/Rust runtime.
 *
 * Usage (args are passed as a single JSON string on argv[2], so no shell
 * quoting issues and no truncation on long queries):
 *
 *   node atlas-bridge.mjs <cmd> '<json>'
 *
 * Commands:
 *   version                    -> { ok, node, atlasVersion }
 *   projects                   -> { ok, projects: [{path,name,indexed,nodeCount,edgeCount,fileCount,lastIndexedAt}] }
 *   index   {project, sync}    -> create-or-refresh the index; { ok, stats }
 *   context {project, query, maxNodes?, maxCodeBlocks?, format?, ...} -> { ok, markdown, summary, stats, relatedFiles }
 *   search  {project, query, limit?}                                  -> { ok, hits: [{name,kind,file,line}] }
 *   stats   {project}          -> { ok, stats }
 *
 * Every command prints a JSON object to stdout and exits 0. On failure it
 * prints { ok:false, error, step } to stdout and exits 1. All logs go to
 * stderr so stdout stays machine-parseable.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const log = (...a) => process.stderr.write('[atlas-bridge] ' + a.join(' ') + '\n');

function jsonOut(obj, code = 0) {
  try {
    process.stdout.write(JSON.stringify(obj) + '\n');
  } catch (e) {
    process.stderr.write('[atlas-bridge] failed to serialise output: ' + e + '\n');
    process.stdout.write('{"ok":false,"error":"serialise failed"}\n');
  }
  process.exit(code);
}

function fail(step, error) {
  log(`FAIL at step "${step}":`, error && error.stack ? error.stack : error);
  jsonOut({ ok: false, step, error: String(error && error.message ? error.message : error) }, 1);
}

// Registry of known projects — persisted so `projects` works even before the
// first Python-side call and so the plugin/dashboard can list what's indexed.
function registryPath() {
  const base = process.env.TEMPEST_REGISTRY
    ? process.env.TEMPEST_REGISTRY
    : path.join(os.homedir(), '.tempest-for-hermes', 'projects.json');
  return base;
}

function loadRegistry() {
  try {
    const raw = fs.readFileSync(registryPath(), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveRegistry(projects) {
  try {
    fs.mkdirSync(path.dirname(registryPath()), { recursive: true });
    fs.writeFileSync(registryPath(), JSON.stringify(projects, null, 2));
  } catch (e) {
    log('could not persist registry:', e && e.message);
  }
}

function projectName(project) {
  // Resolve to an absolute path and name the project after its folder.
  let abs = project;
  try {
    abs = path.resolve(project);
  } catch { /* keep as-is */ }
  return { abs, name: path.basename(abs) || abs };
}

let _Atlas = null;
function loadAtlas() {
  if (_Atlas) return _Atlas;
  const dist = require.resolve('@usetempest/atlas/dist/index.js', {
    paths: [__dirname],
  });
  const mod = require(dist);
  _Atlas = mod.default ?? mod.Atlas ?? mod;
  return _Atlas;
}

function registryEntry(path_, name) {
  return loadRegistry().find((p) => p.path === path_ || p.name === name);
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

async function cmdVersion() {
  const Atlas = loadAtlas();
  jsonOut({ ok: true, node: process.version, platform: `${process.platform}/${process.arch}`, atlas: '1.3.2' });
}

async function cmdProjects() {
  const Atlas = loadAtlas();
  const out = [];
  for (const p of loadRegistry()) {
    let stats = null;
    try {
      const inst = Atlas.open(p.path, { readOnly: true });
      stats = inst.getStats ? inst.getStats() : null;
      inst.close?.();
    } catch { /* not currently openable; keep last known stats */ }
    out.push({
      path: p.path,
      name: p.name,
      indexed: p.indexed,
      nodeCount: stats?.nodeCount ?? p.nodeCount ?? 0,
      edgeCount: stats?.edgeCount ?? p.edgeCount ?? 0,
      fileCount: stats?.fileCount ?? p.fileCount ?? 0,
      lastIndexedAt: stats?.lastUpdated ?? p.lastIndexedAt ?? null,
    });
  }
  jsonOut({ ok: true, projects: out });
}

async function cmdIndex({ project, sync }) {
  if (!project) return fail('index/args', 'missing "project"');
  const Atlas = loadAtlas();
  const { abs, name } = projectName(project);
  if (!fs.existsSync(abs)) return fail('index/exists', `project not found: ${abs}`);

  let atlas;
  if (Atlas.isInitialized(abs)) {
    atlas = await Atlas.open(abs, { sync: sync !== false });
  } else {
    atlas = await Atlas.init(abs, {
      index: true,
      onProgress: (p) => log(`index ${p?.phase} ${p?.current ?? ''}/${p?.total ?? ''}`),
    });
  }

  const stats = atlas.getStats ? atlas.getStats() : null;
  const nodeCount = stats?.nodeCount ?? 0;
  const edgeCount = stats?.edgeCount ?? 0;
  const fileCount = stats?.fileCount ?? 0;
  const lastUpdated = stats?.lastUpdated ?? Date.now();
  atlas.close?.();

  const reg = loadRegistry().filter((r) => r.path !== abs);
  reg.push({ path: abs, name, indexed: true, nodeCount, edgeCount, fileCount, lastIndexedAt: lastUpdated });
  saveRegistry(reg);

  jsonOut({ ok: true, project: abs, name, stats: stats ?? {} });
}

async function openForQuery(abs) {
  const Atlas = loadAtlas();
  if (!Atlas.isInitialized(abs)) {
    throw new Error(`not indexed — run "atlas index" on ${abs} first`);
  }
  // NOTE: must open read-WRITE. Atlas's buildContext returns empty context on a
  // readOnly connection (the semantic/vector + traversal channels don't produce
  // entry points), so readOnly is deliberately NOT used here.
  return Atlas.open(abs, { sync: false });
}

async function cmdContext({ project, query, ...opts }) {
  if (!project) return fail('context/args', 'missing "project"');
  if (!query) return fail('context/args', 'missing "query"');
  const Atlas = loadAtlas();
  const { abs } = projectName(project);
  const atlas = await openForQuery(abs);
  try {
    // IMPORTANT: only forward options the caller actually provided. Passing
    // explicit `undefined` for e.g. `minScore` / `searchLimit` clobbers atlas's
    // own defaults via object spread and makes buildContext return empty
    // context. Build the options dict conditionally.
    const bo = {};
    for (const k of ['maxNodes', 'maxCodeBlocks', 'maxCodeBlockSize', 'searchLimit', 'traversalDepth', 'minScore']) {
      if (opts[k] !== undefined && opts[k] !== null) bo[k] = opts[k];
    }
    if (opts.includeCode !== undefined) bo.includeCode = opts.includeCode !== false;
    bo.format = opts.format || 'markdown';
    const result = await atlas.buildContext(query, bo);
    if (typeof result === 'string') {
      jsonOut({ ok: true, project: abs, markdown: result, summary: '', stats: null, relatedFiles: [] });
      return;
    }
    jsonOut({
      ok: true,
      project: abs,
      markdown: '',
      summary: result.summary,
      relatedFiles: result.relatedFiles || [],
      stats: result.stats || {},
    });
  } finally {
    atlas.close?.();
  }
}

async function cmdStats({ project }) {
  if (!project) return fail('stats/args', 'missing "project"');
  const Atlas = loadAtlas();
  const { abs } = projectName(project);
  const atlas = await openForQuery(abs);
  try {
    const stats = atlas.getStats ? atlas.getStats() : {};
    jsonOut({ ok: true, project: abs, stats: stats ?? {} });
  } finally {
    atlas.close?.();
  }
}

async function cmdSearch({ project, query, limit }) {
  if (!project) return fail('search/args', 'missing "project"');
  if (!query) return fail('search/args', 'missing "query"');
  const Atlas = loadAtlas();
  const { abs } = projectName(project);
  const atlas = await openForQuery(abs);
  try {
    const hits = atlas.searchNodes ? atlas.searchNodes(query, { limit: limit || 10 }) : [];
    const out = (hits || []).map((h) => ({
      name: h?.node?.name,
      kind: h?.node?.kind,
      file: h?.node?.file,
      line: h?.node?.startLine ?? h?.node?.line ?? null,
      score: h?.score ?? null,
    }));
    jsonOut({ ok: true, project: abs, hits: out });
  } finally {
    atlas.close?.();
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function main() {
  const cmd = process.argv[2];
  let args = {};
  if (process.argv[3]) {
    try {
      args = JSON.parse(process.argv[3]);
    } catch (e) {
      return fail('dispatch/args', `argv[3] is not valid JSON: ${e.message}`);
    }
  }
  log(`cmd=${cmd} args=${JSON.stringify(Object.keys(args))}`);
  switch (cmd) {
    case 'version': return cmdVersion();
    case 'projects': return cmdProjects();
    case 'index': return cmdIndex(args);
    case 'context': return cmdContext(args);
    case 'stats': return cmdStats(args);
    case 'search': return cmdSearch(args);
    default:
      return fail('dispatch/cmd', `unknown command "${cmd}" (expected version|projects|index|context|stats|search)`);
  }
}

main().catch((e) => fail('main', e));
