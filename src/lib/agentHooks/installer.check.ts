// Self-check for the agent-hooks merge engine + the Claude adapter.
//
// The merge is a trust-sensitive edit of the user's OWN agent config files, so
// the properties that matter are: never drop a user's hooks, be idempotent
// (startup re-install must be a no-op), sweep only our own entries on removal,
// and map events to the right state. Run with `node src/lib/agentHooks/installer.check.ts`
// (Node strips types natively — no framework, no build step).
//
// Only pure functions are exercised; the install engine itself needs Tauri.
import assert from "node:assert";
import { applyNestedHooks, removeNestedHooks, makeManagedMatcher, type NestedEvent } from "./schema.ts";
import { claudeAdapter } from "./adapters/claude.ts";
import type { JsonObject } from "./types.ts";

const SCRIPT = "tempest-claude-hook.cmd";
const CMD = "if [ -f '/home/u/.tempest/hooks/tempest-claude-hook.cmd' ]; then '/home/u/.tempest/hooks/tempest-claude-hook.cmd'; fi";
const EVENTS: NestedEvent[] = [
  { name: "UserPromptSubmit" },
  { name: "PreToolUse", matcher: true },
  { name: "Stop" },
];

function managedCount(config: JsonObject): number {
  const isManaged = makeManagedMatcher(SCRIPT);
  const hooks = (config.hooks ?? {}) as Record<string, any[]>;
  let n = 0;
  for (const defs of Object.values(hooks)) {
    for (const def of defs) {
      if (isManaged(def.command)) n++;
      for (const h of def.hooks ?? []) if (isManaged(h.command)) n++;
    }
  }
  return n;
}

// ── user hooks and unrelated keys survive a merge ────────────────────────────
{
  const userHook = { hooks: [{ type: "command", command: "my-own-linter" }] };
  const before: JsonObject = {
    model: "opus",
    permissions: { allow: ["Bash"] },
    hooks: { PreToolUse: [userHook], Stop: [{ hooks: [{ type: "command", command: "user-stop" }] }] },
  };
  const after = applyNestedHooks(before, CMD, SCRIPT, EVENTS);

  assert.strictEqual((after as any).model, "opus", "unrelated top-level keys must survive");
  assert.deepStrictEqual((after as any).permissions, { allow: ["Bash"] }, "unrelated keys untouched");
  const pre = (after as any).hooks.PreToolUse as any[];
  assert.ok(pre.some((d) => d === userHook || d.hooks?.[0]?.command === "my-own-linter"), "user PreToolUse hook preserved");
  assert.strictEqual(managedCount(after), 3, "one managed entry per subscribed event");
  // The user's Stop hook still there alongside ours.
  const stop = (after as any).hooks.Stop as any[];
  assert.ok(stop.some((d) => d.hooks?.[0]?.command === "user-stop"), "user Stop hook preserved");
}

// ── idempotent: re-install writes the same object ────────────────────────────
{
  const before: JsonObject = { hooks: { Stop: [{ hooks: [{ type: "command", command: "keep-me" }] }] } };
  const once = applyNestedHooks(before, CMD, SCRIPT, EVENTS);
  const twice = applyNestedHooks(once, CMD, SCRIPT, EVENTS);
  assert.strictEqual(JSON.stringify(once), JSON.stringify(twice), "re-install must be a no-op");
  assert.strictEqual(managedCount(twice), 3, "no duplicate managed entries after re-install");
}

// ── stale platform entry (.sh) is swept when installing (.cmd) ───────────────
{
  const stale: JsonObject = {
    hooks: { Stop: [{ hooks: [{ type: "command", command: "sh /x/tempest-claude-hook.sh" }] }] },
  };
  const after = applyNestedHooks(stale, CMD, SCRIPT, EVENTS);
  const stop = (after as any).hooks.Stop as any[];
  const shGone = !stop.some((d) => (d.hooks ?? []).some((h: any) => String(h.command).includes(".sh")));
  assert.ok(shGone, "a stale .sh managed entry must be swept by the .cmd install");
  assert.strictEqual(managedCount(after), 3, "exactly our entries remain");
}

