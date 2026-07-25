// Opencode hook adapter.
//
// Opencode auto-loads ESM plugins from ~/.config/opencode/plugin/. We drop a
// managed plugin that runs inside Opencode's process, listens to its event
// stream, and POSTs normalized lifecycle events to Tempest's server. Mirrors
// Orca's plugin mapping: session.status busy → SessionBusy, session.idle →
// SessionIdle, permission.asked → PermissionRequest, question.asked →
// AskUserQuestion, text parts → MessagePart. Opencode has real permission/ask
// signals → coversWaiting = true.

import type { AdapterInstall, HookAdapter, HookPaths, HookState } from "../types";
import { joinNative } from "../paths.ts";

const MARKER = "Managed by Tempest. Do not edit; changes may be overwritten.";
const REMOVED_STUB = `// ${MARKER} (removed)\nexport const TempestOpenCodeStatusPlugin = async () => ({});\n`;

function pluginSource(endpointEnv: string): string {
  return `// ${MARKER}
import { readFileSync } from "node:fs";

const ENDPOINT = ${JSON.stringify(endpointEnv)};

function coords() {
  let port = process.env.TEMPEST_HOOK_PORT;
  let token = process.env.TEMPEST_HOOK_TOKEN;
  try {
    for (const line of readFileSync(ENDPOINT, "utf8").split(/\\r?\\n/)) {
      const m = line.replace(/^set\\s+/, "").match(/^([A-Z_]+)=(.*)$/);
      if (!m) continue;
      if (m[1] === "TEMPEST_HOOK_PORT") port = m[2].replace(/\\r$/, "");
      if (m[1] === "TEMPEST_HOOK_TOKEN") token = m[2].replace(/\\r$/, "");
    }
  } catch {}
  return { port, token };
}

async function post(hookEventName) {
  const { port, token } = coords();
  const session = process.env.TEMPEST_SESSION;
  if (!port || !token || !session) return;
  try {
    await fetch("http://127.0.0.1:" + port + "/hook/opencode", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tempest-Token": token,
        "X-Tempest-Session": session,
      },
      body: JSON.stringify({ hook_event_name: hookEventName }),
    });
  } catch {}
}

let lastStatus = "";
async function setStatus(next) {
  if (lastStatus === next) return;
  lastStatus = next;
  await post(next === "busy" ? "SessionBusy" : "SessionIdle");
}

// Opencode may invoke the factory with undefined during startup; accept an opaque
// arg rather than destructuring so that can't throw.
export const TempestOpenCodeStatusPlugin = async (_ctx) => ({
  event: async ({ event }) => {
    if (!event || !event.type) return;
    if (event.type === "permission.asked") return void post("PermissionRequest");
    if (event.type === "question.asked") return void post("AskUserQuestion");
    if (event.type === "message.part.updated") {
      const part = event.properties && event.properties.part;
      if (part && part.type === "text" && part.text) await post("MessagePart");
      return;
    }
    if (event.type === "session.idle" || event.type === "session.error") return void setStatus("idle");
    if (event.type === "session.status") {
      const t = (event.properties && event.properties.status && event.properties.status.type) || (event.status && event.status.type);
      if (t === "busy" || t === "retry") await setStatus("busy");
      else if (t === "idle") await setStatus("idle");
    }
  },
});
`;
}

export const opencodeAdapter: HookAdapter = {
  id: "opencode",
  coversWaiting: true,

  plan(paths: HookPaths): AdapterInstall {
    const pluginPath = joinNative(paths.windows, paths.home, ".config", "opencode", "plugin", "tempest-status.js");
    const source = pluginSource(paths.endpointEnv);
    return {
      scripts: [],
      configs: [
        {
          path: pluginPath,
          apply: () => source,
          // Overwrite with a no-op plugin (we can't delete files from the engine).
          remove: (raw) => (raw === null || raw === REMOVED_STUB ? null : REMOVED_STUB),
        },
      ],
    };
  },

  parse(body: unknown): HookState | null {
    if (!body || typeof body !== "object") return null;
    const event = (body as Record<string, unknown>).hook_event_name;
    if (event === "SessionBusy" || event === "MessagePart") return "working";
    if (event === "SessionIdle") return "done";
    if (event === "PermissionRequest" || event === "AskUserQuestion") return "waiting";
    return null;
  },
};
