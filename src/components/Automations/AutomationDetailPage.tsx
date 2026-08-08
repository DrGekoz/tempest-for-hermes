import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, Clock, Loader, Play, RotateCcw } from "lucide-react";
import {
  type Automation, type AutomationRun, type PromptVersion,
  updateAutomation, listAutomationRuns, upsertAutomationRun,
  listPromptVersions, savePromptVersion,
} from "../../store/automations";
import { SchedulePicker } from "./SchedulePicker";
import { promptBucketAt, computeNextRunAt, humanizeRrule } from "../../lib/automationSchedule";

interface Props {
  automation: Automation;
  onBack: () => void;
  onRunNow: (a: Automation) => void;
  onUpdate: (a: Automation) => void;
}

function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const AGENTS = ["claude-code", "claude", "gemini", "codex", "goose"];

export function AutomationDetailPage({ automation, onBack, onRunNow, onUpdate }: Props) {
  const [prompt, setPrompt] = useState(automation.prompt);
  const [schedule, setSchedule] = useState(automation.schedule);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [versions, setVersions] = useState<PromptVersion[]>([]);
  const [showVersions, setShowVersions] = useState(false);
  const [runningNow, setRunningNow] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    listAutomationRuns(automation.id).then(setRuns);
    listPromptVersions(automation.id).then(setVersions);
  }, [automation.id]);

  function scheduleDebounce(newPrompt: string, newSchedule: string) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const updated = await updateAutomation(automation.id, { prompt: newPrompt, schedule: newSchedule });
      onUpdate(updated);
      await savePromptVersion({ automationId: automation.id, prompt: newPrompt, bucketAt: promptBucketAt() });
      const fresh = await listPromptVersions(automation.id);
      setVersions(fresh);
    }, 800);
  }

  function handlePromptChange(v: string) {
    setPrompt(v);
    scheduleDebounce(v, schedule);
  }

  function handleScheduleChange(v: string) {
    setSchedule(v);
    scheduleDebounce(prompt, v);
    // Also update nextRunAt
    const next = computeNextRunAt(v);
    updateAutomation(automation.id, { schedule: v, nextRunAt: next }).then(onUpdate);
  }

  async function handleAgentChange(agent: string) {
    const updated = await updateAutomation(automation.id, { agent });
    onUpdate(updated);
  }

  async function handleRunNow() {
    setRunningNow(true);
    const runId = crypto.randomUUID();
    const run: AutomationRun = { id: runId, automationId: automation.id, status: "dispatching", triggeredBy: "manual" };
    await upsertAutomationRun(run);
    setRuns((prev) => [run, ...prev]);
    onRunNow(automation);
    await upsertAutomationRun({ ...run, status: "dispatched" });
    setRuns((prev) => prev.map((r) => r.id === runId ? { ...r, status: "dispatched" } : r));
    setRunningNow(false);
  }

  async function handleRestore(v: PromptVersion) {
    setPrompt(v.prompt);
    setShowVersions(false);
    await updateAutomation(automation.id, { prompt: v.prompt });
    await savePromptVersion({ automationId: automation.id, prompt: v.prompt, source: "restore", bucketAt: promptBucketAt() });
    const fresh = await listPromptVersions(automation.id);
    setVersions(fresh);
  }

  return (
    <div className="am-root">
      <div className="am-builder-topbar">
        <button className="am-back-btn" onClick={onBack}>
          <ChevronLeft size={14} />
          Automations
        </button>
        <span className="am-builder-sep">/</span>
        <span className="am-builder-name">{automation.name}</span>
        <div className="am-detail-topbar-actions">
          <button className="am-act" onClick={() => setShowVersions(true)} title="Version history">
            <Clock size={13} />
            History
          </button>
          <button
            className="am-act am-act--primary"
            onClick={() => void handleRunNow()}
            disabled={runningNow}
          >
            {runningNow ? <Loader size={13} className="am-spin" /> : <Play size={13} />}
            Run now
          </button>
        </div>
      </div>

      <div className="am-detail-layout">
        <div className="am-detail-main">
          <label className="am-field-label">Schedule</label>
          <SchedulePicker value={schedule} onChange={handleScheduleChange} />
          {schedule && (
            <span className="am-field-hint">{humanizeRrule(schedule)}</span>
          )}

          <label className="am-field-label" style={{ marginTop: 20 }}>Prompt</label>
          <textarea
            className="am-prompt-editor"
            value={prompt}
            onChange={(e) => handlePromptChange(e.target.value)}
            placeholder="What should the agent do each time this runs?"
            rows={12}
          />
        </div>

        <div className="am-detail-sidebar">
          <div className="am-sidebar-section">
            <div className="am-sidebar-label">Agent</div>
            <select
              className="am-field-select"
              value={automation.agent}
              onChange={(e) => void handleAgentChange(e.target.value)}
            >
              {AGENTS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>

          {automation.nextRunAt && (
            <div className="am-sidebar-section">
              <div className="am-sidebar-label">Next run</div>
              <div className="am-sidebar-value">{new Date(automation.nextRunAt).toLocaleString()}</div>
            </div>
          )}

          <div className="am-sidebar-section">
            <div className="am-sidebar-label">Recent runs</div>
            {runs.length === 0 ? (
              <div className="am-sidebar-empty">No runs yet</div>
            ) : (
              <div className="am-run-list">
                {runs.slice(0, 8).map((r) => (
                  <div key={r.id} className="am-run-item">
                    <span className={`am-run-badge am-run-badge--${r.status}`}>{r.status}</span>
                    <span className="am-run-meta">{r.createdAt ? timeAgo(r.createdAt) : ""}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {showVersions && createPortal(
        <div className="am-versions-overlay" onClick={() => setShowVersions(false)}>
          <div className="am-versions-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="am-versions-header">
              <RotateCcw size={14} />
              <span>Version history</span>
              <button className="am-versions-close" onClick={() => setShowVersions(false)}>✕</button>
            </div>
            <div className="am-versions-list">
              {versions.length === 0 ? (
                <div className="am-versions-empty">No saved versions yet</div>
              ) : versions.map((v) => (
                <div key={v.id} className="am-version-item">
                  <div className="am-version-meta">
                    <span className="am-version-bucket">{v.bucketAt}</span>
                    <span className="am-version-source">{v.source}</span>
                  </div>
                  <pre className="am-version-prompt">{v.prompt.slice(0, 120)}{v.prompt.length > 120 ? "…" : ""}</pre>
                  <button className="am-act" onClick={() => void handleRestore(v)}>Restore</button>
                </div>
              ))}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
