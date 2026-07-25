// Pure types + validation/merge for the agent registry, kept free of React and
// asset imports so it is unit-testable on its own (see agentManifest.check.ts).
//
// `agents.json` is the single source of truth for every agent — the same file is
// imported at build time as the always-present floor AND re-downloaded (signed)
// at runtime to override it. This module turns manifest entries into the
// AgentConfig shape the rest of the app already consumes. It is the boundary an
// untrusted-until-verified manifest crosses before it can influence a spawn, so
// the parsing is defensive.

export interface CaptureSpec {
  /// Regex source that pulls a session id out of raw PTY output.
  pattern: string;
  /// Optional flags, restricted to the standard set.
  flags?: string;
  /// Resume args once the id is captured; "{UUID}" is substituted.
  resume?: string[];
}

export interface AgentConfig {
  /// Stable key (manifest `id`). Keys the icon cache and the merge-by-id.
  id: string;
  name: string;
  hint: string; // CLI command (may be multi-token, e.g. "gh copilot")
  /// Resolved bundled-asset URL, filled by the registry from the icon key. Empty
  /// when the icon is a remote URL (then `icon` holds it) or absent.
  iconSrc: string;
  /// Raw manifest icon reference: a bundled-asset key (e.g. "claude") or an https
  /// URL. The registry resolves keys to bundled assets; URLs are downloaded.
  icon?: string;
  mono?: boolean; // true = monochrome SVG; AgentIcon inverts it in dark mode
  // Args used the FIRST time an agent spawns. "{UUID}" → a freshly minted session
  // id so the exact conversation can be resumed. null when the agent has none.
  sessionIdArgs: string[] | null;
  // Args used when RESUMING. "{UUID}" → the stored conversation id. null when the
  // agent cannot be resumed by id (it manages sessions internally).
  resumeArgs: string[] | null;
  // Args carrying the chosen model. "{MODEL}" is substituted. null/absent when the
  // agent takes no model flag.
  modelArgs?: string[] | null;
  // For agents that mint their own session id and print it to PTY output (e.g.
  // opencode). Compiled by `mergeAgents` from a manifest `capture` spec; kept as a
  // RegExp because that is what the spawn path consumes.
  capturePattern?: RegExp;
  captureResumeArgs?: string[] | null;
  // CLI flags appended when the user's local Auto setting is on. The manifest
  // supplies only the syntax; agentArgs.ts decides application — a manifest can
  // never force Auto on.
  autoApproveArgs?: string[];
  // URL to download/install the agent when it isn't on PATH.
  downloadUrl?: string;
}

/// A validated manifest entry. It PATCHES an agent of the same id (so an override
/// keeps unspecified bundled fields) or defines a new one. Carries the capture
/// SPEC (serializable) rather than a compiled RegExp so it survives the cache.
export type RemotePatch = Partial<Omit<AgentConfig, "capturePattern">> & {
  id: string;
  name: string;
  hint: string;
  capture?: CaptureSpec;
};

// The `command` reaches a shell UNQUOTED in the spawn path (create_pty_session),
// so it must be a bare token — or a few space-separated tokens like "gh copilot"
// — with no shell metacharacters. Signing gates who can change the manifest; this
// stops an honest typo from becoming a shell injection.
export const CMD_RE = /^[A-Za-z0-9_.-]+( [A-Za-z0-9_.-]+)*$/;

const strList = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;

// Icon is a bare filename or key — a bundled-asset key (e.g. "claude") or a file
// committed to the Tempest repo (e.g. "amp.svg"). No scheme or slash, so an icon
// can never point at a third-party host: the registry resolves it to a bundled
// asset or a jsDelivr URL into Tempest's own repo.
const iconRef = (v: unknown): string | undefined =>
  typeof v === "string" && /^[a-z0-9._-]+$/i.test(v) ? v : undefined;

function captureSpec(v: unknown): CaptureSpec | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  // Cap the source length — a signed regex is trusted, but a bounded one can't
  // be a runaway either.
  if (typeof o.pattern !== "string" || o.pattern.length > 2000) return undefined;
  const spec: CaptureSpec = { pattern: o.pattern };
  if (typeof o.flags === "string" && /^[gimsuy]*$/.test(o.flags)) spec.flags = o.flags;
  const resume = strList(o.resume);
  if (resume) spec.resume = resume;
  return spec;
}

