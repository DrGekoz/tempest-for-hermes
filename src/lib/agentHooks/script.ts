// Shared managed-hook script body. Every agent's script does the same thing —
// source the endpoint file for the current port/token, bail if unset, then POST
// the stdin payload to /hook/<route> tagged with $TEMPEST_SESSION — differing
// only in the route and whether the agent requires a JSON object on the hook's
// stdout (Gemini/Cursor parse it; Claude tolerates empty output).

export interface HookScriptOptions {
  route: string;
  endpointCmd: string; // Windows-native path to endpoint.cmd
  endpointEnv: string; // POSIX path to endpoint.env
  windows: boolean;
  // Emit `{}` to stdout first (agents that parse the hook's stdout as JSON).
  emitEmptyJson?: boolean;
  // Name of an env var holding the lifecycle event name, for agents whose
  // payload doesn't carry it (Antigravity, Copilot). Sent as X-Tempest-Event.
  eventEnvVar?: string;
}

export function buildHookScript(o: HookScriptOptions): string {
  return o.windows ? windows(o) : posix(o);
}

function windows(o: HookScriptOptions): string {
  const eventHeader = o.eventEnvVar ? ` -H "X-Tempest-Event: %${o.eventEnvVar}%"` : "";
  const lines = ["@echo off", "setlocal"];
  if (o.emitEmptyJson) lines.push("echo {}");
  lines.push(
    `if exist "${o.endpointCmd}" call "${o.endpointCmd}" >nul 2>nul`,
    `if "%TEMPEST_HOOK_PORT%"=="" exit /b 0`,
    `if "%TEMPEST_SESSION%"=="" exit /b 0`,
    // curl.exe (Win10 1803+) reads the payload from stdin via --data-binary @-,
    // fully qualified so a repo-local curl.exe can't hijack it.
    `"%SystemRoot%\\System32\\curl.exe" -sS -X POST "http://127.0.0.1:%TEMPEST_HOOK_PORT%/hook/${o.route}" --connect-timeout 0.5 --max-time 1.5 -H "X-Tempest-Token: %TEMPEST_HOOK_TOKEN%" -H "X-Tempest-Session: %TEMPEST_SESSION%"${eventHeader} -H "Content-Type: application/json" --data-binary @- >nul 2>nul`,
    "exit /b 0",
    "",
  );
  return lines.join("\r\n");
}

function posix(o: HookScriptOptions): string {
  const lines = ["#!/bin/sh"];
  if (o.emitEmptyJson) lines.push("printf '{}\\n'");
  // Single-quoted lines keep the shell `$VAR` refs literal in the generated file.
  lines.push(
    'if [ -r "' + o.endpointEnv + '" ]; then . "' + o.endpointEnv + '" 2>/dev/null || :; fi',
    'if [ -z "$TEMPEST_HOOK_PORT" ] || [ -z "$TEMPEST_SESSION" ]; then exit 0; fi',
    'curl -sS -X POST "http://127.0.0.1:${TEMPEST_HOOK_PORT}/hook/' + o.route + '" \\',
    "  --connect-timeout 0.5 --max-time 1.5 \\",
    '  -H "X-Tempest-Token: ${TEMPEST_HOOK_TOKEN}" \\',
    '  -H "X-Tempest-Session: ${TEMPEST_SESSION}" \\',
  );
  if (o.eventEnvVar) lines.push('  -H "X-Tempest-Event: ${' + o.eventEnvVar + '}" \\');
  lines.push(
    '  -H "Content-Type: application/json" \\',
    "  --data-binary @- >/dev/null 2>&1 || true",
    "exit 0",
    "",
  );
  return lines.join("\n");
}
