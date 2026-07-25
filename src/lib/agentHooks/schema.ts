// Pure helpers for the "Claude-nested" hooks schema, shared by every adapter
// whose config stores hooks as:
//
//   { "hooks": { "<Event>": [ { "matcher"?: "*", "hooks": [ { "type": "command",
//                                                              "command": "…" } ] } ] } }
//
// (Claude, Gemini, Codex, Antigravity all use this shape.) Adapters with a
// different shape — Cursor's direct `command` on the definition, Copilot's
// per-event files — bring their own apply/remove and don't use this module.
//
// No React, no I/O: unit-testable on its own (see installer.check.ts).

import type { JsonObject } from "./types";

// A single event subscription. Tool events carry a matcher ("*" = all tools);
// lifecycle events (Stop, UserPromptSubmit, …) have none.
export interface NestedEvent {
  name: string;
  matcher?: boolean;
}

interface CommandHook {
  type: "command";
  command: string;
  timeout?: number;
  [k: string]: unknown;
}

interface HookDefinition {
  matcher?: string;
  command?: string;
  hooks?: CommandHook[];
  [k: string]: unknown;
}

// Host-side backstop: a status hook that can't reach a dead server must not stall
// the agent's turn. The script's own curl --max-time is the first line; this is
// the config-level ceiling.
const MANAGED_HOOK_TIMEOUT_SECONDS = 10;

// Match a config command by the managed script's *filename stem*, not an exact
// string, so a fresh install sweeps entries left by an older Tempest build or a
// platform switch (.cmd ⇄ .sh). Managed script names are `tempest-…-hook`, a
// token distinctive enough to never collide with a user's own hook command.
export function makeManagedMatcher(scriptFileName: string): (command: string | undefined) => boolean {
  const stem = scriptFileName.replace(/\.(?:cmd|ps1|sh)$/i, "");
  return (command) => {
    if (!command) return false;
    return command.replace(/\\/g, "/").includes(stem);
  };
}

function buildManagedHook(command: string): CommandHook {
  return { type: "command", command, timeout: MANAGED_HOOK_TIMEOUT_SECONDS };
}

function definitionHasManaged(
  def: HookDefinition,
  isManaged: (c: string | undefined) => boolean,
): boolean {
  if (isManaged(def.command)) return true;
  return Array.isArray(def.hooks) && def.hooks.some((h) => isManaged(h.command));
}

// Strip our managed command out of one event's definition list, dropping any
// definition left empty. Preserves the user's own hooks untouched.
function stripManaged(defs: HookDefinition[], isManaged: (c: string | undefined) => boolean): HookDefinition[] {
  const out: HookDefinition[] = [];
  for (const def of defs) {
    if (!definitionHasManaged(def, isManaged)) {
      out.push(def);
      continue;
    }
    const next: HookDefinition = { ...def };
    if (isManaged(next.command)) delete next.command;
    if (Array.isArray(next.hooks)) {
      const kept = next.hooks.filter((h) => !isManaged(h.command));
      if (kept.length > 0) next.hooks = kept;
      else delete next.hooks;
    }
    const stillHasSomething =
      typeof next.command === "string" || (Array.isArray(next.hooks) && next.hooks.length > 0);
    if (stillHasSomething) out.push(next);
  }
  return out;
}

// Splice our managed command into each subscribed event, first sweeping any
// prior Tempest entry so re-install is idempotent. Returns a new config; the
// input is not mutated. All non-hook keys and every user hook are preserved.
export function applyNestedHooks(
  config: JsonObject,
  command: string,
  scriptFileName: string,
  events: NestedEvent[],
): JsonObject {
  const isManaged = makeManagedMatcher(scriptFileName);
  const prevHooks = (config.hooks && typeof config.hooks === "object" ? config.hooks : {}) as Record<
    string,
    HookDefinition[]
  >;
  const nextHooks: Record<string, HookDefinition[]> = { ...prevHooks };
  for (const event of events) {
    const current = Array.isArray(nextHooks[event.name]) ? nextHooks[event.name] : [];
    const cleaned = stripManaged(current, isManaged);
    const def: HookDefinition = event.matcher
      ? { matcher: "*", hooks: [buildManagedHook(command)] }
      : { hooks: [buildManagedHook(command)] };
    nextHooks[event.name] = [...cleaned, def];
  }
  return { ...config, hooks: nextHooks };
}

// Remove every Tempest-owned entry across all event buckets, dropping buckets
// left empty. `changed` is false when nothing of ours was present.
export function removeNestedHooks(
  config: JsonObject,
  scriptFileName: string,
): { config: JsonObject; changed: boolean } {
  const isManaged = makeManagedMatcher(scriptFileName);
  const prevHooks = (config.hooks && typeof config.hooks === "object" ? config.hooks : null) as Record<
    string,
    HookDefinition[]
  > | null;
  if (!prevHooks) return { config, changed: false };
  const nextHooks: Record<string, HookDefinition[]> = {};
  let changed = false;
  for (const [name, defs] of Object.entries(prevHooks)) {
    if (!Array.isArray(defs)) {
      nextHooks[name] = defs;
      continue;
    }
    const cleaned = stripManaged(defs, isManaged);
    if (cleaned.length !== defs.length || JSON.stringify(cleaned) !== JSON.stringify(defs)) {
      changed = true;
    }
    if (cleaned.length > 0) nextHooks[name] = cleaned;
  }
  return { config: { ...config, hooks: nextHooks }, changed };
}
