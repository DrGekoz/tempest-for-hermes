// Runtime receiver for agent lifecycle hooks.
//
// The Rust loopback server (src-tauri/src/agent_hooks.rs) forwards each hook POST
// as an `agent-hook` event carrying the agent id, the Tempest session id (echoed
// back from the TEMPEST_SESSION env we inject at spawn), and the raw agent
// payload. Here we parse it through the matching adapter and drive the existing
// 3-state model via sessionManager — which flips the session to hook-authoritative
// and retires its PTY-scraping heuristics.

import { listen } from "@tauri-apps/api/event";
import { sessionManager } from "./sessionManager";
import { getSettings } from "./appSettings";
import { getAdapter, installAll, uninstallAll } from "../lib/agentHooks";

interface AgentHookEvent {
  agent: string;
  session: string;
  event: string;
  body: string;
}

let started = false;

// Wire the receiver and, when precise status is enabled, install the managed
// hooks. Idempotent: safe to call once at app startup.
export async function startAgentHooks(): Promise<void> {
  if (started) return;
  started = true;

  await listen<AgentHookEvent>("agent-hook", (evt) => {
    const { agent, session, event, body } = evt.payload;
    const adapter = getAdapter(agent);
    if (!adapter) return;
    let parsed: unknown;
    try {
      parsed = body.trim().length > 0 ? JSON.parse(body) : {};
    } catch {
      // A malformed payload can't be a reliable state signal; ignore it and let
      // the next well-formed hook (or the fallback) speak.
      return;
    }
    // When the script conveyed the event out-of-band (X-Tempest-Event), fold it
    // into the payload so every adapter reads `hook_event_name` uniformly.
    if (event && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      if (rec.hook_event_name === undefined) rec.hook_event_name = event;
    }
    const state = adapter.parse(parsed);
    if (state) sessionManager.applyHookState(session, state, adapter.coversWaiting);
  });

  if (getSettings().preciseAgentStatus) {
    try {
      await installAll();
    } catch (e) {
      console.error("[agent-hooks] install failed", e);
    }
  }
}

// Toggle handler for the Settings switch: install or fully uninstall the managed
// hooks. Existing sessions stay hook-authoritative until they end (harmless); new
// sessions after an uninstall use the PTY heuristic.
export async function setPreciseAgentStatus(enabled: boolean): Promise<void> {
  try {
    await (enabled ? installAll() : uninstallAll());
  } catch (e) {
    console.error("[agent-hooks] toggle failed", e);
  }
}
