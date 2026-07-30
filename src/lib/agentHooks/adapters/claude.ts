// Claude Code hook adapter.
//
// Claude runs hook commands through a shell (Git Bash on Windows), delivering the
// event as JSON on the hook's stdin. We register a managed script on the events
// that bound a turn, a tool call, or a permission prompt; the script forwards the
// stdin payload to Tempest's loopback server tagged with the session id we
// injected at spawn (`TEMPEST_SESSION`). Docs: docs.anthropic.com Claude Code hooks.

import type { AdapterInstall, HookAdapter, HookPaths, HookState } from "../types";
// Explicit .ts so the node self-check (installer.check.ts) can import this
// adapter directly; the bundler tsconfig allows importing .ts extensions.
import { applyJsonConfig, applyNestedHooks, removeJsonConfig, removeNestedHooks, type NestedEvent } from "../schema.ts";
import { wrapGitBash, wrapPosix } from "../wrappers.ts";
import { buildHookScript } from "../script.ts";

// Tool-lifecycle events carry a "*" matcher; the rest are bare lifecycle events.
const CLAUDE_EVENTS: NestedEvent[] = [
  { name: "UserPromptSubmit" },
  { name: "PreToolUse", matcher: true },
  { name: "PostToolUse", matcher: true },
  // Newer Claude emits a dedicated PermissionRequest; older builds signal via
  // Notification. Subscribing both makes the "waiting" signal version-proof.
  { name: "PermissionRequest", matcher: true },
  { name: "Notification" },
  { name: "Stop" },
];

const SCRIPT_STEM = "tempest-claude-hook";

function fwd(p: string): string {
  return p.replace(/\\/g, "/");
}

function join(sep: string, ...parts: string[]): string {
  return parts.join(sep);
}

function readString(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === "string" ? v : undefined;
}

function isAskUserQuestion(toolName: string | undefined): boolean {
  return (toolName ?? "").trim().toLowerCase() === "askuserquestion";
}

export const claudeAdapter: HookAdapter = {
  id: "claude",
  // Claude emits PermissionRequest / permission Notifications → full authority.
  coversWaiting: true,

  plan(paths: HookPaths): AdapterInstall {
    const sep = paths.windows ? "\\" : "/";
    const scriptFileName = `${SCRIPT_STEM}.${paths.windows ? "cmd" : "sh"}`;
    const scriptPathNative = join(sep, paths.hooksDir, scriptFileName);
    const scriptContent = buildHookScript({
      route: "claude",
      endpointCmd: paths.endpointCmd,
      endpointEnv: paths.endpointEnv,
      windows: paths.windows,
    });
    const command = paths.windows ? wrapGitBash(fwd(scriptPathNative)) : wrapPosix(scriptPathNative);
    return {
      scripts: [{ path: scriptPathNative, content: scriptContent, executable: !paths.windows }],
      configs: [
        {
          path: join(sep, paths.home, ".claude", "settings.json"),
          apply: (raw) => applyJsonConfig(raw, (c) => applyNestedHooks(c, command, scriptFileName, CLAUDE_EVENTS)),
          remove: (raw) => removeJsonConfig(raw, (c) => removeNestedHooks(c, scriptFileName)),
        },
      ],
    };
  },

  parse(body: unknown): HookState | null {
    if (!body || typeof body !== "object") return null;
    const o = body as Record<string, unknown>;
    const event = readString(o, "hook_event_name");
    const toolName = readString(o, "tool_name");
    switch (event) {
      case "UserPromptSubmit":
        return "working";
      case "PreToolUse":
        // Claude blocks on AskUserQuestion for a human answer — surface it as
        // "needs you", not a spinner that would decay to done.
        return isAskUserQuestion(toolName) ? "waiting" : "working";
      case "PostToolUse":
        return "working";
      case "PermissionRequest":
        return "waiting";
      case "Notification": {
        // Mirror orca: a Claude Notification is a "needs you" signal ONLY when it's
        // a typed permission/elicitation prompt (notification_type). Real waiting is
        // driven by PermissionRequest + AskUserQuestion above; orca doesn't even
        // register the Notification hook for Claude. The idle "…is waiting for your
        // input" nudge — fired after a turn ends when you haven't typed — is NOT a
        // permission prompt; matching it on the message string is what raised a
        // bogus bell on a completed response. So gate on notification_type alone
        // and ignore every other notification.
        const nt = (readString(o, "notification_type") ?? readString(o, "notificationType") ?? "").toLowerCase();
        if (nt === "permission_prompt" || nt === "elicitation_dialog") return "waiting";
        return null;
      }
      case "Stop":
        return "done";
      default:
        return null;
    }
  },
};