// ── removal strips only our entries and restores the config ──────────────────
{
  const before: JsonObject = {
    model: "opus",
    hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "my-own-linter" }] }] },
  };
  const installed = applyNestedHooks(before, CMD, SCRIPT, EVENTS);
  const { config: removed, changed } = removeNestedHooks(installed, SCRIPT);
  assert.strictEqual(changed, true, "removal reports a change when our entries existed");
  assert.strictEqual(managedCount(removed), 0, "no managed entries after removal");
  const pre = (removed as any).hooks.PreToolUse as any[];
  assert.ok(pre.some((d) => d.hooks?.[0]?.command === "my-own-linter"), "user hook survives our removal");
  assert.strictEqual((removed as any).model, "opus", "unrelated keys survive removal");

  const { changed: changedAgain } = removeNestedHooks(removed, SCRIPT);
  assert.strictEqual(changedAgain, false, "removing again is a no-op");
}

// ── matcher only matches our script token ────────────────────────────────────
{
  const isManaged = makeManagedMatcher(SCRIPT);
  assert.ok(isManaged("C:\\Users\\u\\.tempest\\hooks\\tempest-claude-hook.cmd"), "matches windows path");
  assert.ok(isManaged("/home/u/.tempest/hooks/tempest-claude-hook.sh"), "matches posix path, any ext");
  assert.ok(!isManaged("claude-hook-of-mine"), "must not match an unrelated command");
  assert.ok(!isManaged(undefined), "undefined command is not managed");
}

// ── Claude event → state map ─────────────────────────────────────────────────
{
  const s = (body: unknown) => claudeAdapter.parse(body);
  assert.strictEqual(s({ hook_event_name: "UserPromptSubmit" }), "working");
  assert.strictEqual(s({ hook_event_name: "PreToolUse", tool_name: "Bash" }), "working");
  assert.strictEqual(s({ hook_event_name: "PostToolUse", tool_name: "Bash" }), "working");
  assert.strictEqual(s({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" }), "waiting", "AskUserQuestion blocks for a human");
  assert.strictEqual(s({ hook_event_name: "PermissionRequest", tool_name: "Bash" }), "waiting");
  assert.strictEqual(s({ hook_event_name: "Notification", notification_type: "permission_prompt" }), "waiting");
  assert.strictEqual(s({ hook_event_name: "Notification", message: "Claude needs your permission to use Bash" }), "waiting");
  assert.strictEqual(s({ hook_event_name: "Notification", message: "Compacting conversation" }), null, "generic notifications aren't a transition");
  assert.strictEqual(s({ hook_event_name: "Stop" }), "done");
  assert.strictEqual(s({ hook_event_name: "SomethingNew" }), null, "unknown events ignored");
  assert.strictEqual(s("not an object"), null, "non-object payload ignored");
}

// ── Claude adapter plan shape (posix) ────────────────────────────────────────
{
  const plan = claudeAdapter.plan({
    home: "/home/u",
    hooksDir: "/home/u/.tempest/hooks",
    endpointEnv: "/home/u/.tempest/hooks/endpoint.env",
    endpointCmd: "/home/u/.tempest/hooks/endpoint.cmd",
    windows: false,
  });
  assert.strictEqual(plan.configPath, "/home/u/.claude/settings.json");
  assert.strictEqual(plan.scriptFileName, "tempest-claude-hook.sh");
  assert.ok(plan.scriptExecutable, "posix script needs the exec bit");
  assert.ok(plan.scriptContent.includes("--data-binary @-"), "script forwards stdin payload");
  assert.ok(plan.scriptContent.includes("/hook/claude"), "script posts to the claude route");
  assert.ok(plan.managedCommand.includes("tempest-claude-hook.sh"), "command invokes our script");
}

console.log("agentHooks installer.check: all assertions passed");
