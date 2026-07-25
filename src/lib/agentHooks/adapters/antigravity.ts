// Antigravity hook adapter.
//
// Config: ~/.gemini/config/hooks.json (NOT the Gemini CLI settings file), under a
// dedicated bundle key so we never touch other hook bundles. Antigravity spawns
// the hook command as argv[0], so on Windows each event gets a wrapper .cmd that
// sets the event name in the environment and calls one core script; on posix the
// core is invoked with the event as an env prefix. The event reaches the server
// via X-Tempest-Event. Antigravity requires the hook to print a JSON object on
// stdout (`{"decision":""}` for Stop, else `{}`) or it stalls.
//
// We subscribe the observational events (PreInvocation/PostInvocation/Stop/
// PostToolUse) — NOT PreToolUse, whose hook gates tool permission and would let
// a status hook block the user. So there's no permission signal here:
// coversWaiting = false keeps the PTY attention path live.

import type { AdapterInstall, HookAdapter, HookPaths, HookState, JsonObject } from "../types";
import { wrapBarePathOrEncoded, wrapPosix } from "../wrappers.ts";
import { joinNative } from "../paths.ts";

const BUNDLE_KEY = "tempest-status";
const CORE_STEM = "tempest-antigravity-hook";
const EVENT_ENV = "TEMPEST_HOOK_EVENT";

interface AntigravityEvent {
  name: string;
  schema: "direct" | "tool";
  wrapper: string; // Windows per-event wrapper filename
}

const EVENTS: AntigravityEvent[] = [
  { name: "PreInvocation", schema: "direct", wrapper: "tempest-antigravity-pre-invocation.cmd" },
  { name: "PostInvocation", schema: "direct", wrapper: "tempest-antigravity-post-invocation.cmd" },
  { name: "Stop", schema: "direct", wrapper: "tempest-antigravity-stop.cmd" },
  { name: "PostToolUse", schema: "tool", wrapper: "tempest-antigravity-post-tool-use.cmd" },
];

const TIMEOUT_SECONDS = 10;

// Any Tempest-owned Antigravity command (core script or a per-event wrapper).
function isManaged(command: string | undefined): boolean {
  return !!command && command.replace(/\\/g, "/").includes("tempest-antigravity");
}

function coreScript(paths: HookPaths): string {
  if (paths.windows) {
    return [
      "@echo off",
      "setlocal",
      'if /I "%TEMPEST_HOOK_EVENT%"=="Stop" (echo {"decision":""}) else (echo {})',
      `if exist "${paths.endpointCmd}" call "${paths.endpointCmd}" >nul 2>nul`,
      `if "%TEMPEST_HOOK_PORT%"=="" exit /b 0`,
      `if "%TEMPEST_SESSION%"=="" exit /b 0`,
      `"%SystemRoot%\\System32\\curl.exe" -sS -X POST "http://127.0.0.1:%TEMPEST_HOOK_PORT%/hook/antigravity" --connect-timeout 0.5 --max-time 1.5 -H "X-Tempest-Token: %TEMPEST_HOOK_TOKEN%" -H "X-Tempest-Session: %TEMPEST_SESSION%" -H "X-Tempest-Event: %TEMPEST_HOOK_EVENT%" -H "Content-Type: application/json" --data-binary @- >nul 2>nul`,
      "exit /b 0",
      "",
    ].join("\r\n");
  }
  return [
    "#!/bin/sh",
    'if [ "$TEMPEST_HOOK_EVENT" = "Stop" ]; then printf \'{"decision":""}\\n\'; else printf \'{}\\n\'; fi',
    'if [ -r "' + paths.endpointEnv + '" ]; then . "' + paths.endpointEnv + '" 2>/dev/null || :; fi',
    'if [ -z "$TEMPEST_HOOK_PORT" ] || [ -z "$TEMPEST_SESSION" ]; then exit 0; fi',
    'curl -sS -X POST "http://127.0.0.1:${TEMPEST_HOOK_PORT}/hook/antigravity" \\',
    "  --connect-timeout 0.5 --max-time 1.5 \\",
    '  -H "X-Tempest-Token: ${TEMPEST_HOOK_TOKEN}" \\',
    '  -H "X-Tempest-Session: ${TEMPEST_SESSION}" \\',
    '  -H "X-Tempest-Event: ${TEMPEST_HOOK_EVENT}" \\',
    '  -H "Content-Type: application/json" \\',
    "  --data-binary @- >/dev/null 2>&1 || true",
    "exit 0",
    "",
  ].join("\n");
}

