// Claude Code hook adapter.
//
// Claude runs hook commands through a shell (Git Bash on Windows), delivering the
// event as JSON on the hook's stdin. We register a managed script on the events
// that bound a turn, a tool call, or a permission prompt; the script forwards the
// stdin payload to Tempest's loopback server tagged with the session id we
// injected at spawn (`TEMPEST_SESSION`). Docs: docs.anthropic.com Claude Code hooks.

import type { AdapterInstall, HookAdapter, HookPaths, HookState, JsonObject } from "../types";
// Explicit .ts so the node self-check (installer.check.ts) can import this
// adapter directly; the bundler tsconfig allows importing .ts extensions.
import { applyNestedHooks, removeNestedHooks, type NestedEvent } from "../schema.ts";

// Tool-lifecycle events carry a "*" matcher; the rest are bare lifecycle events.
const CLAUDE_EVENTS: NestedEvent[] = [
  { name: "UserPromptSubmit" },
  { name: "PreToolUse", matcher: true },
  { name: "PostToolUse", matcher: true },
  // Newer Claude emits a dedicated PermissionRequest; older builds signal via
  // Notification. Subscribing both makes the "waiting" signal version-proof.
  { name: "PermissionRequest", matcher: true },
  { name: "Notification" },
  { name: "Stop" },
];

const SCRIPT_STEM = "tempest-claude-hook";

function fwd(p: string): string {
  return p.replace(/\\/g, "/");
}

function join(sep: string, ...parts: string[]): string {
  return parts.join(sep);
}

// Windows: Claude executes the command via Git Bash, which runs a forward-slash
// .cmd path directly. Posix: guard for a readable+executable file so a stale
// entry pointing at a deleted script is a silent no-op, not an exit-127 per turn.
function managedCommand(scriptPathNative: string, windows: boolean): string {
  if (windows) {
    const p = fwd(scriptPathNative);
    return `if [ -f '${p}' ]; then '${p}'; fi`;
  }
  const p = scriptPathNative;
  return `if [ -f '${p}' ] && [ -x '${p}' ]; then /bin/sh '${p}'; fi`;
}

function windowsScript(endpointCmdNative: string): string {
  // curl.exe (Win10 1803+) reads the hook payload from stdin via --data-binary @-.
  // Fully qualified so a repo-local curl.exe can't hijack the payload.
  return [
    "@echo off",
    "setlocal",
    `if exist "${endpointCmdNative}" call "${endpointCmdNative}" >nul 2>nul`,
    `if "%TEMPEST_HOOK_PORT%"=="" exit /b 0`,
    `if "%TEMPEST_SESSION%"=="" exit /b 0`,
    `"%SystemRoot%\\System32\\curl.exe" -sS -X POST "http://127.0.0.1:%TEMPEST_HOOK_PORT%/hook/claude" --connect-timeout 0.5 --max-time 1.5 -H "X-Tempest-Token: %TEMPEST_HOOK_TOKEN%" -H "X-Tempest-Session: %TEMPEST_SESSION%" -H "Content-Type: application/json" --data-binary @- >nul 2>nul`,
    "exit /b 0",
    "",
  ].join("\r\n");
}

function posixScript(endpointEnv: string): string {
  // Single-quoted lines keep the shell `$VAR` refs literal in the generated file.
  return [
    "#!/bin/sh",
    'if [ -r "' + endpointEnv + '" ]; then . "' + endpointEnv + '" 2>/dev/null || :; fi',
    'if [ -z "$TEMPEST_HOOK_PORT" ] || [ -z "$TEMPEST_SESSION" ]; then exit 0; fi',
    'curl -sS -X POST "http://127.0.0.1:${TEMPEST_HOOK_PORT}/hook/claude" \\',
    "  --connect-timeout 0.5 --max-time 1.5 \\",
    '  -H "X-Tempest-Token: ${TEMPEST_HOOK_TOKEN}" \\',
    '  -H "X-Tempest-Session: ${TEMPEST_SESSION}" \\',
    '  -H "Content-Type: application/json" \\',
    "  --data-binary @- >/dev/null 2>&1 || true",
    "exit 0",
    "",
  ].join("\n");
}

function readString(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === "string" ? v : undefined;
}

function isAskUserQuestion(toolName: string | undefined): boolean {
  return (toolName ?? "").trim().toLowerCase() === "askuserquestion";
}

export const claudeAdapter: HookAdapter = {
  id: "claude",

  plan(paths: HookPaths): AdapterInstall {
    const sep = paths.windows ? "\\" : "/";
    const scriptFileName = `${SCRIPT_STEM}.${paths.windows ? "cmd" : "sh"}`;
    const scriptPathNative = join(sep, paths.hooksDir, scriptFileName);
    const scriptContent = paths.windows
      ? windowsScript(paths.endpointCmd)
      : posixScript(paths.endpointEnv);
    const command = managedCommand(scriptPathNative, paths.windows);
    return {
      configPath: join(sep, paths.home, ".claude", "settings.json"),
      scriptFileName,
      scriptContent,
      scriptExecutable: !paths.windows,
      managedCommand: command,
      applyHooks: (config: JsonObject, cmd: string) =>
        applyNestedHooks(config, cmd, scriptFileName, CLAUDE_EVENTS),
      removeHooks: (config: JsonObject) => removeNestedHooks(config, scriptFileName),
    };
  },

  parse(body: unknown): HookState | null {
    if (!body || typeof body !== "object") return null;
    const o = body as Record<string, unknown>;
    const event = readString(o, "hook_event_name");
    const toolName = readString(o, "tool_name");
    switch (event) {
      case "UserPromptSubmit":
        return "working";
      case "PreToolUse":
        // Claude blocks on AskUserQuestion for a human answer — surface it as
        // "needs you", not a spinner that would decay to done.
        return isAskUserQuestion(toolName) ? "waiting" : "working";
      case "PostToolUse":
        return "working";
      case "PermissionRequest":
        return "waiting";
      case "Notification": {
        const nt = (readString(o, "notification_type") ?? readString(o, "notificationType") ?? "").toLowerCase();
        if (nt === "permission_prompt" || nt === "elicitation_dialog") return "waiting";
        const msg = (readString(o, "message") ?? "").toLowerCase();
        if (msg.includes("permission") || msg.includes("approve") || msg.includes("waiting for your input")) {
          return "waiting";
        }
        // Generic notifications (e.g. idle nudges) aren't a state transition.
        return null;
      }
      case "Stop":
        return "done";
      default:
        return null;
    }
  },
};
