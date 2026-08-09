import { getAgent } from "./agentRegistry";
import { getSettings } from "../store/appSettings";
import { getAgentConfig } from "./runtimeState";

// The generic "cli" adapter: turn an agent's structured flags into an argv. Every
// bundled and remote agent runs through here — the only per-agent knowledge is
// the flag templates in the registry entry, not code.
//
// Placeholders substituted in EVERY arg group (session, resume, model, capture,
// autoApprove, user args): "{UUID}", "{MODEL}", "{WORKSPACE_ID/NAME/SLUG/PATH}",
// "{BRANCH}", "{PORT}". Unknown placeholders pass through unchanged so a stray
// `{foo}` doesn't get mangled into empty. Case-insensitive keys — `{uuid}` and
// `{UUID}` both work — so user-authored args in the settings UI aren't sensitive
// to the exact spelling shown in placeholder chips.
//
// Custom, user-added agents rely on these placeholders to parameterize wrappers
// (e.g. `docker exec -w /work/{WORKSPACE_SLUG} ...`); the built-in agents only
// use {UUID}/{MODEL}, but there's no harm in the wider expansion running on
// their templates too — a template that doesn't reference a key is unaffected.

/// Slugify a workspace/session name into a safe token for paths, branches, and
/// display: lowercase alphanumerics + dashes, no leading/trailing/repeat dashes.
/// Empty input → "workspace" so a template never expands to nothing.
function slugify(s: string): string {
  const t = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return t || "workspace";
}

export interface AgentArgContext {
  sessionName?: string;
  cwd?: string;
  branch?: string;
  port?: number;
}

function expand(arg: string, vars: Record<string, string>): string {
  return arg.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, k) => {
    const v = vars[k] ?? vars[k.toLowerCase()] ?? vars[k.toUpperCase()];
    return v ?? m;
  });
}

function buildVars(
  sessionId: string,
  conversationId: string | undefined,
  model: string | undefined,
  ctx: AgentArgContext | undefined,
): Record<string, string> {
  const v: Record<string, string> = {
    UUID: conversationId ?? sessionId,
  };
  if (model) v.MODEL = model;
  const name = ctx?.sessionName;
  if (name) {
    v.WORKSPACE_NAME = name;
    v.WORKSPACE_SLUG = slugify(name);
  }
  if (sessionId) v.WORKSPACE_ID = sessionId;
  if (ctx?.cwd) v.WORKSPACE_PATH = ctx.cwd;
  if (ctx?.branch) v.BRANCH = ctx.branch;
  if (ctx?.port !== undefined) v.PORT = String(ctx.port);
  return v;
}

export function buildAgentArgs(
  agent: string,
  sessionId: string,
  conversationId?: string,
  prompt?: string,
  model?: string,
  ctx?: AgentArgContext,
): string[] {
  const config = getAgent(agent);
  const args: string[] = [];
  // The {UUID} slot depends on which resume mode fires — keep the id-scoped
  // vars local so each block sees the right one.
  const baseVars = buildVars(sessionId, conversationId, model, ctx);

  if (model && config?.modelArgs) {
    for (const arg of config.modelArgs) args.push(expand(arg, baseVars));
  }

  if (config && conversationId && config.resumeArgs) {
    const vars = { ...baseVars, UUID: conversationId };
    for (const arg of config.resumeArgs) args.push(expand(arg, vars));
  } else if (config && conversationId && config.captureResumeArgs) {
    const vars = { ...baseVars, UUID: conversationId };
    for (const arg of config.captureResumeArgs) args.push(expand(arg, vars));
  } else if (config && !conversationId && config.sessionIdArgs) {
    const vars = { ...baseVars, UUID: sessionId };
    for (const arg of config.sessionIdArgs) args.push(expand(arg, vars));
  }

  // Auto-approve flags are applied ONLY when the user's local Auto setting is on.
  // The manifest supplies the flag syntax; this gate supplies the consent — a
  // manifest can never force Auto mode on.
  if (config?.autoApproveArgs && getSettings().autoApprove) {
    for (const arg of config.autoApproveArgs) args.push(expand(arg, baseVars));
  }

  // User-configured per-agent flags (global, applied to every launch of this
  // agent type). Appended after the structured flags, before the positional
  // prompt. Keyed by stable id so it survives an agent's CLI command changing.
  if (config) {
    for (const arg of getAgentConfig(config.id).args) args.push(expand(arg, baseVars));
  }

  if (prompt) args.push(prompt);
  return args;
}
