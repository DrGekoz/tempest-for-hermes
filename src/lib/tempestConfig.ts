import { invoke } from "@tauri-apps/api/core";
import { parse } from "yaml";
import type { ProjectSettings } from "../components/ProjectSettingsPanel/useProjectSettings";

// `tempest.yml` — per-project config committed to the repo.
//
// The file is checked in, so it arrives with the code: cloning a repo you do not
// own means running its config. Everything in `ProjectSettings` is therefore
// merged in the TIGHTENING direction only (see `clampSecurity`) — a repo can
// lock itself down further than the user's panel, never loosen it. Fields that
// are not privilege (instructions, env, preview) simply win.

export interface TempestConfig {
  security: Partial<ProjectSettings>;
  instructions?: string;
  env?: Record<string, string>;
  preview?: { port?: number };
  /// Human-readable notes about what was dropped during parse/clamp. Surfaced in
  /// the console so a config that silently does nothing is diagnosable.
  warnings: string[];
}

const EMPTY: TempestConfig = { security: {}, warnings: [] };

// ── env allow rules ──────────────────────────────────────────────────────────
// `env` writes straight into the agent's process environment, so a hostile repo
// could use it for code execution rather than configuration. Loader variables
// are the vector: they make an unrelated binary run repo-controlled code.
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_DENY = new Set([
  "PATH", "PATHEXT", "NODE_OPTIONS", "BUN_OPTIONS", "DENO_FLAGS",
  "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH",
  "PYTHONSTARTUP", "PYTHONPATH", "PERL5OPT", "RUBYOPT", "GEM_PATH",
  "PSModulePath", "COMSPEC", "SHELL", "IFS", "BASH_ENV", "ENV", "PROMPT_COMMAND",
  // DB isolation owns these; a repo must not redirect an isolated session at
  // some other database.
  "DATABASE_URL", "PGHOST", "PGPORT", "PGUSER", "PGDATABASE", "PGPASSWORD",
]);
const ENV_DENY_UPPER = new Set([...ENV_DENY].map((k) => k.toUpperCase()));

// ── shape helpers ────────────────────────────────────────────────────────────
// YAML is untyped, so every field is validated before it reaches settings —
// a mistyped key must be dropped, never coerced into something enforceable.
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const strList = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
const posInt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/// Assign only when `v` is defined, so an absent yml key means "no opinion"
/// rather than "reset to undefined".
function put<T extends object, K extends keyof T>(target: T, key: K, v: T[K] | undefined) {
  if (v !== undefined) target[key] = v;
}

// ── clamp ────────────────────────────────────────────────────────────────────
const MODE_RANK: Record<string, number> = { off: 0, monitor: 1, enforce: 2 };

/// Union — adding to a blocklist can only remove access.
const union = (base: string[], add: string[]) => [...new Set([...base, ...add])];
/// Intersection — a yml grant list can only *remove* entries from the user's.
const intersect = (base: string[], keep: string[]) => base.filter((x) => keep.includes(x));
/// Lower quota wins; `null` on either side means "no limit set" and defers.
const minQuota = (a: number | null, b: number | undefined) =>
  b === undefined ? a : a === null ? b : Math.min(a, b);

/// Merge yml security fields over the user's settings, in the tightening
/// direction only. `base` is the panel/DB value; `yml` is the repo's request.
export function clampSecurity(
  base: ProjectSettings,
  yml: Partial<ProjectSettings>,
): ProjectSettings {
  const out: ProjectSettings = {
    sandbox: { ...base.sandbox },
    network: { ...base.network },
    filesystem: { ...base.filesystem },
    permissions: { ...base.permissions },
    agents: { ...base.agents },
    database: { ...base.database },
    resources: { ...base.resources },
  };

  // Stricter sandbox mode wins.
  if (yml.sandbox?.mode && MODE_RANK[yml.sandbox.mode] > MODE_RANK[base.sandbox.mode]) {
    out.sandbox.mode = yml.sandbox.mode;
  }

  if (yml.network) {
    // restrictive is stricter than permissive; one-way only.
    if (yml.network.policy === "restrictive") out.network.policy = "restrictive";
    if (yml.network.blockHosts) out.network.blockHosts = union(base.network.blockHosts, yml.network.blockHosts);
    if (yml.network.allowHosts) out.network.allowHosts = intersect(base.network.allowHosts, yml.network.allowHosts);
  }

  if (yml.filesystem) {
    if (yml.filesystem.rwPaths) out.filesystem.rwPaths = intersect(base.filesystem.rwPaths, yml.filesystem.rwPaths);
    if (yml.filesystem.roPaths) out.filesystem.roPaths = intersect(base.filesystem.roPaths, yml.filesystem.roPaths);
  }

  // Only ever revokes the bypass.
  if (yml.permissions?.allowSkipPermissions === false) out.permissions.allowSkipPermissions = false;

  // Only ever removes agents from the permitted set.
  if (yml.agents?.permitted) out.agents.permitted = intersect(base.agents.permitted, yml.agents.permitted);

  // Isolation on is the safer state, so yml may switch it on but not off.
  if (yml.database?.isolationEnabled === true) out.database.isolationEnabled = true;

  if (yml.resources) {
    out.resources = {
      maxMemoryMb:    minQuota(base.resources.maxMemoryMb,    yml.resources.maxMemoryMb ?? undefined),
      maxProcesses:   minQuota(base.resources.maxProcesses,   yml.resources.maxProcesses ?? undefined),
      maxDiskWriteMb: minQuota(base.resources.maxDiskWriteMb, yml.resources.maxDiskWriteMb ?? undefined),
      // Lower CPU weight = smaller share, so min is the tightening direction too.
      cpuWeight:      minQuota(base.resources.cpuWeight,      yml.resources.cpuWeight ?? undefined),
    };
  }

  return out;
}

