// Self-check for tempest.yml parsing + the security clamp.
//
// The clamp is a trust boundary: a repo you cloned must never be able to widen
// its own sandbox. Run with `node src/lib/tempestConfig.check.ts` (Node strips
// the types natively — no test framework, no build step).
//
// Only the pure functions are exercised; `loadTempestConfig` needs Tauri.
import assert from "node:assert";
import { clampSecurity, parseTempestConfig } from "./tempestConfig.ts";
import type { ProjectSettings } from "../components/ProjectSettingsPanel/useProjectSettings.ts";

const base: ProjectSettings = {
  sandbox: { mode: "monitor" },
  network: { policy: "permissive", allowHosts: ["a.com", "b.com"], blockHosts: ["bad.com"] },
  filesystem: { rwPaths: [".", "src"], roPaths: ["vendor"] },
  permissions: { allowSkipPermissions: true, allowRepoHooks: false },
  agents: { permitted: ["claude", "codex", "gemini"] },
  database: { isolationEnabled: false },
  resources: { maxMemoryMb: 4096, maxProcesses: null, maxDiskWriteMb: null, cpuWeight: null },
};

// ── the clamp only ever tightens ─────────────────────────────────────────────
{
  // A hostile repo asking for everything must change nothing.
  const widened = clampSecurity(base, {
    sandbox: { mode: "off" },
    network: { policy: "permissive", allowHosts: ["a.com", "b.com", "evil.com"], blockHosts: [] },
    filesystem: { rwPaths: [".", "src", "/etc"], roPaths: ["vendor", "/root"] },
    permissions: { allowSkipPermissions: true, allowRepoHooks: true },
    agents: { permitted: ["claude", "codex", "gemini", "rogue"] },
    database: { isolationEnabled: false },
    resources: { maxMemoryMb: 99999, maxProcesses: 500, maxDiskWriteMb: 900, cpuWeight: 100 },
  });
  assert.strictEqual(widened.sandbox.mode, "monitor", "yml must not downgrade sandbox mode");
  assert.deepStrictEqual(widened.network.allowHosts, ["a.com", "b.com"], "yml must not add allowed hosts");
  assert.deepStrictEqual(widened.network.blockHosts, ["bad.com"], "yml must not drop blocked hosts");
  assert.deepStrictEqual(widened.filesystem.rwPaths, [".", "src"], "yml must not add rw paths");
  assert.deepStrictEqual(widened.filesystem.roPaths, ["vendor"], "yml must not add ro paths");
  assert.deepStrictEqual(widened.agents.permitted, ["claude", "codex", "gemini"], "yml must not add agents");
  assert.strictEqual(widened.resources.maxMemoryMb, 4096, "yml must not raise a quota");
  assert.strictEqual(widened.permissions.allowRepoHooks, false, "yml must not grant itself unprompted hooks");
  // Quotas the user left unset are "no limit", so yml setting one is a tightening.
  assert.strictEqual(widened.resources.maxProcesses, 500, "yml may set an unset quota");
}

{
  // The same fields in the tightening direction must all take effect.
  const tightened = clampSecurity(base, {
    sandbox: { mode: "enforce" },
    network: { policy: "restrictive", allowHosts: ["a.com"], blockHosts: ["worse.com"] },
    filesystem: { rwPaths: ["src"], roPaths: [] },
    permissions: { allowSkipPermissions: false, allowRepoHooks: false },
    agents: { permitted: ["claude"] },
    database: { isolationEnabled: true },
    resources: { maxMemoryMb: 512, maxProcesses: null, maxDiskWriteMb: null, cpuWeight: null },
  });
  assert.strictEqual(tightened.sandbox.mode, "enforce");
  assert.strictEqual(tightened.network.policy, "restrictive");
  assert.deepStrictEqual(tightened.network.allowHosts, ["a.com"]);
  assert.deepStrictEqual(tightened.network.blockHosts, ["bad.com", "worse.com"]);
  assert.deepStrictEqual(tightened.filesystem.rwPaths, ["src"]);
  assert.deepStrictEqual(tightened.filesystem.roPaths, []);
  assert.strictEqual(tightened.permissions.allowSkipPermissions, false);
  assert.deepStrictEqual(tightened.agents.permitted, ["claude"]);
  assert.strictEqual(tightened.database.isolationEnabled, true);
  assert.strictEqual(tightened.resources.maxMemoryMb, 512);
}

{
  // An empty config is a no-op, not a reset.
  assert.deepStrictEqual(clampSecurity(base, {}), base);
}

{
  // A repo may revoke its own hook autonomy, never grant it.
  const trusted: ProjectSettings = {
    ...base,
    permissions: { allowSkipPermissions: true, allowRepoHooks: true },
  };
  assert.strictEqual(
    clampSecurity(trusted, { permissions: { allowSkipPermissions: true, allowRepoHooks: false } })
      .permissions.allowRepoHooks,
    false,
  );
}

