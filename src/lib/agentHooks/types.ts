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

// Everything an adapter produces for a single install, computed for the current
// platform. Pure data + pure functions so it is unit-testable off-device.
export interface AdapterInstall {
  // Absolute path to the agent's own config file we merge into.
  configPath: string;
  // Bare filename of the managed script written into the shared hooks dir.
  scriptFileName: string;
  // Full script contents.
  scriptContent: string;
  // Whether the script needs the exec bit (posix).
  scriptExecutable: boolean;
  // The command string placed in the config that invokes the managed script.
  managedCommand: string;
  // Merge our managed command into a parsed config object (schema-specific).
  applyHooks: (config: JsonObject, command: string) => JsonObject;
  // Strip our managed command back out. `changed` lets the engine skip a no-op write.
  removeHooks: (config: JsonObject) => { config: JsonObject; changed: boolean };
}

export interface HookAdapter {
  // Manifest agent id (`AgentConfig.id`) AND the `/hook/<id>` route the script posts to.
  id: string;
  // Build the install for the current platform/paths.
  plan: (paths: HookPaths) => AdapterInstall;
  // Map a parsed hook payload to a state, or null to ignore this event.
  parse: (body: unknown) => HookState | null;
}
