import { useEffect, useRef, useState } from "react";
import { dbLoadAppState, dbSetAppState } from "../../lib/db";
import { getAgents, useAgents } from "../../lib/agentRegistry";
import { clampSecurity, loadTempestConfig } from "../../lib/tempestConfig";

// Per-project settings blob. Persisted as a single JSON row in the `app_state`
// table (key = "project-settings:{projectId}"), same key/value pattern as
// runtimeState.ts. One row per project; a repo's `tempest.yml` is clamped over
// the top of it at load (see `clampSecurity` — the file may only tighten).
export interface ProjectSettings {
  sandbox: { mode: "off" | "monitor" | "enforce" };
  network: { policy: "permissive" | "restrictive"; allowHosts: string[]; blockHosts: string[] };
  filesystem: { rwPaths: string[]; roPaths: string[] };
  permissions: { allowSkipPermissions: boolean };
  agents: { permitted: string[] };
  database: { isolationEnabled: boolean };
  /// OS-level quotas per session. `null` leaves a limit at the OS default.
  resources: {
    maxMemoryMb: number | null;
    maxProcesses: number | null;
    maxDiskWriteMb: number | null;
    cpuWeight: number | null;
  };
}

// Defaults mirror each section's former local-useState initial values.
const DEFAULTS: ProjectSettings = {
  sandbox: { mode: "monitor" },
  network: { policy: "permissive", allowHosts: ["api.anthropic.com", "*.github.com"], blockHosts: [] },
  filesystem: { rwPaths: ["."], roPaths: [] },
  permissions: { allowSkipPermissions: true },
  agents: { permitted: getAgents().map((a) => a.hint) },
  database: { isolationEnabled: false },
  resources: { maxMemoryMb: null, maxProcesses: null, maxDiskWriteMb: null, cpuWeight: null },
};

const keyFor = (projectId: string) => `project-settings:${projectId}`;

// Shallow-merge each slice over defaults so a partial/old DB blob still yields
// complete slices (and picks up fields added to ProjectSettings later).
//
// A project with no stored agent list permits every CURRENT agent (the live
// manifest), so newly downloaded agents are permitted by default — exactly like
// a newly bundled one. Once a project stores an explicit list it owns it, so any
// agent can be deselected and the choice sticks. Every agent, bundled or
// downloaded, behaves identically here.
function withDefaults(p: Partial<ProjectSettings>): ProjectSettings {
  return {
    sandbox: { ...DEFAULTS.sandbox, ...p.sandbox },
    network: { ...DEFAULTS.network, ...p.network },
    filesystem: { ...DEFAULTS.filesystem, ...p.filesystem },
    permissions: { ...DEFAULTS.permissions, ...p.permissions },
    agents: { permitted: p.agents?.permitted ?? getAgents().map((a) => a.hint) },
    database: { ...DEFAULTS.database, ...p.database },
    resources: { ...DEFAULTS.resources, ...p.resources },
  };
}

/// Read a project's settings outside React.
///
/// The spawn path needs these before a PTY exists, where the hook cannot run.
/// Shares `keyFor` and `withDefaults` with the hook so both paths agree on
/// defaults — a project that has never opened the settings panel still gets a
/// complete, enforceable blob rather than `undefined`.
///
/// `projectPath` is optional only because callers that have no path on hand
/// still deserve the DB blob; pass it wherever it is known so the repo's
/// `tempest.yml` is honoured.
///
/// Never throws: a missing or corrupt row falls back to defaults, because
/// failing to parse settings must not stop a terminal from opening.
export async function loadProjectSettings(
  projectId: string,
  projectPath?: string,
): Promise<ProjectSettings> {
  try {
    const rows = await dbLoadAppState();
    const raw = new Map(rows).get(keyFor(projectId));
    const base = withDefaults(raw ? (JSON.parse(raw) as Partial<ProjectSettings>) : {});
    if (!projectPath) return base;
    const cfg = await loadTempestConfig(projectPath);
    return clampSecurity(base, cfg.security);
  } catch (e) {
    console.error("[projectSettings] load failed, using defaults:", e);
    return DEFAULTS;
  }
}

export function useProjectSettings(projectId: string, projectPath: string) {
  // `base` is the user's own settings — the only thing ever written back. The
  // repo's tempest.yml is clamped over it for display and enforcement but is
  // deliberately NOT persisted: baking the file's tightening into the DB row
  // would leave it stuck there after the file is edited or removed.
  const [base, setBase] = useState<ProjectSettings>(DEFAULTS);
  const [yml, setYml] = useState<Partial<ProjectSettings>>({});
  const loaded = useRef(false);
  useAgents(); // re-render if the downloaded manifest changes the agent list

  // Load from DB on mount (and whenever the project changes).
  useEffect(() => {
    loaded.current = false;
    let cancelled = false;
    (async () => {
      try {
        const rows = await dbLoadAppState();
        // ponytail: reads the whole app_state table to grab one row, exactly as
        // runtimeState.ts does. Add a single-key getter if the table gets large.
        const raw = new Map(rows).get(keyFor(projectId));
        const fromDb = raw ? (JSON.parse(raw) as Partial<ProjectSettings>) : {};
        const cfg = await loadTempestConfig(projectPath);
        if (!cancelled) {
          setBase(withDefaults(fromDb));
          setYml(cfg.security);
        }
      } catch (e) {
        console.error("[projectSettings] load failed:", e);
      } finally {
        if (!cancelled) loaded.current = true;
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, projectPath]);

  // Persist on every change once loaded. Writes are coarse (discrete toggles /
  // list adds), so no debounce.
  // ponytail: save-on-change, no debounce; add one if a section ever binds a
  //   text field straight to settings instead of local input state.
  useEffect(() => {
    if (!loaded.current) return;
    dbSetAppState(keyFor(projectId), JSON.stringify(base))
      .catch((e) => console.error("[projectSettings] persist failed:", e));
  }, [projectId, base]);

  // ponytail: the panel shows clamped values but edits write `base`, so a
  //   yml-pinned field appears to ignore the user. Add a read-only affordance
  //   once the sections need to distinguish the two.
  return [clampSecurity(base, yml), setBase] as const;
}
