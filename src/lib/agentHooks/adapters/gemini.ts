// Gemini CLI hook adapter.
//
// Config: ~/.gemini/settings.json, Claude-nested schema. Quirks vs Claude:
//  - Gemini's hook `timeout` unit is MILLISECONDS, not seconds.
//  - Gemini parses the hook's stdout as JSON, so the script must print `{}`.
//  - Gemini's tool events are BeforeTool/AfterTool (not Pre/PostToolUse), and it
//    has NO permission-prompt hook — approvals are inline UI. So working/done are
//    precise but "needs you" is NOT covered: coversWaiting = false keeps the PTY
//    attention heuristics (Gemini's ✋ title) live.

import type { AdapterInstall, HookAdapter, HookPaths, HookState } from "../types";
import { applyJsonConfig, applyNestedHooks, removeJsonConfig, removeNestedHooks, type NestedEvent } from "../schema.ts";
import { wrapEncodedPowerShell, wrapPosix } from "../wrappers.ts";
import { buildHookScript } from "../script.ts";
import { joinNative } from "../paths.ts";

// No matcher: Gemini emits a single managed entry per event bucket.
const GEMINI_EVENTS: NestedEvent[] = [
  { name: "BeforeAgent" },
  { name: "BeforeTool" },
  { name: "AfterTool" },
  { name: "AfterAgent" },
];

const GEMINI_TIMEOUT_MS = 10_000;
const SCRIPT_STEM = "tempest-gemini-hook";

export const geminiAdapter: HookAdapter = {
  id: "gemini",
  // No permission event in Gemini's hook set — keep the title/OSC attention path.
  coversWaiting: false,

  plan(paths: HookPaths): AdapterInstall {
    const scriptFileName = `${SCRIPT_STEM}.${paths.windows ? "cmd" : "sh"}`;
    const scriptPath = joinNative(paths.windows, paths.hooksDir, scriptFileName);
    const scriptContent = buildHookScript({
      route: "gemini",
      endpointCmd: paths.endpointCmd,
      endpointEnv: paths.endpointEnv,
      windows: paths.windows,
      emitEmptyJson: true,
    });
    // Gemini runs the hook command through an unspecified shell; the encoded
    // PowerShell launcher runs it reliably on Windows.
    const command = paths.windows ? wrapEncodedPowerShell(scriptPath) : wrapPosix(scriptPath);
    return {
      scripts: [{ path: scriptPath, content: scriptContent, executable: !paths.windows }],
      configs: [
        {
          path: joinNative(paths.windows, paths.home, ".gemini", "settings.json"),
          apply: (raw) =>
            applyJsonConfig(raw, (c) => applyNestedHooks(c, command, scriptFileName, GEMINI_EVENTS, GEMINI_TIMEOUT_MS)),
          remove: (raw) => removeJsonConfig(raw, (c) => removeNestedHooks(c, scriptFileName)),
        },
      ],
    };
  },

  parse(body: unknown): HookState | null {
    if (!body || typeof body !== "object") return null;
    const event = (body as Record<string, unknown>).hook_event_name;
    switch (event) {
      case "BeforeAgent":
      case "BeforeTool":
      case "AfterTool":
        return "working";
      case "AfterAgent":
        return "done";
      default:
        return null;
    }
  },
};
