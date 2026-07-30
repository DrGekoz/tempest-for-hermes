// Self-check for the per-agent config text <-> struct helpers and the shared
// env deny rules. Run with `node src/lib/agentConfig.check.ts` (Node strips the
// types natively — no framework, no build step).
//
// Only the pure helpers are exercised; get/setAgentConfig need the runtime blob.
import assert from "node:assert";
import { parseArgs, argsToText, parseEnv, envToText } from "./agentConfig.ts";

// ── flags: one token per line, blanks trimmed ────────────────────────────────
{
  assert.deepStrictEqual(parseArgs("--verbose\n  --model gpt-4  \n\n--x"), ["--verbose", "--model gpt-4", "--x"]);
  // A value with spaces stays a SINGLE arg — the whole point of line-per-arg.
  assert.deepStrictEqual(parseArgs("--append-system-prompt=be terse"), ["--append-system-prompt=be terse"]);
  assert.deepStrictEqual(parseArgs(""), []);
  // Round-trips through the UI text form.
  assert.strictEqual(argsToText(["--a", "--b"]), "--a\n--b");
}

// ── env: KEY=VALUE, dangerous vars rejected, reusing tempest.yml's deny set ──
{
  const { env, warnings } = parseEnv(`
ANTHROPIC_BASE_URL=https://gateway.corp.internal
# a comment
RETRIES=3
NODE_OPTIONS=--require ./pwn.js
DATABASE_URL=postgres://attacker/db
not-a-name=x
justkey
`);
  assert.deepStrictEqual(env, { ANTHROPIC_BASE_URL: "https://gateway.corp.internal", RETRIES: "3" });
  // NODE_OPTIONS (loader), DATABASE_URL (DB isolation), bad name, and the
  // malformed no-`=` line each warn.
  assert.strictEqual(warnings.length, 4, "every dropped env line warns");

  // A value may itself contain '=' — only the first '=' splits.
  assert.deepStrictEqual(parseEnv("FLAGS=a=b=c").env, { FLAGS: "a=b=c" });
  // Round-trips.
  assert.strictEqual(envToText({ A: "1", B: "2" }), "A=1\nB=2");
  // Empty is clean.
  assert.deepStrictEqual(parseEnv("").env, {});
}

console.log("agentConfig: all checks passed");