// ── parse ────────────────────────────────────────────────────────────────────
/// Turn raw yml text into a validated config. Never throws: a malformed file
/// degrades to "no config" plus a warning, because a typo in tempest.yml must
/// not stop a terminal from opening.
export function parseTempestConfig(text: string): TempestConfig {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    return { ...EMPTY, warnings: [`tempest.yml is not valid YAML: ${e}`] };
  }
  if (!isObj(doc)) return EMPTY;

  const warnings: string[] = [];
  const security: Partial<ProjectSettings> = {};

  if (isObj(doc.sandbox)) {
    const mode = str(doc.sandbox.mode);
    if (mode && mode in MODE_RANK) security.sandbox = { mode: mode as ProjectSettings["sandbox"]["mode"] };
    else if (mode) warnings.push(`sandbox.mode "${mode}" is not off/monitor/enforce — ignored.`);
  }

  if (isObj(doc.network)) {
    const n: Partial<ProjectSettings["network"]> = {};
    const policy = str(doc.network.policy);
    if (policy === "permissive" || policy === "restrictive") n.policy = policy;
    else if (policy) warnings.push(`network.policy "${policy}" is not permissive/restrictive — ignored.`);
    put(n, "allowHosts", strList(doc.network.allowHosts));
    put(n, "blockHosts", strList(doc.network.blockHosts));
    if (Object.keys(n).length) security.network = n as ProjectSettings["network"];
  }

  if (isObj(doc.filesystem)) {
    const f: Partial<ProjectSettings["filesystem"]> = {};
    put(f, "rwPaths", strList(doc.filesystem.rwPaths));
    put(f, "roPaths", strList(doc.filesystem.roPaths));
    if (Object.keys(f).length) security.filesystem = f as ProjectSettings["filesystem"];
  }

  if (isObj(doc.permissions)) {
    const b = bool(doc.permissions.allowSkipPermissions);
    if (b !== undefined) security.permissions = { allowSkipPermissions: b };
  }

  if (isObj(doc.agents)) {
    const p = strList(doc.agents.permitted);
    if (p) security.agents = { permitted: p };
  }

  if (isObj(doc.database)) {
    const b = bool(doc.database.isolationEnabled);
    if (b !== undefined) security.database = { isolationEnabled: b };
  }

  if (isObj(doc.resources)) {
    const r: Partial<ProjectSettings["resources"]> = {};
    put(r, "maxMemoryMb", posInt(doc.resources.maxMemoryMb));
    put(r, "maxProcesses", posInt(doc.resources.maxProcesses));
    put(r, "maxDiskWriteMb", posInt(doc.resources.maxDiskWriteMb));
    put(r, "cpuWeight", posInt(doc.resources.cpuWeight));
    if (Object.keys(r).length) security.resources = r as ProjectSettings["resources"];
  }

  const out: TempestConfig = { security, warnings };

  const instructions = str(doc.instructions);
  if (instructions?.trim()) out.instructions = instructions.trim();

  if (isObj(doc.env)) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(doc.env)) {
      // Numbers and booleans are ergonomic in yml but the environment is strings.
      const value = typeof v === "string" ? v
                  : typeof v === "number" || typeof v === "boolean" ? String(v)
                  : undefined;
      if (value === undefined) { warnings.push(`env.${k} is not a scalar — ignored.`); continue; }
      if (!ENV_NAME_RE.test(k)) { warnings.push(`env.${k} is not a valid variable name — ignored.`); continue; }
      if (ENV_DENY_UPPER.has(k.toUpperCase())) {
        warnings.push(`env.${k} is not settable from tempest.yml (loader or DB-isolation variable) — ignored.`);
        continue;
      }
      env[k] = value;
    }
    if (Object.keys(env).length) out.env = env;
  }

  if (isObj(doc.preview)) {
    const port = posInt(doc.preview.port);
    if (port !== undefined && port <= 65535) out.preview = { port };
    else if (doc.preview.port !== undefined) warnings.push(`preview.port must be 1-65535 — ignored.`);
  }

  return out;
}

// ── load ─────────────────────────────────────────────────────────────────────
/// Read and parse `tempest.yml` (or `.yaml`) from a project root.
///
/// Returns an empty config when the file is absent — the overwhelmingly common
/// case — so callers can merge unconditionally without a branch.
export async function loadTempestConfig(projectPath: string): Promise<TempestConfig> {
  if (!projectPath) return EMPTY;
  for (const name of ["tempest.yml", "tempest.yaml"]) {
    try {
      const text = await invoke<string>("read_file", { path: `${projectPath}/${name}` });
      const cfg = parseTempestConfig(text);
      for (const w of cfg.warnings) console.warn(`[tempest.yml] ${w}`);
      return cfg;
    } catch {
      // Missing file — try the next extension.
    }
  }
  return EMPTY;
}
