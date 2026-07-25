// GitHub Copilot CLI hook adapter.
//
// Config: ~/.copilot/hooks/tempest.json. Copilot's schema puts the command on a
// `powershell` (Windows) or `bash` (posix) key of each definition, and a
// separate managed command is registered PER EVENT so the event name can be
// injected via env (Copilot's payload doesn't name the event). The event reaches
// the server through the X-Tempest-Event header the script sends from that env.
// Copilot has real permission signals (blocking Notification, AskUser tool) →
// coversWaiting = true.

import type { AdapterInstall, ConfigEdit, HookAdapter, HookPaths, HookState, JsonObject } from "../types";
import { applyJsonConfig, makeManagedMatcher, removeJsonConfig } from "../schema.ts";
import { wrapPosix, wrapPowerShellInline } from "../wrappers.ts";
import { buildHookScript } from "../script.ts";
import { joinNative } from "../paths.ts";

// Only events that map to a state (Copilot also emits subagent/compact events
// we don't model). Notification/PermissionRequest carry the "needs you" signal.
const COPILOT_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "ErrorOccurred",
  "PermissionRequest",
  "Notification",
] as const;

const SCRIPT_STEM = "tempest-copilot-hook";
const EVENT_ENV = "TEMPEST_HOOK_EVENT";

interface CopilotDef {
  command?: string;
  bash?: string;
  powershell?: string;
  hooks?: { command?: string }[];
  [k: string]: unknown;
}

function defManaged(def: CopilotDef, isManaged: (c: string | undefined) => boolean): boolean {
  return (
    isManaged(def.command) ||
    isManaged(def.bash) ||
    isManaged(def.powershell) ||
    (Array.isArray(def.hooks) && def.hooks.some((h) => isManaged(h.command)))
  );
}

function isAskUserTool(name: unknown): boolean {
  const n = typeof name === "string" ? name.trim().toLowerCase() : "";
  return n === "askuser" || n === "askuserquestion";
}

export const copilotAdapter: HookAdapter = {
  id: "copilot",
  coversWaiting: true,

  plan(paths: HookPaths): AdapterInstall {
    const scriptFileName = `${SCRIPT_STEM}.${paths.windows ? "cmd" : "sh"}`;
    const scriptPath = joinNative(paths.windows, paths.hooksDir, scriptFileName);
    const scriptContent = buildHookScript({
      route: "copilot",
      endpointCmd: paths.endpointCmd,
      endpointEnv: paths.endpointEnv,
      windows: paths.windows,
      emitEmptyJson: true,
      eventEnvVar: EVENT_ENV,
    });
    // Per-event command: inject the event name via env so the script reports it.
    const perEvent = (event: string): CopilotDef =>
      paths.windows
        ? { type: "command", powershell: wrapPowerShellInline(scriptPath, { [EVENT_ENV]: event }), timeoutSec: 5 }
        : { type: "command", bash: wrapPosix(scriptPath, { [EVENT_ENV]: event }), timeoutSec: 5 };
    const isManaged = makeManagedMatcher(scriptFileName);

    const apply = (config: JsonObject): JsonObject => {
      const prev = (config.hooks && typeof config.hooks === "object" ? config.hooks : {}) as Record<string, CopilotDef[]>;
      const nextHooks: Record<string, CopilotDef[]> = { ...prev };
      for (const ev of COPILOT_EVENTS) {
        const current = Array.isArray(nextHooks[ev]) ? nextHooks[ev] : [];
        const cleaned = current.filter((d) => !defManaged(d, isManaged));
        nextHooks[ev] = [...cleaned, perEvent(ev)];
      }
      return { ...config, hooks: nextHooks };
    };
    const remove = (config: JsonObject): { config: JsonObject; changed: boolean } => {
      const prev = (config.hooks && typeof config.hooks === "object" ? config.hooks : null) as Record<string, CopilotDef[]> | null;
      if (!prev) return { config, changed: false };
      const nextHooks: Record<string, CopilotDef[]> = {};
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
    };

    const config: ConfigEdit = {
      path: joinNative(paths.windows, paths.home, ".copilot", "hooks", "tempest.json"),
      apply: (raw) => applyJsonConfig(raw, apply),
      remove: (raw) => removeJsonConfig(raw, remove),
    };
    return { scripts: [{ path: scriptPath, content: scriptContent, executable: !paths.windows }], configs: [config] };
  },

  parse(body: unknown): HookState | null {
    if (!body || typeof body !== "object") return null;
    const o = body as Record<string, unknown>;
    const event = o.hook_event_name;
    const nt = (typeof o.notification_type === "string" ? o.notification_type : typeof o.notificationType === "string" ? o.notificationType : "").toLowerCase();
    if (event === "Notification") {
      return nt === "permission_prompt" || nt === "elicitation_dialog" ? "waiting" : null;
    }
    if (event === "PreToolUse" || event === "PermissionRequest") {
      return isAskUserTool(o.tool_name) ? "waiting" : "working";
    }
    if (event === "SessionStart" || event === "UserPromptSubmit" || event === "PostToolUse" || event === "PostToolUseFailure") {
      return "working";
    }
    if (event === "Stop" || event === "SessionEnd") return "done";
    if (event === "ErrorOccurred") return o.recoverable === true ? "working" : "done";
    return null;
  },
};
