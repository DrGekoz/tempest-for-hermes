#!/usr/bin/env node
/**
 * test-bridge.mjs — smoke test for atlas-bridge.mjs in BOTH modes.
 *
 *   1. One-shot CLI mode: version command returns ok.
 *   2. Server (persistent) mode: spawn the bridge with no args, send
 *      JSON-lines requests over stdin, verify responses come back and that
 *      the SAME process answers multiple requests (no per-call cold start).
 *
 * Usage: node test-bridge.mjs   (from the runtime/ directory)
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bridge = path.join(__dirname, 'atlas-bridge.mjs');

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  [OK]   ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}  ${detail}`); }
};

// --- 1. one-shot mode -----------------------------------------------------
await new Promise((resolve) => {
  const p = spawn(process.execPath, [bridge, 'version', '{}'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.on('close', (code) => {
    const r = JSON.parse(out.trim().split('\n').pop());
    check('one-shot version', code === 0 && r.ok === true && !!r.node, `code=${code} ${out.slice(0, 120)}`);
    resolve();
  });
});

// --- 2. server (persistent) mode ------------------------------------------
const env = { ...process.env };
const tmpReg = path.join(os.tmpdir(), `tempest-bridge-test-${process.pid}.json`);
env.TEMPEST_REGISTRY = tmpReg;

const server = spawn(process.execPath, [bridge], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const responses = new Map();
let nextId = 1;
let stderrLog = '';

server.stderr.on('data', (d) => (stderrLog += d));
server.stdout.on('data', (d) => {
  buf += d;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== null && msg.id !== undefined) responses.set(msg.id, msg);
    } catch { /* ignore */ }
  }
});

const call = (cmd, args = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    server.stdin.write(JSON.stringify({ id, cmd, args }) + '\n');
    const t0 = Date.now();
    const poll = () => {
      if (responses.has(id)) {
        const r = responses.get(id);
        r._ms = Date.now() - t0;
        resolve(r);
      } else {
        setTimeout(poll, 5);
      }
    };
    poll();
  });

try {
  const v1 = await call('version');
  check('server version', v1.ok === true && !!v1.node, JSON.stringify(v1));
  const v2 = await call('version');
  check('server answers twice (persistent)', v2.ok === true, JSON.stringify(v2));
  const p1 = await call('projects');
  check('server projects', p1.ok === true && Array.isArray(p1.projects), JSON.stringify(p1));
  console.log(`  [..]   first call ${v1._ms}ms, second ${v2._ms}ms (module already warm)`);
} finally {
  server.stdin.end();
  await new Promise((r) => server.on('close', r));
  try { fs.unlinkSync(tmpReg); } catch { /* ignore */ }
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);