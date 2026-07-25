// Codex CLI hook adapter.
//
// Two files under ~/.codex: hooks.json declares the hook (PascalCase event keys),
// and config.toml must trust each handler via a `[hooks.state."<key>"]` block or
// Codex silently skips it. We merge our managed hook LAST per event (preserving
// user hooks + their trust positions), record each event's group index, then
// write matching trust blocks with the reproduced trusted_hash. If the hash ever
// drifts from Codex's, Codex just ignores the hook and status falls back to PTY.
// Codex has PermissionRequest + auto-allowed request_user_input → coversWaiting.

import type { AdapterInstall, HookAdapter, HookPaths, JsonObject, HookState } from "../types";
import { applyJsonConfig, removeJsonConfig } from "../schema.ts";
import { wrapBarePathOrEncoded, wrapPosix } from "../wrappers.ts";
import { buildHookScript } from "../script.ts";
import { joinNative } from "../paths.ts";
import { CODEX_EVENT_LABEL, upsertTrustBlocks, removeTrustBlocks, type CodexTrustEntry } from "../codexTrust.ts";

// hooks.json event keys (PascalCase). Keep in sync with CODEX_EVENT_LABEL.
const CODEX_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop"] as const;
const SCRIPT_STEM = "tempest-codex-hook";
const TIMEOUT_SECONDS = 10;

const SNAKE_TO_PASCAL: Record<string, string> = Object.fromEntries(
  Object.entries(CODEX_EVENT_LABEL).map(([pascal, snake]) => [snake, pascal]),
);

interface HookDef {
  matcher?: string;
  command?: string;
  hooks?: { command?: string; [k: string]: unknown }[];
  [k: string]: unknown;
}

function isManaged(command: string | undefined): boolean {
  return !!command && command.replace(/\\/g, "/").includes(SCRIPT_STEM);
}

function defManaged(def: HookDef): boolean {
  return isManaged(def.command) || (Array.isArray(def.hooks) && def.hooks.some((h) => isManaged(h.command)));
}

function isAskUserQuestion(name: unknown): boolean {
  const n = typeof name === "string" ? name.trim().toLowerCase() : "";
  return n === "askuserquestion" || n === "request_user_input" || n === "requestuserinput";
}

export const codexAdapter: HookAdapter = {
  id: "codex",
  coversWaiting: true,

  plan(paths: HookPaths): AdapterInstall {
    const scriptFileName = `${SCRIPT_STEM}.${paths.windows ? "cmd" : "sh"}`;
    const scriptPath = joinNative(paths.windows, paths.hooksDir, scriptFileName);
    const command = paths.windows ? wrapBarePathOrEncoded(scriptPath) : wrapPosix(scriptPath);
    const hooksJsonPath = joinNative(paths.windows, paths.home, ".codex", "hooks.json");
    const configTomlPath = joinNative(paths.windows, paths.home, ".codex", "config.toml");

    // Filled by the hooks.json apply, read by the config.toml apply (the engine
    // runs the two edits in order). Keeps both files' positions consistent.
    const positions: Record<string, number> = {};

    const hooksApply = (config: JsonObject): JsonObject => {
      const prev = (config.hooks && typeof config.hooks === "object" ? config.hooks : {}) as Record<string, HookDef[]>;
      const nextHooks: Record<string, HookDef[]> = { ...prev };
      for (const ev of CODEX_EVENTS) {
        const current = Array.isArray(nextHooks[ev]) ? nextHooks[ev] : [];
        const cleaned = current.filter((d) => !defManaged(d));
        positions[ev] = cleaned.length; // appended last → this is our group index
        nextHooks[ev] = [...cleaned, { hooks: [{ type: "command", command, timeout: TIMEOUT_SECONDS }] }];
      }
      return { ...config, hooks: nextHooks };
    };
    const hooksRemove = (config: JsonObject): { config: JsonObject; changed: boolean } => {
      const prev = (config.hooks && typeof config.hooks === "object" ? config.hooks : null) as Record<string, HookDef[]> | null;
      if (!prev) return { config, changed: false };
      const nextHooks: Record<string, HookDef[]> = {};
      let changed = false;
      for (const [name, defs] of Object.entries(prev)) {
        if (!Array.isArray(defs)) {
          nextHooks[name] = defs;
          continue;
        }
        const cleaned = defs.filter((d) => !defManaged(d));
        if (cleaned.length !== defs.length) changed = true;
        if (cleaned.length > 0) nextHooks[name] = cleaned;
      }
      return { config: { ...config, hooks: nextHooks }, changed };
    };

    const trustEntries = (): CodexTrustEntry[] =>
      CODEX_EVENTS.map((ev) => ({
        sourcePath: hooksJsonPath,
        eventLabel: CODEX_EVENT_LABEL[ev],
        groupIndex: positions[ev] ?? 0,
        handlerIndex: 0,
        command,
        timeoutSec: TIMEOUT_SECONDS,
      }));

    return {
      scripts: [
        {
          path: scriptPath,
          content: buildHookScript({ route: "codex", endpointCmd: paths.endpointCmd, endpointEnv: paths.endpointEnv, windows: paths.windows }),
          executable: !paths.windows,
        },
      ],
      configs: [
        {
          path: hooksJsonPath,
          apply: (raw) => applyJsonConfig(raw, hooksApply),
          remove: (raw) => removeJsonConfig(raw, hooksRemove),
        },
        {
          path: configTomlPath,
          apply: (raw) => {
            // The hooks.json apply must have run first to fill positions; if it
            // bailed (malformed), don't write trust for a hook we didn't install.
            if (Object.keys(positions).length === 0) return null;
            const next = upsertTrustBlocks(raw ?? "", trustEntries());
            return next === (raw ?? "") ? null : next;
          },
          remove: (raw) => {
            if (raw === null) return null;
            const { content, changed } = removeTrustBlocks(raw, hooksJsonPath, new Set(Object.values(CODEX_EVENT_LABEL)));
            return changed ? content : null;
          },
        },
      ],
    };
  },

  parse(body: unknown): HookState | null {
    if (!body || typeof body !== "object") return null;
    const o = body as Record<string, unknown>;
    const rawEvent = o.hook_event_name;
    const event = typeof rawEvent === "string" ? SNAKE_TO_PASCAL[rawEvent] ?? rawEvent : rawEvent;
    const tool = o.tool_name ?? o.name;
    const isUserInput = event === "PreToolUse" && isAskUserQuestion(tool);
    if (event === "PermissionRequest" || isUserInput) return "waiting";
    if (event === "SessionStart" || event === "UserPromptSubmit" || event === "PreToolUse" || event === "PostToolUse") return "working";
    if (event === "Stop") return "done";
    return null;
  },
};
