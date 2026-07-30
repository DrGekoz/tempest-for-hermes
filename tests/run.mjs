#!/usr/bin/env node
// Dev test runner. Discovers every `*.check.ts` self-check under `src/` and runs
// each in its own `node` process (Node strips the types natively — no framework,
// no build step). Prints one line per check and exits non-zero if any fail, so
// it drops straight into a pre-commit hook or CI.
//
//   npm test              # run everything
//   npm test tempest      # run only checks whose path contains "tempest"
//   node tests/run.mjs -v # also print each check's own stdout
//
// A "check" is any file the codebase already keeps next to its source: a plain
// script that imports the pure functions and asserts on them with node:assert,
// ending in `console.log("... all checks passed")`. Add one and it's picked up
// here automatically — nothing to register.

import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SRC = join(ROOT, "src");

const args = process.argv.slice(2);
const verbose = args.includes("-v") || args.includes("--verbose");
const filters = args.filter((a) => !a.startsWith("-"));

// Recursively collect *.check.ts, skipping the usual noise dirs.
function findChecks(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findChecks(full));
    else if (entry.name.endsWith(".check.ts")) out.push(full);
  }
  return out;
}

let checks = findChecks(SRC).sort();
if (filters.length) {
  checks = checks.filter((f) => filters.some((needle) => f.includes(needle)));
}

if (!checks.length) {
  console.error(filters.length ? `No checks match: ${filters.join(", ")}` : "No *.check.ts files found under src/.");
  process.exit(1);
}

const GREEN = "\x1b[32m", RED = "\x1b[31m", DIM = "\x1b[2m", RESET = "\x1b[0m";
let failed = 0;
const started = Date.now();

for (const file of checks) {
  const rel = relative(ROOT, file);
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [file], { cwd: ROOT, encoding: "utf8" });
  const ms = Date.now() - t0;
  const ok = res.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? GREEN + "PASS" : RED + "FAIL"}${RESET} ${rel} ${DIM}(${ms}ms)${RESET}`);
  // Show the check's own output on failure always, on success only when -v.
  const output = (res.stdout + res.stderr).trim();
  if ((!ok || verbose) && output) {
    console.log(output.split("\n").map((l) => "    " + l).join("\n"));
  }
}

const total = Date.now() - started;
const summary = `${checks.length - failed}/${checks.length} passed in ${total}ms`;
console.log(failed ? `${RED}${summary}${RESET}` : `${GREEN}${summary}${RESET}`);
process.exit(failed ? 1 : 0);
