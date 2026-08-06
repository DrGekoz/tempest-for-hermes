import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { ExternalLink, Globe, Loader, Plus, Trash2, Workflow } from "lucide-react";
import type { StoredProject } from "../../store/openProjects";
import { Tooltip } from "../Tooltip";

interface Automation {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  path: string;
  graph: string;
  sandboxMode: string;
  enabled: boolean;
  builtAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ProcessInfo {
  port: number;
  pid: number;
}

interface Props {
  projects: StoredProject[];
  scope: string | null;
  onSelectScope: (id: string | null) => void;
  onOpen: (id: string, name: string) => void;
}

function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function AutomationsList({ projects, scope, onSelectScope, onOpen }: Props) {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [processes, setProcesses] = useState<Record<string, ProcessInfo>>({});
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const tabsRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  async function load(projectId: string | null) {
    setLoading(true);
    try {
      // ponytail: Global scope returns empty until backend supports unbound automations
      const list = projectId
        ? await invoke<Automation[]>("list_automations", { workspaceId: projectId })
        : [];
      setAutomations(list);
      const pairs = await Promise.all(
        list.map(a =>
          invoke<ProcessInfo | null>("get_automation_process", { id: a.id })
            .then(p => [a.id, p] as const)
            .catch(() => [a.id, null] as const)
        )
      );
      const procs: Record<string, ProcessInfo> = {};
      for (const [id, p] of pairs) if (p) procs[id] = p;
      setProcesses(procs);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(scope); }, [scope]);

  useEffect(() => {
    if (creating) setTimeout(() => nameInputRef.current?.focus(), 0);
  }, [creating]);

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    if (!scope) return;
    setSaving(true);
    try {
      const a = await invoke<Automation>("create_automation", { workspaceId: scope, name });
      setAutomations(prev => [...prev, a]);
      setCreating(false);
      setNewName("");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteId) return;
    setDeleting(true);
    try {
      await invoke("delete_automation", { id: deleteId });
      setAutomations(prev => prev.filter(a => a.id !== deleteId));
      setProcesses(prev => { const next = { ...prev }; delete next[deleteId!]; return next; });
      setDeleteId(null);
    } finally {
      setDeleting(false);
    }
  }

  async function handleStop(id: string) {
    await invoke("stop_automation", { id }).catch(() => {});
    setProcesses(prev => { const next = { ...prev }; delete next[id]; return next; });
  }

  function dot(a: Automation) {
    if (processes[a.id]) return <span className="am-dot am-dot--running" />;
    if (a.builtAt) return <span className="am-dot am-dot--built" />;
    return <span className="am-dot am-dot--idle" />;
  }

  function meta(a: Automation) {
    const p = processes[a.id];
    if (p) return <span className="am-row-meta am-row-meta--running">running · :{p.port}</span>;
    if (a.builtAt) return <span className="am-row-meta">Built {timeAgo(a.builtAt)}</span>;
    return <span className="am-row-meta">Never built</span>;
  }

  const deleteTarget = automations.find(a => a.id === deleteId);

