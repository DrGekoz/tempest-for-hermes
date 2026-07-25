// Install engine — agent-agnostic. Drives a HookAdapter's pure plan through the
// Rust filesystem commands to (un)install its managed hook, preserving the user's
// own config. Every write is atomic and idempotent; a malformed agent config is
// left untouched rather than clobbered.

import { invoke } from "@tauri-apps/api/core";
import type { HookAdapter, HookPaths, JsonObject } from "./types";

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

function scriptPathOf(paths: HookPaths, fileName: string): string {
  return paths.hooksDir + (paths.windows ? "\\" : "/") + fileName;
}

const SERIALIZE = (config: JsonObject) => JSON.stringify(config, null, 2) + "\n";

// Read + JSON-parse a config file. Returns `null` config when the file is absent
// (a fresh install starts from {}), or `{ malformed: true }` when it exists but
// isn't valid JSON — in which case the caller must NOT write, or it would drop
// the user's real (if currently broken) settings.
async function readConfig(path: string): Promise<{ text: string | null; config: JsonObject; malformed: boolean }> {
  let text: string | null = null;
  try {
    text = await invoke<string>("read_file", { path });
  } catch {
    // Missing/unreadable → treat as a new config.
    return { text: null, config: {}, malformed: false };
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) return { text, config: {}, malformed: false };
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { text, config: parsed as JsonObject, malformed: false };
    }
    return { text, config: {}, malformed: true };
  } catch {
    return { text, config: {}, malformed: true };
  }
}

async function writeAtomic(path: string, content: string, executable: boolean): Promise<void> {
  await invoke("hooks_write_atomic", { path, content, executable });
}

export async function installAdapter(adapter: HookAdapter, paths: HookPaths): Promise<InstallResult> {
  try {
    const plan = adapter.plan(paths);
    // Script first: if config were written first and this failed, the config
    // would point at a missing script (a per-turn exit-127 until repaired).
    await writeAtomic(scriptPathOf(paths, plan.scriptFileName), plan.scriptContent, plan.scriptExecutable);

    const { text, config, malformed } = await readConfig(plan.configPath);
    if (malformed) {
      return { id: adapter.id, ok: false, changed: false, detail: `${plan.configPath} is not valid JSON; left untouched` };
    }
    const nextConfig = plan.applyHooks(config, plan.managedCommand);
    const nextText = SERIALIZE(nextConfig);
    if (text !== null && text === nextText) {
      return { id: adapter.id, ok: true, changed: false };
    }
    // Rolling backup of the prior config before we overwrite it.
    if (text !== null && text.trim().length > 0) {
      await writeAtomic(`${plan.configPath}.bak`, text, false);
    }
    await writeAtomic(plan.configPath, nextText, false);
    return { id: adapter.id, ok: true, changed: true };
  } catch (e) {
    return { id: adapter.id, ok: false, changed: false, detail: String(e) };
  }
}

export async function uninstallAdapter(adapter: HookAdapter, paths: HookPaths): Promise<InstallResult> {
  try {
    const plan = adapter.plan(paths);
    const { text, config, malformed } = await readConfig(plan.configPath);
    if (malformed || text === null) {
      return { id: adapter.id, ok: true, changed: false };
    }
    const { config: nextConfig, changed } = plan.removeHooks(config);
    if (!changed) return { id: adapter.id, ok: true, changed: false };
    await writeAtomic(plan.configPath, SERIALIZE(nextConfig), false);
    return { id: adapter.id, ok: true, changed: true };
  } catch (e) {
    return { id: adapter.id, ok: false, changed: false, detail: String(e) };
  }
}
