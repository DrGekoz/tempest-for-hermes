// Install engine — agent-agnostic. Drives a HookAdapter's pure plan through the
// Rust filesystem commands to (un)install its managed hooks, preserving the
// user's own config. Every write is atomic and idempotent; a config an adapter
// declines to edit (malformed, or nothing to change) is left untouched.

import { invoke } from "@tauri-apps/api/core";
import type { HookAdapter, HookPaths } from "./types";

export interface InstallResult {
  id: string;
  ok: boolean;
  changed: boolean;
  detail?: string;
}

let cachedPaths: HookPaths | null = null;

export async function getHookPaths(): Promise<HookPaths> {
  if (cachedPaths) return cachedPaths;
  const raw = await invoke<{
    home: string;
    hooks_dir: string;
    endpoint_env: string;
    endpoint_cmd: string;
    windows: boolean;
  }>("hooks_paths");
  cachedPaths = {
    home: raw.home,
    hooksDir: raw.hooks_dir,
    endpointEnv: raw.endpoint_env,
    endpointCmd: raw.endpoint_cmd,
    windows: raw.windows,
  };
  return cachedPaths;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await invoke<string>("read_file", { path });
  } catch {
    return null; // missing/unreadable → the adapter starts from a blank config
  }
}

async function writeAtomic(path: string, content: string, executable: boolean): Promise<void> {
  await invoke("hooks_write_atomic", { path, content, executable });
}

// Apply (or, with `mode: "remove"`, strip) one config edit: read raw, transform,
// and write atomically with a rolling .bak — but only when the text actually
// changes and the transform returned something (null = leave untouched).
async function editConfig(
  edit: { path: string; apply: (raw: string | null) => string | null; remove: (raw: string | null) => string | null },
  mode: "apply" | "remove",
): Promise<boolean> {
  const raw = await readText(edit.path);
  const next = mode === "apply" ? edit.apply(raw) : edit.remove(raw);
  if (next === null) return false;
  if (raw !== null && raw === next) return false;
  if (raw !== null && raw.trim().length > 0) {
    await writeAtomic(`${edit.path}.bak`, raw, false);
  }
  await writeAtomic(edit.path, next, false);
  return true;
}

export async function installAdapter(adapter: HookAdapter, paths: HookPaths): Promise<InstallResult> {
  try {
    const plan = adapter.plan(paths);
    // Scripts first: if a config pointed at a not-yet-written script, the agent
    // would exit-127 on every turn until the script landed.
    for (const s of plan.scripts) {
      await writeAtomic(s.path, s.content, s.executable);
    }
    let changed = false;
    for (const c of plan.configs) {
      if (await editConfig(c, "apply")) changed = true;
    }
    return { id: adapter.id, ok: true, changed };
  } catch (e) {
    return { id: adapter.id, ok: false, changed: false, detail: String(e) };
  }
}

export async function uninstallAdapter(adapter: HookAdapter, paths: HookPaths): Promise<InstallResult> {
  try {
    const plan = adapter.plan(paths);
    let changed = false;
    for (const c of plan.configs) {
      if (await editConfig(c, "remove")) changed = true;
    }
    // Managed scripts are left on disk (harmless once the config no longer
    // references them); only the config entries decide whether a hook fires.
    return { id: adapter.id, ok: true, changed };
  } catch (e) {
    return { id: adapter.id, ok: false, changed: false, detail: String(e) };
  }
}