  return (
    <div className="am-root">
      <div className="am-header">
        <div className="am-header-left">
          <div className="am-header-titlerow">
            <h1 className="am-header-title">Automations</h1>
            {!loading && automations.length > 0 && (
              <span className="am-header-count">{automations.length}</span>
            )}
          </div>
          <p className="am-header-sub">Build and schedule AI agents that run on autopilot.</p>
        </div>
        <div className="am-header-right">
          <button
            className="am-new-btn"
            onClick={() => scope && setCreating(true)}
            disabled={!scope}
            title={scope ? "Create a new automation" : "Select a project first"}
          >
            <Plus size={14} />
            New Automation
          </button>
        </div>
      </div>

      <div className="am-tabs" ref={tabsRef} role="tablist">
        <button
          className={`am-tab${scope === null ? " am-tab--active" : ""}`}
          onClick={() => onSelectScope(null)}
          role="tab"
          aria-selected={scope === null}
        >
          <Globe size={13} className="am-tab-icon" />
          Global
        </button>
        {projects.map(p => (
          <button
            key={p.id}
            className={`am-tab${scope === p.id ? " am-tab--active" : ""}`}
            onClick={() => onSelectScope(p.id)}
            role="tab"
            aria-selected={scope === p.id}
            title={p.name}
          >
            <span className="am-tab-label">{p.name}</span>
          </button>
        ))}
      </div>

      <div className="am-list">
        {loading ? (
          <div className="am-loading">
            <Loader size={16} className="am-spin" />
          </div>
        ) : automations.length === 0 ? (
          <div className="am-empty">
            <Workflow size={22} className="am-empty-icon" />
            <p className="am-empty-text">No automations yet</p>
            <p className="am-empty-sub">Build and schedule AI agents that run on autopilot.</p>
            <button
              className="am-empty-cta"
              onClick={() => scope && setCreating(true)}
              disabled={!scope}
              title={scope ? "Create automation" : "Select a project first"}
            >
              <Plus size={14} />
              {scope ? "Create automation" : "Select a project"}
            </button>
          </div>
        ) : (
          <div className="am-rows">
            {automations.map((a, i) => (
              <div
                key={a.id}
                className="am-row"
                style={{ animationDelay: `${Math.min(i, 12) * 20}ms` }}
                onClick={() => onOpen(a.id, a.name)}
                role="button"
                tabIndex={0}
                onKeyDown={e => { if (e.key === "Enter") onOpen(a.id, a.name); }}
              >
                <span className="am-row-status">{dot(a)}</span>

                <div className="am-row-main">
                  <span className="am-row-name" title={a.name}>{a.name}</span>
                  <span className="am-row-slug">{a.slug}</span>
                </div>

                {meta(a)}

                <div className="am-row-actions" onClick={e => e.stopPropagation()}>
                  {processes[a.id] && (
                    <button className="am-act" onClick={() => handleStop(a.id)}>Stop</button>
                  )}
                  <button className="am-act" onClick={() => onOpen(a.id, a.name)}>
                    <ExternalLink size={12} />
                    Open
                  </button>
                  <Tooltip content="Delete" placement="top">
                    <button className="am-act am-act--icon am-act--danger" onClick={() => setDeleteId(a.id)}>
                      <Trash2 size={13} />
                    </button>
                  </Tooltip>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {creating && createPortal(
        <div className="naming-modal-overlay" onClick={() => !saving && (setCreating(false), setNewName(""))}>
          <div className="naming-modal" onClick={e => e.stopPropagation()}>
            <div className="naming-modal-header">
              <Workflow size={14} />
              <span>New automation</span>
            </div>
            <input
              ref={nameInputRef}
              className="naming-modal-input"
              placeholder="e.g. Daily Standup Bot"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") handleCreate();
                if (e.key === "Escape") { setCreating(false); setNewName(""); }
              }}
              disabled={saving}
            />
            <div className="naming-modal-actions">
              <button
                className="naming-modal-btn naming-modal-btn--cancel"
                onClick={() => { setCreating(false); setNewName(""); }}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                className="naming-modal-btn naming-modal-btn--create"
                onClick={handleCreate}
                disabled={saving || !newName.trim()}
              >
                {saving ? <Loader size={13} className="am-spin" /> : "Create"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {deleteId && createPortal(
        <div className="naming-modal-overlay" onClick={() => !deleting && setDeleteId(null)}>
          <div className="naming-modal" onClick={e => e.stopPropagation()}>
            <div className="naming-modal-header">
              <Trash2 size={14} />
              <span>Delete automation?</span>
            </div>
            <p className="naming-modal-desc">
              <strong>{deleteTarget?.name}</strong> will be permanently removed.
            </p>
            <div className="naming-modal-actions">
              <button
                className="naming-modal-btn naming-modal-btn--cancel"
                onClick={() => setDeleteId(null)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                className="naming-modal-btn naming-modal-btn--delete"
                onClick={handleDelete}
                disabled={deleting}
              >
                {deleting ? <Loader size={13} className="am-spin" /> : "Delete"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
