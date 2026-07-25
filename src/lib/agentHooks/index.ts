// Agent-hooks registry + top-level (un)install. Add an agent by dropping its
// adapter in `adapters/` and listing it here — the engine, receiver, and Settings
// toggle need no further wiring.

import type { HookAdapter } from "./types";
import { claudeAdapter } from "./adapters/claude";
import { getHookPaths, installAdapter, uninstallAdapter, type InstallResult } from "./installer";

export type { HookAdapter, HookState } from "./types";
export { getHookPaths } from "./installer";

// Every hook-capable agent Tempest supports. Agents without a hook mechanism
// (cline, goose, pi) are absent by design — they stay on PTY-scraped status.
const ADAPTERS: HookAdapter[] = [claudeAdapter];

const BY_ID = new Map(ADAPTERS.map((a) => [a.id, a]));

export function getAdapter(id: string): HookAdapter | undefined {
  return BY_ID.get(id);
}

export function adapterIds(): string[] {
  return ADAPTERS.map((a) => a.id);
}

export async function installAll(): Promise<InstallResult[]> {
  const paths = await getHookPaths();
  return Promise.all(ADAPTERS.map((a) => installAdapter(a, paths)));
}

export async function uninstallAll(): Promise<InstallResult[]> {
  const paths = await getHookPaths();
  return Promise.all(ADAPTERS.map((a) => uninstallAdapter(a, paths)));
}
