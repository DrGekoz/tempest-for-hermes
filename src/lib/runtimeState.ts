import { dbLoadAppState, dbSetAppState } from "./db";
import type { AppSettings } from "../store/appSettings";
import type { ActionId, Shortcut } from "../store/keybindings";
import { EMPTY_AGENT_CONFIG, isEmptyAgentConfig, type PerAgentConfig } from "./agentConfig";
import type { RemotePatch } from "./agentManifest";

// App-global preferences. Persisted as a single JSON row in the `app_state`
// table (key = "runtime"). Entity collections (projects, sessions, branches,
// tabs, recents, chat) live in their own relational tables, not here.
export interface RuntimeState {
  settings: Partial<AppSettings>;
  keybindings: Partial<Record<ActionId, Shortcut | null>>;
  attribution: boolean;
  onboardingComplete: boolean;
  sessionOrder: string[];          // session ids in tab-bar order
  activeInstanceId: string | null; // id of the last focused session
  prompts: Array<{ id: string; title: string; body: string; enabled: boolean; isBuiltin: boolean }>;
  atlasProjects: Record<string, boolean>; // projectPath → indexed? (Token Intelligence decision)
  agentConfigs: Record<string, PerAgentConfig>; // agent id → per-agent launch defaults
  customAgents: RemotePatch[];    // user-added agents, merged over bundled+remote
  theme?: string;         // active theme name
  chatProvider?: string;  // last selected chat provider id
  chatModel?: string;     // last selected chat model id
}

const DEFAULT_STATE: RuntimeState = {
  settings: {},
  keybindings: {},
  attribution: false,
  onboardingComplete: false,
  sessionOrder: [],
  activeInstanceId: null,
  prompts: [],
  atlasProjects: {},
  agentConfigs: {},
  customAgents: [],
};

const KEY = "runtime";
let _state: RuntimeState = { ...DEFAULT_STATE };

export async function loadAppState(): Promise<void> {
  try {
    const rows = await dbLoadAppState();
    const raw = new Map(rows).get(KEY);
    if (raw) _state = { ...DEFAULT_STATE, ...(JSON.parse(raw) as Partial<RuntimeState>) };
  } catch (e) {
    console.error("[appState] load failed:", e);
  }
}

export function getRuntimeState(): RuntimeState {
  return _state;
}

export function setRuntimeState(patch: Partial<RuntimeState>): void {
  _state = { ..._state, ...patch };
  dbSetAppState(KEY, JSON.stringify(_state)).catch((e) => console.error("[appState] persist failed:", e));
}

// ── per-agent launch defaults (see agentConfig.ts) ───────────────────────────
// Synchronous accessors over the `agentConfigs` slice, co-located with the blob
// so the spawn path reads them without a DB round-trip. Kept here rather than in
// agentConfig.ts to keep that module store-free and node-testable.

/// This agent type's launch defaults. Always a complete object, so the spawn
/// path never has to branch on undefined.
export function getAgentConfig(agentId: string): PerAgentConfig {
  const stored = _state.agentConfigs[agentId];
  return stored ? { ...EMPTY_AGENT_CONFIG, ...stored } : EMPTY_AGENT_CONFIG;
}

/// Persist one agent type's config. An all-empty config drops the row entirely
/// so the blob doesn't accumulate `{}` entries for every agent ever expanded.
export function setAgentConfig(agentId: string, cfg: PerAgentConfig): void {
  const next = { ..._state.agentConfigs };
  if (isEmptyAgentConfig(cfg)) delete next[agentId];
  else next[agentId] = cfg;
  setRuntimeState({ agentConfigs: next });
}
