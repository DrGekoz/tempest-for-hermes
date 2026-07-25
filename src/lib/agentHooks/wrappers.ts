// How each agent's config invokes the managed hook script. Agents don't all run
// hook commands through the same shell — Claude uses Git Bash on Windows, Gemini/
// Cursor run an arbitrary shell (so an encoded-PowerShell one-liner is safest),
// Antigravity/Codex spawn the command as argv[0] (so a bare path). Each wrapper
// also guards a missing script so a stale config entry is a silent no-op that
// still drains the agent's stdin payload, never an exit-127 on every turn.
//
// Ported from Orca's installer-utils (design, not code) — no Node Buffer, so
// base64 is done with browser-safe primitives that also work under `node`.

// Drains the agent's stdin payload so a missing script doesn't leave the write
// end blocking. `|| true` keeps a hook wrapper from tripping an outer set -e.
const POSIX_STDIN_DRAIN = "cat >/dev/null 2>&1 || true";

function sq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Claude: Git Bash executes a forward-slash .cmd/.sh path directly.
export function wrapGitBash(scriptPathFwd: string): string {
  const q = sq(scriptPathFwd);
  return `if [ -f ${q} ]; then ${q}; else ${POSIX_STDIN_DRAIN}; fi`;
}

// mac/linux: guard for a readable + executable file, run via /bin/sh. `env`
// entries are prefixed on the invocation (used to pass a per-event name).
export function wrapPosix(scriptPath: string, env: Record<string, string> = {}): string {
  const q = sq(scriptPath);
  const prefix = Object.entries(env)
    .map(([k, v]) => `${k}='${v.replace(/'/g, "'\\''")}' `)
    .join("");
  return `if [ -f ${q} ] && [ -x ${q} ]; then ${prefix}/bin/sh ${q}; else ${POSIX_STDIN_DRAIN}; fi`;
}

// A non-encoded PowerShell one-liner that sets env vars then runs the script.
// Used where an agent's config invokes the command AS PowerShell (Copilot's
// `powershell` hook field), so a nested encoded launcher would be wasteful.
export function wrapPowerShellInline(scriptPath: string, env: Record<string, string> = {}): string {
  const q = "'" + scriptPath.replace(/'/g, "''") + "'";
  const prefix = Object.entries(env)
    .map(([k, v]) => `$env:${k} = '${v.replace(/'/g, "''")}'; `)
    .join("");
  return `${prefix}if (Test-Path -LiteralPath ${q} -PathType Leaf) { & ${q} }`;
}

// Windows, shell-agnostic: an encoded PowerShell command runs whatever shell the
// agent uses to launch hooks, tests the path, and drains stdin when it's gone.
export function wrapEncodedPowerShell(scriptPath: string): string {
  const q = "'" + scriptPath.replace(/'/g, "''") + "'";
  const cmd = `if (Test-Path -LiteralPath ${q} -PathType Leaf) { & ${q}; exit $LASTEXITCODE }; [Console]::In.ReadToEnd() | Out-Null; exit 0`;
  const encoded = base64Utf16le(cmd);
  return `%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}

// Antigravity/Codex spawn the hook as argv[0], so the command must be one
// spawnable token — a bare path when it's shell-safe, else the encoded launcher.
const CMD_SAFE_PATH = /^[A-Za-z0-9_.:\\/~-]+$/;
export function wrapBarePathOrEncoded(scriptPath: string): string {
  return CMD_SAFE_PATH.test(scriptPath) ? scriptPath : wrapEncodedPowerShell(scriptPath);
}

// UTF-16LE → base64, for PowerShell -EncodedCommand. btoa exists in both the
// Tauri webview and node. Hook script paths are BMP, so charCodeAt is exact.
function base64Utf16le(s: string): string {
  let binary = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    binary += String.fromCharCode(c & 0xff, (c >> 8) & 0xff);
  }
  return btoa(binary);
}
