import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { computeNextRunAt } from "../lib/automationSchedule";
import { getProjectPath } from "./sessions";
import { getAgent } from "../lib/agentRegistry";
import type { AgentConfig } from "../lib/agentManifest";
import { getSettings } from "./appSettings";

export interface Automation {
  id: string;
  projectId: string | null;
  name: string;
  agent: string;
  schedule: string;
  prompt: string;
  model: string | null;
  enabled: boolean;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  status: string;
  triggeredBy: string;
  createdAt?: string;
}

export interface PromptVersion {
  id: string;
  automationId: string;
  prompt: string;
  source: string;
  bucketAt: string;
  createdAt: string;
}

export interface CreateAutomationReq {
  projectId?: string;
  name: string;
  agent?: string;
  schedule?: string;
  prompt?: string;
  model?: string;
  nextRunAt?: string;
}

export interface UpdateAutomationReq {
  name?: string;
  agent?: string;
  schedule?: string;
  prompt?: string;
  model?: string; // "" clears the model override
  enabled?: boolean;
  nextRunAt?: string | null;
}

let _automations: Automation[] = [];
let _dispatchUnlisten: (() => void) | null = null;
let _doneUnlisten: (() => void) | null = null;
// Tracks the automationId + triggeredBy for each in-flight background run so the
// `automation:done` handler can attribute the exit-status upsert without another
// DB round-trip. Cleared as soon as the run completes.
const _runMeta = new Map<string, { automationId: string; triggeredBy: string }>();

export async function loadAutomations(projectId?: string): Promise<Automation[]> {
  _automations = await invoke<Automation[]>("list_automations", { projectId: projectId ?? null });
  if (!_dispatchUnlisten) {
    _dispatchUnlisten = await listen<string>("automation:dispatch", (ev) => {
      void _handleScheduledDispatch(ev.payload);
    });
  }
  if (!_doneUnlisten) {
    _doneUnlisten = await listen<{ runId: string; ok: boolean }>("automation:done", (ev) => {
      const { runId, ok } = ev.payload;
      const meta = _runMeta.get(runId);
      if (!meta) return;
      _runMeta.delete(runId);
      void upsertAutomationRun({
        id: runId,
        automationId: meta.automationId,
        status: ok ? "succeeded" : "failed",
        triggeredBy: meta.triggeredBy,
      });
    });
  }
  return _automations;
}

async function _handleScheduledDispatch(id: string) {
  const automation = _automations.find((a) => a.id === id);
  if (!automation) return;
  try {
    await runAutomationNow(automation, "scheduler");
  } catch {
    // runAutomationNow already recorded dispatch_failed; nothing more to do.
  }
  // Advance next_run_at regardless of dispatch outcome so a broken automation
  // doesn't get stuck re-firing on the next scheduler tick.
  const next = computeNextRunAt(automation.schedule);
  await invoke("update_automation", { id, req: { nextRunAt: next } });
  const idx = _automations.findIndex((a) => a.id === id);
  if (idx >= 0) _automations[idx] = { ..._automations[idx], nextRunAt: next };
}

/// Build the argv for a one-shot headless run. Uses the agent manifest's
/// `printArgs` (e.g. claude's `-p "{PROMPT}"`) so the prompt reaches the CLI
/// through the flag that's designed to receive it — not as a bare positional,
/// which several CLIs (claude included) treat as a project path.
function buildHeadlessArgs(cfg: AgentConfig, prompt: string, model?: string): string[] {
  const args: string[] = [];
  if (model && cfg.modelArgs) {
    for (const a of cfg.modelArgs) args.push(a.replace("{MODEL}", model));
  }
  if (cfg.autoApproveArgs && getSettings().autoApprove) {
    for (const a of cfg.autoApproveArgs) args.push(a);
  }
  for (const a of cfg.printArgs ?? []) args.push(a.replace("{PROMPT}", prompt));
  return args;
}

/// Dispatch an automation as a background subprocess. Never opens a tab or
/// PTY-backed session — automations are jobs. On spawn success the run is
/// marked `dispatched`; `automation:done` later flips it to `succeeded` /
/// `failed`. Throws only when spawn setup fails; the caller decides whether to
/// surface that (manual runs do; the scheduler swallows).
export async function runAutomationNow(a: Automation, triggeredBy: "manual" | "scheduler" = "manual"): Promise<void> {
  const runId = crypto.randomUUID();
  await upsertAutomationRun({ id: runId, automationId: a.id, status: "dispatching", triggeredBy });

  const cfg = getAgent(a.agent);
  if (!cfg?.printArgs) {
    await upsertAutomationRun({ id: runId, automationId: a.id, status: "dispatch_failed", triggeredBy });
    throw new Error(`${a.agent} does not support headless runs (no print/-p flag in its manifest).`);
  }

  // Project-scoped: cwd = project path (fails if the project isn't loaded).
  // Global: cwd = "" — Rust falls back to the user's home dir.
  let cwd = "";
  if (a.projectId) {
    const p = getProjectPath(a.projectId);
    if (!p) {
      await upsertAutomationRun({ id: runId, automationId: a.id, status: "dispatch_failed", triggeredBy });
      throw new Error("This automation's project isn't loaded — open it first.");
    }
    cwd = p;
  }

  const args = buildHeadlessArgs(cfg, a.prompt, a.model ?? undefined);
  _runMeta.set(runId, { automationId: a.id, triggeredBy });
  try {
    await invoke("run_automation_command", { runId, cwd, program: cfg.hint, args });
    await upsertAutomationRun({ id: runId, automationId: a.id, status: "dispatched", triggeredBy });
  } catch (e) {
    _runMeta.delete(runId);
    await upsertAutomationRun({ id: runId, automationId: a.id, status: "dispatch_failed", triggeredBy });
    throw e;
  }
}

export async function createAutomation(req: CreateAutomationReq): Promise<Automation> {
  const a = await invoke<Automation>("create_automation", { req });
  _automations = [..._automations, a];
  return a;
}

export async function updateAutomation(id: string, req: UpdateAutomationReq): Promise<Automation> {
  const a = await invoke<Automation>("update_automation", { id, req });
  _automations = _automations.map((x) => (x.id === id ? a : x));
  return a;
}

export async function deleteAutomation(id: string): Promise<void> {
  await invoke("delete_automation", { id });
  _automations = _automations.filter((x) => x.id !== id);
}

export async function listAutomationRuns(automationId: string): Promise<AutomationRun[]> {
  return invoke<AutomationRun[]>("list_automation_runs", { automationId });
}

export async function upsertAutomationRun(req: AutomationRun): Promise<AutomationRun> {
  return invoke<AutomationRun>("upsert_automation_run", { req });
}

export async function listPromptVersions(automationId: string): Promise<PromptVersion[]> {
  return invoke<PromptVersion[]>("list_prompt_versions", { automationId });
}

export async function savePromptVersion(req: {
  automationId: string;
  prompt: string;
  source?: string;
  bucketAt: string;
}): Promise<void> {
  return invoke("save_prompt_version", { req });
}
