import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { computeNextRunAt } from "../lib/automationSchedule";

export interface Automation {
  id: string;
  projectId: string | null;
  name: string;
  agent: string;
  schedule: string;
  prompt: string;
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
  nextRunAt?: string;
}

export interface UpdateAutomationReq {
  name?: string;
  agent?: string;
  schedule?: string;
  prompt?: string;
  enabled?: boolean;
  nextRunAt?: string | null;
}

let _automations: Automation[] = [];
let _openSession: ((name: string, cwd: string, projectId: string, agent: string, prompt: string) => Promise<void>) | null = null;
let _dispatchUnlisten: (() => void) | null = null;

export function registerOpenSession(
  fn: (name: string, cwd: string, projectId: string, agent: string, prompt: string) => Promise<void>,
) {
  _openSession = fn;
}

export async function loadAutomations(projectId?: string): Promise<Automation[]> {
  _automations = await invoke<Automation[]>("list_automations", { projectId: projectId ?? null });
  if (!_dispatchUnlisten) {
    _dispatchUnlisten = await listen<string>("automation:dispatch", (ev) => {
      void _handleDispatch(ev.payload);
    });
  }
  return _automations;
}

async function _handleDispatch(id: string) {
  const automation = _automations.find((a) => a.id === id);
  if (!automation || !_openSession) return;

  const runId = crypto.randomUUID();
  await upsertAutomationRun({ id: runId, automationId: id, status: "dispatching", triggeredBy: "scheduler" });

  try {
    await _openSession(automation.name, "", automation.projectId ?? "", automation.agent, automation.prompt);
    await upsertAutomationRun({ id: runId, automationId: id, status: "dispatched", triggeredBy: "scheduler" });
  } catch {
    await upsertAutomationRun({ id: runId, automationId: id, status: "dispatch_failed", triggeredBy: "scheduler" });
  }

  // Advance next_run_at on the Rust side
  const next = computeNextRunAt(automation.schedule);
  await invoke("update_automation", { id, req: { nextRunAt: next } });
  // Update local cache
  const idx = _automations.findIndex((a) => a.id === id);
  if (idx >= 0) _automations[idx] = { ..._automations[idx], nextRunAt: next };
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
