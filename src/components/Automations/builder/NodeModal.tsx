import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { Node } from "./graph";
import { nodeIcon, nodeLabel } from "./nodes";

interface Props {
  node: Node;
  onChange: (data: Node["data"]) => void;
  onClose: () => void;
  onDelete: () => void;
}

export function NodeModal({ node, onChange, onClose, onDelete }: Props) {
  const firstInputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    setTimeout(() => firstInputRef.current?.focus(), 0);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="am-modal-overlay" onClick={onClose}>
      <div className="am-modal" onClick={e => e.stopPropagation()}>
        <div className="am-modal-header">
          <span className="am-modal-title">
            <span className="am-modal-icon">{nodeIcon[node.kind]}</span>
            {nodeLabel[node.kind]}
          </span>
          <button className="am-modal-close" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <div className="am-modal-body">
          {renderBody(node, onChange, firstInputRef)}
        </div>
        <div className="am-modal-footer">
          <button className="am-modal-danger" onClick={onDelete}>Delete node</button>
          <button className="am-modal-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderBody(node: Node, onChange: (d: any) => void, firstRef: React.MutableRefObject<any>) {
  const set = <K extends keyof typeof node.data>(k: K, v: (typeof node.data)[K]) =>
    onChange({ ...node.data, [k]: v });

  if (node.kind === "trigger-manual") {
    const d = node.data;
    return (
      <label className="am-field">
        <span>Label</span>
        <input
          ref={firstRef}
          className="am-input"
          value={d.label || ""}
          onChange={e => set("label" as never, e.target.value as never)}
          placeholder="Start button"
        />
      </label>
    );
  }

  if (node.kind === "trigger-schedule") {
    const d = node.data;
    return (
      <>
        <label className="am-field">
          <span>Cron expression <span className="am-hint">(minute hour day month weekday · UTC)</span></span>
          <input
            ref={firstRef}
            className="am-input am-mono"
            value={d.cron || ""}
            onChange={e => set("cron" as never, e.target.value as never)}
            placeholder="0 9 * * 1-5"
          />
        </label>
        <label className="am-field">
          <span>Prompt <span className="am-hint">(what the agent runs each time)</span></span>
          <textarea
            className="am-textarea"
            value={d.prompt || ""}
            onChange={e => set("prompt" as never, e.target.value as never)}
            rows={4}
            placeholder="Pull open Linear issues and post a summary…"
          />
        </label>
      </>
    );
  }

  if (node.kind === "agent") {
    return <AgentTabs data={node.data} set={set as never} firstRef={firstRef} />;
  }

  if (node.kind === "tool") {
    const d = node.data;
    return (
      <>
        <label className="am-field">
          <span>Name <span className="am-hint">(filename slug the model sees)</span></span>
          <input
            ref={firstRef}
            className="am-input am-mono"
            value={d.name || ""}
            onChange={e => set("name" as never, e.target.value as never)}
            placeholder="get_weather"
          />
        </label>
        <label className="am-field">
          <span>Description <span className="am-hint">(written for the model)</span></span>
          <textarea
            className="am-textarea"
            value={d.description || ""}
            onChange={e => set("description" as never, e.target.value as never)}
            rows={2}
            placeholder="Get the current weather for a city."
          />
        </label>
        <label className="am-field">
          <span>Preset</span>
          <select
            className="am-input"
            value={d.preset || "custom"}
            onChange={e => set("preset" as never, e.target.value as never)}
          >
            <option value="http">HTTP request</option>
            <option value="custom">Custom (TypeScript)</option>
          </select>
        </label>
        {d.preset === "http" ? (
          <>
            <label className="am-field">
              <span>Method</span>
              <select
                className="am-input"
                value={d.httpMethod || "GET"}
                onChange={e => set("httpMethod" as never, e.target.value as never)}
              >
                {["GET", "POST", "PUT", "PATCH", "DELETE"].map(m => <option key={m}>{m}</option>)}
              </select>
            </label>
            <label className="am-field">
              <span>URL</span>
              <input
                className="am-input am-mono"
                value={d.httpUrl || ""}
                onChange={e => set("httpUrl" as never, e.target.value as never)}
                placeholder="https://api.example.com/v1/thing"
              />
            </label>
          </>
        ) : (
          <>
            <label className="am-field">
              <span>Input schema <span className="am-hint">(Zod)</span></span>
              <textarea
                className="am-textarea am-mono"
                value={d.customInputSchema || ""}
                onChange={e => set("customInputSchema" as never, e.target.value as never)}
                rows={3}
                placeholder="z.object({ query: z.string() })"
              />
            </label>
            <label className="am-field">
              <span>Execute body <span className="am-hint">(async execute(input, ctx))</span></span>
              <textarea
                className="am-textarea am-mono"
                value={d.customExecute || ""}
                onChange={e => set("customExecute" as never, e.target.value as never)}
                rows={8}
                placeholder="const res = await fetch(...);&#10;return { ok: true };"
              />
            </label>
          </>
        )}
      </>
    );
  }

  if (node.kind === "skill") {
    const d = node.data;
    return (
      <>
        <label className="am-field">
          <span>Name <span className="am-hint">(filename slug)</span></span>
          <input
            ref={firstRef}
            className="am-input am-mono"
            value={d.name || ""}
            onChange={e => set("name" as never, e.target.value as never)}
            placeholder="summarize"
          />
        </label>
        <label className="am-field">
          <span>Markdown <span className="am-hint">(loaded on-demand)</span></span>
          <textarea
            className="am-textarea am-mono"
            value={d.markdown || ""}
            onChange={e => set("markdown" as never, e.target.value as never)}
            rows={12}
            placeholder={"# Skill: summarize\n\n1. …\n2. …"}
          />
        </label>
      </>
    );
  }

  if (node.kind === "connection") {
    const d = node.data;
    return (
      <>
        <label className="am-field">
          <span>Name <span className="am-hint">(filename slug)</span></span>
          <input
            ref={firstRef}
            className="am-input am-mono"
            value={d.name || ""}
            onChange={e => set("name" as never, e.target.value as never)}
            placeholder="linear"
          />
        </label>
        <label className="am-field">
          <span>Type</span>
          <select
            className="am-input"
            value={d.kind || "mcp"}
            onChange={e => set("kind" as never, e.target.value as never)}
          >
            <option value="mcp">MCP server</option>
            <option value="openapi">OpenAPI spec</option>
          </select>
        </label>
        <label className="am-field">
          <span>URL</span>
          <input
            className="am-input am-mono"
            value={d.url || ""}
            onChange={e => set("url" as never, e.target.value as never)}
            placeholder="https://mcp.example.com"
          />
        </label>
      </>
    );
  }

  if (node.kind === "subagent") {
    const d = node.data;
    return (
      <>
        <label className="am-field">
          <span>Name <span className="am-hint">(directory slug)</span></span>
          <input
            ref={firstRef}
            className="am-input am-mono"
            value={d.name || ""}
            onChange={e => set("name" as never, e.target.value as never)}
            placeholder="researcher"
          />
        </label>
        <label className="am-field">
          <span>Model</span>
          <input
            className="am-input am-mono"
            value={d.model || ""}
            onChange={e => set("model" as never, e.target.value as never)}
            placeholder="anthropic/claude-sonnet-5"
          />
        </label>
        <label className="am-field">
          <span>Description <span className="am-hint">(required — parent uses this to decide when to delegate)</span></span>
          <textarea
            className="am-textarea"
            value={d.description || ""}
            onChange={e => set("description" as never, e.target.value as never)}
            rows={2}
            placeholder="Researches and returns a summary of open issues."
          />
        </label>
        <label className="am-field">
          <span>Instructions</span>
          <textarea
            className="am-textarea"
            value={d.instructions || ""}
            onChange={e => set("instructions" as never, e.target.value as never)}
            rows={8}
            placeholder="You are a research specialist. …"
          />
        </label>
      </>
    );
  }

  return null;
}

