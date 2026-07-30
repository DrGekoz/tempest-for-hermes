import { getAgent } from "./agentRegistry";
import { getSettings } from "../store/appSettings";
import { getAgentConfig } from "./runtimeState";

// The generic "cli" adapter: turn an agent's structured flags into an argv. Every
// bundled and remote agent runs through here — the only per-agent knowledge is
// the flag templates in the registry entry, not code.
//
// Placeholders substituted per flag group: "{UUID}" (session/conversation id) and
// "{MODEL}" (chosen model). The prompt is appended last as a positional arg.

export function buildAgentArgs(
  agent: string,
  sessionId: string,
  conversationId?: string,
  prompt?: string,
  model?: string,
): string[] {
  const config = getAgent(agent);
  const args: string[] = [];

  // Model flag is structured (modelArgs), so a new agent declares its own spelling
  // in the manifest rather than being added to a hardcoded list here.
  if (model && config?.modelArgs) {
    for (const arg of config.modelArgs) args.push(arg.replace("{MODEL}", model));
  }

  if (config && conversationId && config.resumeArgs) {
    for (const arg of config.resumeArgs) {
      args.push(arg.replace("{UUID}", conversationId));
    }
  } else if (config && conversationId && config.captureResumeArgs) {
    for (const arg of config.captureResumeArgs) {
      args.push(arg.replace("{UUID}", conversationId));
    }
  } else if (config && !conversationId && config.sessionIdArgs) {
    for (const arg of config.sessionIdArgs) {
      args.push(arg.replace("{UUID}", sessionId));
    }
  }

  // Auto-approve flags are applied ONLY when the user's local Auto setting is on.
  // The manifest supplies the flag syntax; this gate supplies the consent — a
  // manifest can never force Auto mode on.
  if (config?.autoApproveArgs && getSettings().autoApprove) {
    for (const arg of config.autoApproveArgs) {
      args.push(arg);
    }
  }

  // User-configured per-agent flags (global, applied to every launch of this
  // agent type). Appended after the structured flags, before the positional
  // prompt. Keyed by stable id so it survives an agent's CLI command changing.
  if (config) {
    for (const arg of getAgentConfig(config.id).args) args.push(arg);
  }

  if (prompt) args.push(prompt);
  return args;
}
