// Shared types for the agent-hooks subsystem.
//
// A hook adapter teaches Tempest how ONE agent's lifecycle hooks work: where its
// config lives, what the managed script/command look like, how to splice our
// entry into (and out of) that config without disturbing the user's own hooks,
// and how to map a received event onto the 3-state model. The install engine
// (`installer.ts`) and the runtime receiver (`../../store/agentHooks.ts`) are
// agent-agnostic and drive adapters through this interface.

// The canonical status a hook resolves to. "waiting" is our "needs you" state —
// the receiver maps it onto the existing `done` + attention pair.
export type HookState = "working" | "waiting" | "done";

export type JsonObject = Record<string, unknown>;

// Filesystem locations + platform, sourced from Rust (`hooks_paths` command).
export interface HookPaths {
  home: string;
  hooksDir: string;
  endpointEnv: string;
  endpointCmd: string;
  windows: boolean;
}

// A managed script/plugin file written into the shared hooks dir.
export interface ScriptFile {
  path: string;
  content: string;
  executable: boolean;
}

// One config file the adapter edits. `apply`/`remove` take the file's raw text
// (null when absent) and return the new text, or null to leave it untouched
// (malformed JSON, nothing to change, or "don't create on remove"). Raw text in
// and out lets a JSON adapter parse+merge while Codex byte-edits its TOML — both
// fit one engine.
export interface ConfigEdit {
  path: string;
  apply: (raw: string | null) => string | null;
  remove: (raw: string | null) => string | null;
}

// Everything an adapter produces for a single install, computed for the current
// platform. Pure data + pure functions so it is unit-testable off-device. An
// adapter may write several scripts (e.g. Antigravity's per-event wrappers) and
// touch several config files (e.g. Codex's hooks.json + config.toml).
export interface AdapterInstall {
  scripts: ScriptFile[];
  configs: ConfigEdit[];
}

export interface HookAdapter {
  // Manifest agent id (`AgentConfig.id`) AND the `/hook/<id>` route the script posts to.
  id: string;
  // True when this agent's hook set includes a permission/waiting event. When
  // false, hooks drive working/done but the PTY attention heuristics (title ✋,
  // OSC RequestAttention, BEL) stay live so the agent keeps a "needs you" signal.
  coversWaiting: boolean;
  // Build the install for the current platform/paths.
  plan: (paths: HookPaths) => AdapterInstall;
  // Map a parsed hook payload to a state, or null to ignore this event.
  parse: (body: unknown) => HookState | null;
}
