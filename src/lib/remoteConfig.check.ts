// Self-check for the remote-config validator + merge — the data-only patch
// channel that ships new models without an app release. This is untrusted-input
// parsing, so it keeps a runnable check.
// Run with `node src/lib/remoteConfig.check.ts` (Node strips the types natively).
import assert from "node:assert";
import { merge, validate, type ModelManifest } from "./remoteConfig.ts";

const base: ModelManifest = {
  providers: { anthropic: [{ id: "claude-opus-4-8", label: "Claude Opus 4.8" }] },
  context: { "claude-opus-4-8": 200000 },
};

// ── validate drops anything malformed, never coerces ─────────────────────────
assert.deepStrictEqual(validate(null), {}, "junk is no patch, not a throw");
assert.deepStrictEqual(validate("nope"), {});
assert.deepStrictEqual(validate({ providers: "nope" }), {});

const clean = validate({
  providers: {
    anthropic: [
      { id: "claude-opus-5", label: "Claude Opus 5" },
      { id: 42, label: "bad id" },          // dropped: id not a string
      { label: "no id" },                    // dropped: missing id
      "garbage",                             // dropped: not an object
    ],
    broken: "not an array",                  // whole provider dropped
  },
  context: {
    "claude-opus-5": 200000,
    "bad": -5,                               // dropped: not positive
    "worse": "lots",                         // dropped: not a number
  },
  secretPrivilegedField: { runCommand: "rm -rf /" }, // ignored: unknown key
});
assert.deepStrictEqual(clean.providers, {
  anthropic: [{ id: "claude-opus-5", label: "Claude Opus 5" }],
}, "only well-formed {id,label} survive; a bad provider is not partially kept");
assert.deepStrictEqual(clean.context, { "claude-opus-5": 200000 });
assert.ok(!("secretPrivilegedField" in clean), "unknown keys never reach the manifest");

// A patch with nothing valid is empty, so a fetch of it changes nothing.
assert.deepStrictEqual(validate({ providers: {}, context: {} }), {});

// ── merge: provider-level replace, context merges by id ──────────────────────
const patched = merge(base, validate({
  providers: { anthropic: [{ id: "claude-opus-5", label: "Claude Opus 5" }] },
  context: { "claude-opus-5": 200000 },
}));
assert.deepStrictEqual(patched.providers.anthropic, [
  { id: "claude-opus-5", label: "Claude Opus 5" },
], "a named provider is replaced whole, not appended to");
assert.strictEqual(patched.context["claude-opus-4-8"], 200000, "context merges: old id kept");
assert.strictEqual(patched.context["claude-opus-5"], 200000, "context merges: new id added");

// An empty patch leaves the bundled floor untouched — can't blank the UI.
assert.deepStrictEqual(merge(base, {}), base);

console.log("remoteConfig.check.ts — all assertions passed");