/// Compile a capture spec to a RegExp, or undefined if it doesn't compile.
function compileCapture(spec: CaptureSpec): RegExp | undefined {
  try {
    return new RegExp(spec.pattern, spec.flags ?? "");
  } catch {
    return undefined;
  }
}

/// Turn one untrusted manifest entry into a `RemotePatch`, or `null` if malformed
/// or asking for an unknown adapter. Only the generic "cli" adapter is accepted —
/// a new execution model needs a bundled adapter shipped via release.
function sanitizeEntry(a: unknown): RemotePatch | null {
  if (!a || typeof a !== "object") return null;
  const e = a as Record<string, unknown>;
  const { id, name, command } = e;
  if (typeof id !== "string" || typeof name !== "string" || typeof command !== "string") return null;
  if (!CMD_RE.test(command)) return null;
  if (e.adapter !== undefined && e.adapter !== "cli") return null;

  const f = (e.flags && typeof e.flags === "object" ? e.flags : {}) as Record<string, unknown>;
  const patch: RemotePatch = { id, name, hint: command };
  const icon = iconRef(e.icon);
  if (icon) patch.icon = icon;
  if (e.mono === true) patch.mono = true;
  const session = strList(f.session);
  if (session) patch.sessionIdArgs = session;
  const resume = strList(f.resume);
  if (resume) patch.resumeArgs = resume;
  const model = strList(f.model);
  if (model) patch.modelArgs = model;
  const autoApprove = strList(f.autoApprove);
  if (autoApprove) patch.autoApproveArgs = autoApprove;
  const dl = typeof e.downloadUrl === "string" && /^https:\/\//i.test(e.downloadUrl) ? e.downloadUrl : undefined;
  if (dl) patch.downloadUrl = dl;
  const capture = captureSpec(e.capture);
  if (capture) patch.capture = capture;
  return patch;
}

export function sanitizeManifestAgents(list: unknown): RemotePatch[] {
  if (!Array.isArray(list)) return [];
  return list.map(sanitizeEntry).filter((a): a is RemotePatch => a !== null);
}

/// Re-guard patches loaded from the local cache: identity + `hint` shape. Capture
/// stays as a spec (it round-trips as JSON; the RegExp is compiled at merge).
export function sanitizeCachedPatches(raw: unknown): RemotePatch[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a) => a && typeof a.id === "string" && typeof a.name === "string"
      && typeof a.hint === "string" && CMD_RE.test(a.hint))
    .map((a) => a as RemotePatch);
}

// Defaults for a brand-new agent (no base to inherit from).
const NEW_AGENT_DEFAULTS = {
  iconSrc: "",
  sessionIdArgs: null,
  resumeArgs: null,
  captureResumeArgs: null,
} as const;

/// Overlay patches onto a base list by id, compiling capture specs to RegExps.
/// A patch keeps the base's unspecified fields, so an override needn't re-supply
/// the icon or capture. Used both to build the bundled floor (base `[]`) and to
/// apply the downloaded manifest over it.
export function mergeAgents(base: AgentConfig[], patches: RemotePatch[]): AgentConfig[] {
  const byId = new Map<string, AgentConfig>(base.map((a) => [a.id, a]));
  for (const patch of patches) {
    const prev = byId.get(patch.id);
    const { capture, ...rest } = patch;
    const capturePattern = capture ? compileCapture(capture) : prev?.capturePattern;
    const captureResumeArgs = capture?.resume ?? prev?.captureResumeArgs ?? null;
    byId.set(patch.id, {
      ...(prev ?? NEW_AGENT_DEFAULTS),
      ...rest,
      capturePattern,
      captureResumeArgs,
    } as AgentConfig);
  }
  return [...byId.values()];
}

/// `a >= b` for dotted numeric versions (e.g. "0.1.6"). Non-numeric or missing
/// segments compare as 0, so "0.2" >= "0.1.9". Good enough to gate minAppVersion.
export function versionGte(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}