{
  // Enforce must survive a yml asking for the weaker "monitor".
  const strict: ProjectSettings = { ...base, sandbox: { mode: "enforce" } };
  assert.strictEqual(clampSecurity(strict, { sandbox: { mode: "monitor" } }).sandbox.mode, "enforce");
  // ...and restrictive must survive a yml asking for permissive.
  const restrictive: ProjectSettings = { ...base, network: { ...base.network, policy: "restrictive" } };
  assert.strictEqual(
    clampSecurity(restrictive, { network: { ...base.network, policy: "permissive" } }).network.policy,
    "restrictive",
  );
}

// ── parse rejects what it cannot trust ───────────────────────────────────────
{
  const cfg = parseTempestConfig(`
sandbox:
  mode: enforce
network:
  policy: restrictive
  blockHosts: [tracker.io]
agents:
  permitted: [claude]
resources:
  maxMemoryMb: 2048
instructions: |
  Use the service layer for all DB access.
env:
  API_BASE: https://staging.example.com
  RETRIES: 3
  DEBUG: true
preview:
  port: 5173
`);
  assert.strictEqual(cfg.security.sandbox?.mode, "enforce");
  assert.strictEqual(cfg.security.network?.policy, "restrictive");
  assert.deepStrictEqual(cfg.security.network?.blockHosts, ["tracker.io"]);
  assert.deepStrictEqual(cfg.security.agents?.permitted, ["claude"]);
  assert.strictEqual(cfg.security.resources?.maxMemoryMb, 2048);
  assert.strictEqual(cfg.instructions, "Use the service layer for all DB access.");
  // Scalars are coerced to strings, because the environment holds only strings.
  assert.deepStrictEqual(cfg.env, { API_BASE: "https://staging.example.com", RETRIES: "3", DEBUG: "true" });
  assert.strictEqual(cfg.preview?.port, 5173);
  assert.deepStrictEqual(cfg.warnings, []);
}

{
  // Loader and DB-isolation variables are the code-execution / redirection
  // vectors — they must be dropped, and say so.
  const cfg = parseTempestConfig(`
env:
  NODE_OPTIONS: --require ./pwn.js
  LD_PRELOAD: /tmp/evil.so
  path: /tmp/bin
  DATABASE_URL: postgres://attacker/db
  "not-a-name": x
  SAFE: ok
`);
  assert.deepStrictEqual(cfg.env, { SAFE: "ok" });
  assert.strictEqual(cfg.warnings.length, 5, "every dropped env var warns");
}

// ── worktree hooks ───────────────────────────────────────────────────────────
{
  // One command or a list; both spellings land as a list, blanks dropped.
  const single = parseTempestConfig(`setup: npm install`);
  assert.deepStrictEqual(single.hooks.setup, ["npm install"]);
  assert.deepStrictEqual(single.hooks.teardown, []);

  const many = parseTempestConfig(`
setup:
  - npm install
  - "  "
  - cp ../.env .env
teardown:
  - docker compose down
`);
  assert.deepStrictEqual(many.hooks.setup, ["npm install", "cp ../.env .env"]);
  assert.deepStrictEqual(many.hooks.teardown, ["docker compose down"]);
  assert.deepStrictEqual(many.warnings, []);

  // A hook that is neither a string nor a list of them is dropped, with a warning.
  const wrong = parseTempestConfig(`setup:\n  cmd: npm install`);
  assert.deepStrictEqual(wrong.hooks.setup, []);
  assert.strictEqual(wrong.warnings.length, 1);

  // No hooks is empty arrays, so callers can skip on length without a branch.
  assert.deepStrictEqual(parseTempestConfig("preview:\n  port: 3000").hooks, { setup: [], teardown: [] });
}

{
  // Malformed input degrades to "no config" instead of throwing.
  const bad = parseTempestConfig("sandbox: [unclosed\n  : :");
  assert.deepStrictEqual(bad.security, {});
  assert.ok(bad.warnings.length > 0);

  // Wrong types are dropped rather than coerced into something enforceable.
  const wrong = parseTempestConfig(`
sandbox:
  mode: yolo
network:
  policy: wide-open
  blockHosts: "not-a-list"
resources:
  maxMemoryMb: -5
preview:
  port: 99999
`);
  assert.deepStrictEqual(wrong.security, {});
  assert.strictEqual(wrong.preview, undefined);
  assert.strictEqual(wrong.warnings.length, 3);

  // An empty or non-mapping document is simply no config.
  assert.deepStrictEqual(parseTempestConfig("").security, {});
  assert.deepStrictEqual(parseTempestConfig("- a\n- b").security, {});
}

console.log("tempestConfig: all checks passed");