// Windows wrapper: set the event env, call the core; if the core is missing,
// still satisfy Antigravity's stdout contract so it never stalls.
function wrapperScript(event: string, coreFileName: string): string {
  return [
    "@echo off",
    "setlocal",
    `set "${EVENT_ENV}=${event}"`,
    `set "CORE=%~dp0${coreFileName}"`,
    'if exist "%CORE%" (',
    '  call "%CORE%"',
    "  exit /b 0",
    ")",
    'if /I "%' + EVENT_ENV + '%"=="Stop" (echo {"decision":""}) else (echo {})',
    "exit /b 0",
    "",
  ].join("\r\n");
}

interface HookDef {
  matcher?: string;
  command?: string;
  hooks?: { command?: string; [k: string]: unknown }[];
  [k: string]: unknown;
}

function defManaged(def: HookDef): boolean {
  return isManaged(def.command) || (Array.isArray(def.hooks) && def.hooks.some((h) => isManaged(h.command)));
}

export const antigravityAdapter: HookAdapter = {
  id: "antigravity",
  coversWaiting: false,

  plan(paths: HookPaths): AdapterInstall {
    const coreFileName = `${CORE_STEM}.${paths.windows ? "cmd" : "sh"}`;
    const corePath = joinNative(paths.windows, paths.hooksDir, coreFileName);

    const scripts = [{ path: corePath, content: coreScript(paths), executable: !paths.windows }];
    if (paths.windows) {
      for (const ev of EVENTS) {
        scripts.push({
          path: joinNative(true, paths.hooksDir, ev.wrapper),
          content: wrapperScript(ev.name, coreFileName),
          executable: false,
        });
      }
    }

    const commandFor = (ev: AntigravityEvent): string =>
      paths.windows
        ? wrapBarePathOrEncoded(joinNative(true, paths.hooksDir, ev.wrapper))
        : wrapPosix(corePath, { [EVENT_ENV]: ev.name });

    const defFor = (ev: AntigravityEvent): HookDef =>
      ev.schema === "tool"
        ? { matcher: "*", hooks: [{ type: "command", command: commandFor(ev), timeout: TIMEOUT_SECONDS }] }
        : { type: "command", command: commandFor(ev), timeout: TIMEOUT_SECONDS };

    const bundleOf = (config: JsonObject): Record<string, HookDef[]> => {
      const b = config[BUNDLE_KEY];
      return b && typeof b === "object" && !Array.isArray(b) ? { ...(b as Record<string, HookDef[]>) } : {};
    };
    const sweep = (bundle: Record<string, HookDef[]>): Record<string, HookDef[]> => {
      const next: Record<string, HookDef[]> = {};
      for (const [name, defs] of Object.entries(bundle)) {
        if (!Array.isArray(defs)) {
          next[name] = defs;
          continue;
        }
        const cleaned = defs.filter((d) => !defManaged(d));
        if (cleaned.length > 0) next[name] = cleaned;
      }
      return next;
    };

    return {
      scripts,
      configs: [
        {
          path: joinNative(paths.windows, paths.home, ".gemini", "config", "hooks.json"),
          apply: (raw) => {
            const config = parseObj(raw);
            if (config === null) return null;
            const bundle = sweep(bundleOf(config));
            for (const ev of EVENTS) bundle[ev.name] = [...(bundle[ev.name] ?? []), defFor(ev)];
            return serialize({ ...config, [BUNDLE_KEY]: bundle });
          },
          remove: (raw) => {
            if (raw === null || raw.trim() === "") return null;
            const config = parseObj(raw);
            if (config === null) return null;
            const before = config[BUNDLE_KEY];
            if (!before || typeof before !== "object") return null;
            const bundle = sweep(bundleOf(config));
            const next: JsonObject = { ...config };
            if (Object.keys(bundle).length === 0) delete next[BUNDLE_KEY];
            else next[BUNDLE_KEY] = bundle;
            const out = serialize(next);
            return out === serialize(config) ? null : out;
          },
        },
      ],
    };
  },

  parse(body: unknown): HookState | null {
    if (!body || typeof body !== "object") return null;
    const o = body as Record<string, unknown>;
    const event = o.hook_event_name;
    if (event === "Stop") {
      const fullyIdle = o.fullyIdle ?? o.fully_idle;
      return fullyIdle === false ? "working" : "done";
    }
    if (event === "PreInvocation" || event === "PostInvocation" || event === "PostToolUse") return "working";
    return null;
  },
};

function parseObj(raw: string | null): JsonObject | null {
  if (raw === null || raw.trim() === "") return {};
  try {
    const p = JSON.parse(raw);
    return p && typeof p === "object" && !Array.isArray(p) ? (p as JsonObject) : null;
  } catch {
    return null;
  }
}

function serialize(config: JsonObject): string {
  return JSON.stringify(config, null, 2) + "\n";
}
