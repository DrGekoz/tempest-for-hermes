// Cursor Agent hook adapter.
//
// Config: ~/.cursor/hooks.json. Cursor's schema differs from Claude's: the
// command sits DIRECTLY on the definition (`{ command, timeout }`, not nested
// under `hooks`), and the file requires a top-level `version: 1`
// (https://cursor.com/docs/hooks). Cursor treats its shell/MCP pre-execution
// gates as ordinary work (not approval prompts), so it has no "waiting" event:
// coversWaiting = false keeps the PTY attention path live.

import type { AdapterInstall, HookAdapter, HookPaths, HookState, JsonObject } from "../types";
import { applyJsonConfig, makeManagedMatcher, removeJsonConfig } from "../schema.ts";
import { wrapEncodedPowerShell, wrapPosix } from "../wrappers.ts";
import { buildHookScript } from "../script.ts";
import { joinNative } from "../paths.ts";

const CURSOR_EVENTS = [
  "beforeSubmitPrompt",
  "stop",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "beforeShellExecution",
  "beforeMCPExecution",
  "afterAgentResponse",
] as const;

const SCRIPT_STEM = "tempest-cursor-hook";
const CURSOR_TIMEOUT_SECONDS = 10;

interface CursorDef {
  command?: string;
  hooks?: { command?: string }[];
  [k: string]: unknown;
}

function defManaged(def: CursorDef, isManaged: (c: string | undefined) => boolean): boolean {
  return isManaged(def.command) || (Array.isArray(def.hooks) && def.hooks.some((h) => isManaged(h.command)));
}

function applyCursorHooks(config: JsonObject, command: string, scriptFileName: string): JsonObject {
  const isManaged = makeManagedMatcher(scriptFileName);
  const prev = (config.hooks && typeof config.hooks === "object" ? config.hooks : {}) as Record<string, CursorDef[]>;
  const nextHooks: Record<string, CursorDef[]> = { ...prev };
  for (const ev of CURSOR_EVENTS) {
    const current = Array.isArray(nextHooks[ev]) ? nextHooks[ev] : [];
    const cleaned = current.filter((d) => !defManaged(d, isManaged));
    nextHooks[ev] = [...cleaned, { command, timeout: CURSOR_TIMEOUT_SECONDS }];
  }
  const next: JsonObject = { ...config, hooks: nextHooks };
  // Cursor's schema requires a top-level version; keep any user-pinned value.
  if (next.version === undefined) next.version = 1;
  return next;
}

function removeCursorHooks(config: JsonObject, scriptFileName: string): { config: JsonObject; changed: boolean } {
  const isManaged = makeManagedMatcher(scriptFileName);
  const prev = (config.hooks && typeof config.hooks === "object" ? config.hooks : null) as Record<string, CursorDef[]> | null;
  if (!prev) return { config, changed: false };
  const nextHooks: Record<string, CursorDef[]> = {};
  let changed = false;
  for (const [name, defs] of Object.entries(prev)) {
    if (!Array.isArray(defs)) {
      nextHooks[name] = defs;
      continue;
    }
    const cleaned = defs.filter((d) => !defManaged(d, isManaged));
    if (cleaned.length !== defs.length) changed = true;
    if (cleaned.length > 0) nextHooks[name] = cleaned;
  }
  return { config: { ...config, hooks: nextHooks }, changed };
}

export const cursorAdapter: HookAdapter = {
  id: "cursor",
  coversWaiting: false,

  plan(paths: HookPaths): AdapterInstall {
    const scriptFileName = `${SCRIPT_STEM}.${paths.windows ? "cmd" : "sh"}`;
    const scriptPath = joinNative(paths.windows, paths.hooksDir, scriptFileName);
    const scriptContent = buildHookScript({
      route: "cursor",
      endpointCmd: paths.endpointCmd,
      endpointEnv: paths.endpointEnv,
      windows: paths.windows,
      emitEmptyJson: true,
    });
    const command = paths.windows ? wrapEncodedPowerShell(scriptPath) : wrapPosix(scriptPath);
    return {
      scripts: [{ path: scriptPath, content: scriptContent, executable: !paths.windows }],
      configs: [
        {
          path: joinNative(paths.windows, paths.home, ".cursor", "hooks.json"),
          apply: (raw) => applyJsonConfig(raw, (c) => applyCursorHooks(c, command, scriptFileName)),
          remove: (raw) => removeJsonConfig(raw, (c) => removeCursorHooks(c, scriptFileName)),
        },
      ],
    };
  },

  parse(body: unknown): HookState | null {
    if (!body || typeof body !== "object") return null;
    const event = (body as Record<string, unknown>).hook_event_name ?? (body as Record<string, unknown>).hookEventName;
    if (event === "stop" || event === "sessionEnd") return "done";
    if (typeof event === "string" && (CURSOR_EVENTS as readonly string[]).includes(event)) return "working";
    return null;
  },
};
