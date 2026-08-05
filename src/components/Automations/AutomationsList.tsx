import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, Check, ExternalLink, Loader, Plus, Trash2, Workflow } from "lucide-react";
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
  project: StoredProject;
  onSelectProject: (id: string) => void;
  onOpen: (id: string, name: string) => void;
}

function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function AutomationsList({ projects, project, onSelectProject, onOpen }: Props) {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [processes, setProcesses] = useState<Record<string, ProcessInfo>>({});
  const [loading, setLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  async function load(projectId: string) {
    setLoading(true);
    try {
      const list = await invoke<Automation[]>("list_automations", { workspaceId: projectId });
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

  useEffect(() => { load(project.id); }, [project.id]);

  useEffect(() => {
    if (!pickerOpen) return;
    function onOut(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    }
    document.addEventListener("mousedown", onOut);
    return () => document.removeEventListener("mousedown", onOut);
  }, [pickerOpen]);

  useEffect(() => {
    if (creating) setTimeout(() => nameInputRef.current?.focus(), 0);
  }, [creating]);

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    setSaving(true);
    try {
      const a = await invoke<Automation>("create_automation", { workspaceId: project.id, name });
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
    if (p) return <span className="am-meta am-meta--running">running :{p.port}</span>;
    if (a.builtAt) return <span className="am-meta am-meta--built">built · {timeAgo(a.builtAt)}</span>;
    return <span className="am-meta am-meta--idle">never built</span>;
  }

  function badge(a: Automation) {
    const state = processes[a.id] ? "running" : a.builtAt ? "built" : "idle";
    return (
      <span className={`am-badge am-badge--${state}`}>
        {dot(a)}
        {meta(a)}
      </span>
    );
  }

  const deleteTarget = automations.find(a => a.id === deleteId);

  return (
    <div className="am-root">
      <div className="am-header">
        <div className="am-header-left">
          <h1 className="am-header-title">Automations</h1>
          {!loading && automations.length > 0 && (
            <span className="am-header-count">{automations.length}</span>
          )}
        </div>
        <div className="am-header-right">
          {projects.length > 1 && (
            <div className="am-picker" ref={pickerRef}>
              <button
                className={`am-picker-btn${pickerOpen ? " am-picker-btn--open" : ""}`}
                onClick={() => setPickerOpen(v => !v)}
              >
                <span className="am-picker-dot" />
                <span className="am-picker-label">{project.name}</span>
                <ChevronDown size={12} className="am-picker-chevron" />
              </button>
              {pickerOpen && (
                <div className="am-picker-menu">
                  {projects.map(p => (
                    <button
                      key={p.id}
                      className={`am-picker-item${p.id === project.id ? " am-picker-item--active" : ""}`}
                      onClick={() => { onSelectProject(p.id); setPickerOpen(false); }}
                    >
                      <span className="am-picker-item-check">
                        {p.id === project.id && <Check size={11} />}
                      </span>
                      <span className="am-picker-item-name">{p.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button className="am-new-btn" onClick={() => setCreating(true)}>
            <Plus size={14} />
            New Automation
          </button>
        </div>
      </div>

      <div className="am-list">
        {loading ? (
          <div className="am-loading">
            <Loader size={16} className="am-spin" />
          </div>
        ) : automations.length === 0 ? (
          <div className="am-empty">
            <div className="am-empty-art">
              <Workflow size={30} className="am-empty-icon" />
            </div>
            <p className="am-empty-text">No automations yet</p>
            <p className="am-empty-sub">Build and schedule AI agents that run on autopilot.</p>
            <button className="am-empty-cta" onClick={() => setCreating(true)}>
              <Plus size={14} />
              Create your first automation
            </button>
          </div>
        ) : (
          <div className="am-grid">
            {automations.map((a, i) => (
              <div
                key={a.id}
                className={`am-card${processes[a.id] ? " am-card--running" : ""}`}
                style={{ animationDelay: `${Math.min(i, 12) * 35}ms` }}
              >
                <div className="am-card-top">
                  <span className="am-card-glyph">
                    <Workflow size={14} />
                  </span>
                  {badge(a)}
                </div>

                <div className="am-card-body">
                  <span className="am-card-name" title={a.name}>{a.name}</span>
                  <span className="am-card-slug">{a.slug}</span>
                </div>

                <div className="am-card-actions">
                  <button className="am-act am-act--primary" onClick={() => onOpen(a.id, a.name)}>
                    <ExternalLink size={12} />
                    Open
                  </button>
                  {processes[a.id] && (
                    <button className="am-act" onClick={() => handleStop(a.id)}>Stop</button>
                  )}
                  <span className="am-card-actions-spacer" />
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
