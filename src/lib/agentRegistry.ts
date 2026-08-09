import { useSyncExternalStore } from "react";
import claudeCodeSrc from "../assets/agent-icons/claude-color.svg";
import geminiCliSrc from "../assets/agent-icons/geminicli-color.svg";
import githubCopilotSrc from "../assets/agent-icons/githubcopilot-color.svg";
import opencodeSrc from "../assets/agent-icons/opencode.svg";
import clineSrc from "../assets/agent-icons/cline.svg";
import cursorSrc from "../assets/agent-icons/cursor.svg";
import gooseSrc from "../assets/agent-icons/goose.svg";
import codexSrc from "../assets/agent-icons/codex.svg";
import antigravitySrc from "../assets/agent-icons/antigravity.svg";
import bundledManifest from "../../config/agents.json";
import { mergeAgents, sanitizeManifestAgents, sanitizeCachedPatches, sanitizeCustomAgents, type AgentConfig, type RemotePatch } from "./agentManifest";
import { getRuntimeState, setRuntimeState } from "./runtimeState";

// The agent registry — the single source of truth for which CLI agents Tempest
// can launch and how it builds their argv. There is no hardcoded agent list:
// `config/agents.json` is imported at build time as the always-present floor and
// re-downloaded (verified) at runtime to override it (see remoteAgents.ts).
//
// `AGENT_CONFIGS` is a LIVE binding: it starts as the built-in floor and is
// reassigned when the downloaded manifest lands, so every existing importer — the
// spawn path, arg builder, project-settings defaults, the menu — sees the current
// list at read time without being rewired. Reactive UI subscribes via `useAgents`.

export type { AgentConfig, RemotePatch, CaptureSpec } from "./agentManifest";

// Icon binaries must ship in the app so the built-in agents render instantly and
// offline. The manifest references them by key; new remote agents use an https
// `icon` URL instead (downloaded + cached).
const ICON_ASSETS: Record<string, string> = {
  agy: antigravitySrc,
  claude: claudeCodeSrc,
  cline: clineSrc,
  codex: codexSrc,
  copilot: githubCopilotSrc,
  cursor: cursorSrc,
  gemini: geminiCliSrc,
  goose: gooseSrc,
  opencode: opencodeSrc,
};

// Icons that aren't bundled are served from Tempest's OWN repo via jsDelivr —
// never a third-party host. A new agent commits its icon under config/agent-icons/
// and references it by filename (e.g. "amp.svg").
const REPO_ICON_BASE = "https://cdn.jsdelivr.net/gh/tempestai-dev/tempest@main/config/agent-icons/";

/// The download URL for an agent's icon, or undefined when it is a bundled asset
/// (or has no icon). Always points into the Tempest repo.
export function remoteIconUrl(icon: string | undefined): string | undefined {
  if (!icon || ICON_ASSETS[icon]) return undefined;
  return REPO_ICON_BASE + icon;
}

/// Resolve each agent's bundled-asset icon from its icon key. A repo-hosted icon
/// (no matching key) leaves `iconSrc` empty; AgentIcon then uses the cached
/// download or the repo URL.
function resolveIcons(list: AgentConfig[]): AgentConfig[] {
  return list.map((c) => ({
    ...c,
    iconSrc: (c.icon && ICON_ASSETS[c.icon]) || c.iconSrc,
  }));
}

// Built-in floor, parsed from the bundled manifest. Synchronous (a build-time
// import), so the full list exists before first paint — exactly like today.
export const BUNDLED_AGENTS: AgentConfig[] =
  resolveIcons(mergeAgents([], sanitizeManifestAgents((bundledManifest as { agents: unknown }).agents)));

// ── live registry ────────────────────────────────────────────────────────────
const REMOTE_KEY = "tempest-remote-agents";
const listeners = new Set<() => void>();

function loadCachedRemote(): RemotePatch[] {
  try {
    return sanitizeCachedPatches(JSON.parse(localStorage.getItem(REMOTE_KEY) ?? "null"));
  } catch {
    return [];
  }
}

let _remote: RemotePatch[] = loadCachedRemote();

/// User-added agents live in runtimeState, so a hot-reload of appState (which
/// runs after registry init) is reflected on the next build().
function loadCustom(): RemotePatch[] {
  return sanitizeCustomAgents(getRuntimeState().customAgents);
}

function build(): AgentConfig[] {
  // Custom agents are merged LAST so a user can override a bundled/remote entry
  // (e.g. point "claude" at a local wrapper script). Removing the custom entry
  // reveals the shipped one again.
  return resolveIcons(mergeAgents(mergeAgents(BUNDLED_AGENTS, _remote), loadCustom()));
}

export let AGENT_CONFIGS: AgentConfig[] = build();

function notify() {
  AGENT_CONFIGS = build();
  listeners.forEach((l) => l());
}

/// Trigger a registry rebuild + subscriber notify. Called by `main.tsx` once
/// `loadAppState` has hydrated `runtimeState.customAgents` — the initial
/// `AGENT_CONFIGS = build()` at module load ran with an empty runtime slot.
export function refreshAgentRegistry(): void {
  notify();
}

/// Apply a verified, sanitized downloaded manifest. Caches it for the next offline
/// start and re-renders subscribers.
export function applyRemoteAgents(remote: RemotePatch[]): void {
  _remote = remote;
  try {
    localStorage.setItem(REMOTE_KEY, JSON.stringify(remote));
  } catch {
    // Over quota / disabled — the in-memory list still applies this session.
  }
  notify();
}

export function getAgents(): AgentConfig[] {
  return AGENT_CONFIGS;
}

export function getAgent(hint: string): AgentConfig | undefined {
  return AGENT_CONFIGS.find((a) => a.hint === hint);
}

export function useAgents(): AgentConfig[] {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => AGENT_CONFIGS,
  );
}

// ── custom (user-added) agents ───────────────────────────────────────────────
// Persisted in runtimeState.customAgents. Written through here so the registry
// rebuild + subscriber notify happen atomically with the persist.

/// The raw persisted list — for the settings UI editor. Every entry has
/// `custom: true` (stamped by `sanitizeCustomAgent`).
export function getCustomAgents(): RemotePatch[] {
  return sanitizeCustomAgents(getRuntimeState().customAgents);
}

/// Persist a new custom list and rebuild the registry. The list is re-sanitized
/// on the way in so a bad entry from the UI can never reach a spawn.
export function setCustomAgents(list: RemotePatch[]): void {
  setRuntimeState({ customAgents: sanitizeCustomAgents(list) });
  notify();
}

// ── icon cache ───────────────────────────────────────────────────────────────
// Remote (https) icons are downloaded once and stored as data URLs so they
// survive offline starts. AgentIcon prefers the cached data URL, then a bundled
// asset, then the raw URL, then the Bot glyph.
const iconKey = (id: string) => `tempest-agent-icon:${id}`;

export function getIconDataUrl(id: string): string | undefined {
  try {
    return localStorage.getItem(iconKey(id)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function setIconDataUrl(id: string, dataUrl: string): void {
  try {
    localStorage.setItem(iconKey(id), dataUrl);
  } catch {
    // Non-fatal: the icon just won't persist; AgentIcon falls back live.
  }
  notify();
}
