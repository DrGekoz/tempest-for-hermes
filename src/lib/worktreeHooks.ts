import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { loadTempestConfig } from "./tempestConfig";

// `tempest.yml` worktree hooks — `setup` after a worktree is created, `teardown`
// before it is removed. A fresh worktree has no node_modules and none of the
// repo's ignored files, so this is where dependencies get installed and secrets
// copied across from the source checkout.
//
// These commands come from a file the repo carries, which means running them is
// running code the user may not have written. Consent is the caller's job (see
// `permissions.allowRepoHooks`); this module only reads and runs.

export type HookKind = "setup" | "teardown";

/// The commands a project's config declares for `kind`. Empty when there is no
/// config, no hook, or the file is malformed — callers can skip on `length`.
export async function getHookCommands(projectPath: string, kind: HookKind): Promise<string[]> {
  const cfg = await loadTempestConfig(projectPath);
  return cfg.hooks[kind];
}

/// Run `kind`'s commands in `cwd`, resolving only once every one has exited 0.
/// Rejects with the failing command and its last stderr line.
///
/// `onLine` receives stdout and stderr as they arrive, plus a `$ command` line
/// before each — enough for a modal to show what is happening during an install
/// that takes minutes.
export async function runHook(
  projectPath: string,
  kind: HookKind,
  cwd: string,
  onLine?: (line: string) => void,
): Promise<void> {
  const cfg = await loadTempestConfig(projectPath);
  const commands = cfg.hooks[kind];
  if (!commands.length) return;

  const token = crypto.randomUUID();
  const unlisten = await listen<string>(`hook:${token}`, (e) => onLine?.(e.payload));
  try {
    await invoke("run_hook", { token, cwd, commands, env: cfg.env ?? null });
  } finally {
    unlisten();
  }
}