type Tab = "instructions" | "model" | "sandbox" | "limits";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function AgentTabs({ data, set, firstRef }: { data: any; set: (k: string, v: any) => void; firstRef: React.MutableRefObject<any> }) {
  const [tab, setTab] = useState<Tab>("instructions");
  const tabs: { id: Tab; label: string }[] = [
    { id: "instructions", label: "Instructions" },
    { id: "model", label: "Model" },
    { id: "sandbox", label: "Sandbox" },
    { id: "limits", label: "Limits" },
  ];
  return (
    <>
      <div className="am-tabs2">
        {tabs.map(t => (
          <button
            key={t.id}
            className={`am-tabs2-btn${tab === t.id ? " am-tabs2-btn--active" : ""}`}
            onClick={() => setTab(t.id)}
          >{t.label}</button>
        ))}
      </div>
      {tab === "instructions" && (
        <label className="am-field">
          <span>System prompt <span className="am-hint">(markdown)</span></span>
          <textarea
            ref={firstRef}
            className="am-textarea"
            value={data.instructions || ""}
            onChange={e => set("instructions", e.target.value)}
            rows={14}
            placeholder="You are a helpful assistant that…"
          />
        </label>
      )}
      {tab === "model" && (
        <>
          <label className="am-field">
            <span>Model <span className="am-hint">(gateway id or provider slug)</span></span>
            <input
              className="am-input am-mono"
              value={data.model || ""}
              onChange={e => set("model", e.target.value)}
              placeholder="anthropic/claude-sonnet-5"
            />
          </label>
          <label className="am-field">
            <span>Reasoning</span>
            <select
              className="am-input"
              value={data.reasoning || "provider-default"}
              onChange={e => set("reasoning", e.target.value === "provider-default" ? "" : e.target.value)}
            >
              {["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"].map(r => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
        </>
      )}
      {tab === "sandbox" && (
        <label className="am-field">
          <span>Sandbox backend</span>
          <select
            className="am-input"
            value={data.sandbox || "auto"}
            onChange={e => set("sandbox", e.target.value)}
          >
            <option value="auto">Auto (recommended)</option>
            <option value="docker">Docker (requires Docker Desktop)</option>
            <option value="none">None (justbash)</option>
          </select>
        </label>
      )}
      {tab === "limits" && (
        <>
          <label className="am-field">
            <span>Max input tokens per session</span>
            <input
              className="am-input am-mono"
              type="number"
              value={data.maxInputTokens ?? ""}
              onChange={e => set("maxInputTokens", e.target.value ? Number(e.target.value) : undefined)}
              placeholder="200000"
            />
          </label>
          <label className="am-field">
            <span>Max output tokens per session</span>
            <input
              className="am-input am-mono"
              type="number"
              value={data.maxOutputTokens ?? ""}
              onChange={e => set("maxOutputTokens", e.target.value ? Number(e.target.value) : undefined)}
              placeholder="20000"
            />
          </label>
        </>
      )}
    </>
  );
}
