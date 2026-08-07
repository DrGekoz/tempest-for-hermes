import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { Node, ToolData, FlowData, TriggerChannelData } from "./graph";
import { emptyRequest, emptyToolData } from "./graph";
import { nodeIcon, nodeLabel, nodeDescription } from "./nodes";
import { ModelPicker } from "./ModelPicker";
import {
  parseCron, buildCron, describeCron, WEEKDAY_NAMES, WEEKDAY_NAMES_SHORT,
  type SchedulePreset,
} from "./humanCron";
import { RequestBuilder } from "./tool/RequestBuilder";
import { InputSchemaBuilder } from "./tool/InputSchemaBuilder";
import { ResponseMapper } from "./tool/ResponseMapper";
import { StepList, scopedFields } from "./flow/StepEditor";
import { TriggerChannelModal } from "./triggers/TriggerChannelModal";

const CHANNEL_TRIGGER_KINDS = [
  "trigger-linear", "trigger-discord", "trigger-telegram",
  "trigger-teams", "trigger-photon", "trigger-poll",
] as const;
type ChannelTriggerKind = typeof CHANNEL_TRIGGER_KINDS[number];

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
            <span className="am-modal-title-text">
              <span>{nodeLabel[node.kind]}</span>
              <span className="am-modal-title-sub">{nodeDescription[node.kind]}</span>
            </span>
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
        <span>What should the Start button say?</span>
        <input
          ref={firstRef}
          className="am-input"
          value={d.label || ""}
          onChange={e => set("label" as never, e.target.value as never)}
          placeholder="e.g. Send morning report"
        />
        <span className="am-hint-block">You'll see this button in the chat panel — click it to run the automation.</span>
      </label>
    );
  }

  if (node.kind === "trigger-schedule") {
    const d = node.data;
    return (
      <>
        <SchedulePicker
          cron={d.cron || ""}
          onChange={c => set("cron" as never, c as never)}
        />
        <label className="am-field">
          <span>What should the agent do each time?</span>
          <textarea
            className="am-textarea"
            value={d.prompt || ""}
            onChange={e => set("prompt" as never, e.target.value as never)}
            rows={4}
            placeholder="Pull open Linear issues and post a summary to #standup"
          />
          <span className="am-hint-block">Write it like you're asking a coworker — the agent reads this every time it runs.</span>
        </label>
      </>
    );
  }

  if (node.kind === "agent") {
    return <AgentTabs data={node.data} set={set as never} firstRef={firstRef} />;
  }

  if (node.kind === "tool") {
    return <ToolTabs data={node.data} onChange={onChange as (d: ToolData) => void} firstRef={firstRef} />;
  }

  if (node.kind === "flow") {
    return <FlowTabs data={node.data as FlowData} onChange={onChange as (d: FlowData) => void} firstRef={firstRef} />;
  }

  if ((CHANNEL_TRIGGER_KINDS as readonly string[]).includes(node.kind)) {
    return (
      <TriggerChannelModal
        kind={node.kind as ChannelTriggerKind}
        data={node.data as TriggerChannelData}
        onChange={onChange as (d: TriggerChannelData) => void}
      />
    );
  }

  if (node.kind === "skill") {
    const d = node.data;
    return (
      <>
        <label className="am-field">
          <span>Name for this skill</span>
          <input
            ref={firstRef}
            className="am-input"
            value={d.name || ""}
            onChange={e => set("name" as never, e.target.value as never)}
            placeholder="summarize"
          />
          <span className="am-hint-block">Short, no spaces. The agent loads this on demand when it's relevant.</span>
        </label>
        <label className="am-field">
          <span>What should the agent do?</span>
          <textarea
            className="am-textarea"
            value={d.markdown || ""}
            onChange={e => set("markdown" as never, e.target.value as never)}
            rows={12}
            placeholder={"# Skill: summarize\n\n1. Read the input\n2. Return 3 bullet points"}
          />
          <span className="am-hint-block">Written in Markdown. Numbered steps work well.</span>
        </label>
      </>
    );
  }

  if (node.kind === "connection") {
    const d = node.data;
    const isMcp = (d.kind || "mcp") === "mcp";
    return (
      <>
        <label className="am-field">
          <span>Name for this connection</span>
          <input
            ref={firstRef}
            className="am-input"
            value={d.name || ""}
            onChange={e => set("name" as never, e.target.value as never)}
            placeholder="linear"
          />
        </label>
        <div className="am-segmented">
          <button
            type="button"
            className={`am-segmented-btn${isMcp ? " am-segmented-btn--active" : ""}`}
            onClick={() => set("kind" as never, "mcp" as never)}
          >MCP server</button>
          <button
            type="button"
            className={`am-segmented-btn${!isMcp ? " am-segmented-btn--active" : ""}`}
            onClick={() => set("kind" as never, "openapi" as never)}
          >OpenAPI spec</button>
        </div>
        <label className="am-field">
          <span>{isMcp ? "Server URL" : "OpenAPI spec URL"}</span>
          <input
            className="am-input am-mono"
            value={d.url || ""}
            onChange={e => set("url" as never, e.target.value as never)}
            placeholder={isMcp ? "https://mcp.example.com" : "https://api.example.com/openapi.json"}
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
          <span>Name for this helper</span>
          <input
            ref={firstRef}
            className="am-input"
            value={d.name || ""}
            onChange={e => set("name" as never, e.target.value as never)}
            placeholder="researcher"
          />
        </label>
        <label className="am-field">
          <span>Model</span>
          <ModelPicker
            value={d.model || ""}
            onChange={v => set("model" as never, v as never)}
          />
        </label>
        <label className="am-field">
          <span>When should the main agent call this helper?</span>
          <textarea
            className="am-textarea"
            value={d.description || ""}
            onChange={e => set("description" as never, e.target.value as never)}
            rows={2}
            placeholder="Use to research and summarize open issues from Linear."
          />
          <span className="am-hint-block">Required — the main agent uses this to decide when to delegate.</span>
        </label>
        <label className="am-field">
          <span>Instructions for the helper</span>
          <textarea
            className="am-textarea"
            value={d.instructions || ""}
            onChange={e => set("instructions" as never, e.target.value as never)}
            rows={8}
            placeholder="You are a research specialist. Read what's given, summarize in 3 bullet points."
          />
        </label>
      </>
    );
  }

  return null;
}

// ── Schedule picker ─────────────────────────────────────────────────────────

const PRESETS: { id: SchedulePreset; label: string }[] = [
  { id: "every-minutes",  label: "Every few minutes" },
  { id: "every-hours",    label: "Every few hours" },
  { id: "daily",          label: "Every day" },
  { id: "weekdays",       label: "Every weekday (Mon–Fri)" },
  { id: "on-days",        label: "On specific days" },
  { id: "times-per-day",  label: "Several times a day" },
  { id: "weekly",         label: "Once a week" },
  { id: "monthly",        label: "Once a month" },
];

function SchedulePicker({ cron, onChange }: { cron: string; onChange: (c: string) => void }) {
  const [state, setState] = useState(() => parseCron(cron));

  const update = (patch: Partial<typeof state>) => {
    // Coming out of an unrecognized cron ("custom") snaps to a real preset.
    const preset = patch.preset ?? (state.preset === "custom" ? "daily" : state.preset);
    const next = { ...state, ...patch, preset };
    setState(next);
    onChange(buildCron(next));
  };

  const timeValue = `${pad(state.hour)}:${pad(state.minute)}`;
  const setTime = (v: string) => {
    const [h, m] = v.split(":").map(x => parseInt(x, 10) || 0);
    update({ hour: h, minute: m });
  };

  const toggleWeekday = (i: number) => {
    const has = state.weekdays.includes(i);
    const next = has ? state.weekdays.filter(x => x !== i) : [...state.weekdays, i].sort((a, b) => a - b);
    update({ weekdays: next.length ? next : [i] });   // never empty
  };
  const toggleHour = (h: number) => {
    const has = state.hours.includes(h);
    const next = has ? state.hours.filter(x => x !== h) : [...state.hours, h].sort((a, b) => a - b);
    update({ hours: next.length ? next : [h] });
  };

  const isCustom = state.preset === "custom";
  const shownPreset: SchedulePreset = isCustom ? "daily" : state.preset;

  return (
    <div className="am-field">
      <span>When should this run?</span>
      {isCustom && (
        <div className="am-callout">
          Existing cron doesn't match a preset: <code>{cron}</code>. Pick a preset below to replace it.
        </div>
      )}
      <select
        className="am-input"
        value={shownPreset}
        onChange={e => update({ preset: e.target.value as SchedulePreset })}
      >
        {PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>

      {state.preset === "every-minutes" && (
        <div className="am-row am-row--tight">
          <span className="am-inline">every</span>
          <input
            type="number" min={1} max={59}
            className="am-input am-input--num"
            value={state.n}
            onChange={e => update({ n: Math.max(1, Math.min(59, +e.target.value || 1)) })}
          />
          <span className="am-inline">minutes</span>
        </div>
      )}
      {state.preset === "every-hours" && (
        <div className="am-row am-row--tight">
          <span className="am-inline">every</span>
          <input
            type="number" min={1} max={23}
            className="am-input am-input--num"
            value={state.n}
            onChange={e => update({ n: Math.max(1, Math.min(23, +e.target.value || 1)) })}
          />
          <span className="am-inline">hours</span>
        </div>
      )}
      {(state.preset === "daily" || state.preset === "weekdays") && (
        <div className="am-row am-row--tight">
          <span className="am-inline">at</span>
          <input type="time" className="am-input am-input--num" value={timeValue} onChange={e => setTime(e.target.value)} />
        </div>
      )}
      {state.preset === "on-days" && (
        <>
          <div className="am-daypicker">
            {WEEKDAY_NAMES_SHORT.map((n, i) => (
              <button
                key={i}
                type="button"
                className={`am-daypicker-btn${state.weekdays.includes(i) ? " am-daypicker-btn--on" : ""}`}
                onClick={() => toggleWeekday(i)}
              >{n}</button>
            ))}
          </div>
          <div className="am-row am-row--tight">
            <span className="am-inline">at</span>
            <input type="time" className="am-input am-input--num" value={timeValue} onChange={e => setTime(e.target.value)} />
          </div>
        </>
      )}
      {state.preset === "times-per-day" && (
        <>
          <div className="am-hourgrid">
            {Array.from({ length: 24 }, (_, h) => (
              <button
                key={h}
                type="button"
                className={`am-hourgrid-btn${state.hours.includes(h) ? " am-hourgrid-btn--on" : ""}`}
                onClick={() => toggleHour(h)}
              >{pad(h)}</button>
            ))}
          </div>
          <div className="am-row am-row--tight">
            <span className="am-inline">at :</span>
            <input
              type="number" min={0} max={59}
              className="am-input am-input--num"
              value={state.minute}
              onChange={e => update({ minute: Math.max(0, Math.min(59, +e.target.value || 0)) })}
            />
            <span className="am-inline">minutes past each hour</span>
          </div>
        </>
      )}
      {state.preset === "weekly" && (
        <div className="am-row am-row--tight">
          <span className="am-inline">every</span>
          <select
            className="am-input am-input--fit"
            value={state.weekday}
            onChange={e => update({ weekday: +e.target.value })}
          >
            {WEEKDAY_NAMES.map((n, i) => <option key={i} value={i}>{n}</option>)}
          </select>
          <span className="am-inline">at</span>
          <input type="time" className="am-input am-input--num" value={timeValue} onChange={e => setTime(e.target.value)} />
        </div>
      )}
      {state.preset === "monthly" && (
        <div className="am-row am-row--tight">
          <span className="am-inline">on day</span>
          <input
            type="number" min={1} max={28}
            className="am-input am-input--num"
            value={state.day}
            onChange={e => update({ day: Math.max(1, Math.min(28, +e.target.value || 1)) })}
          />
          <span className="am-inline">at</span>
          <input type="time" className="am-input am-input--num" value={timeValue} onChange={e => setTime(e.target.value)} />
        </div>
      )}

      <div className="am-readback">
        <span className="am-readback-dot" /> {describeCron(buildCron(state))}
      </div>
    </div>
  );
}

function pad(n: number) { return String(n).padStart(2, "0"); }

// ── Tool tabs ───────────────────────────────────────────────────────────────

type ToolTab = "basics" | "inputs" | "request" | "response";

function ToolTabs({ data, onChange, firstRef }: {
  data: ToolData;
  onChange: (d: ToolData) => void;
  firstRef: React.MutableRefObject<HTMLInputElement | HTMLTextAreaElement | null>;
}) {
  const [tab, setTab] = useState<ToolTab>("basics");
  // Migrate legacy shape (preset/httpUrl/customExecute) on first render so the
  // rest of the modal only sees the new fields. Per [[feedback_clean_over_compat]]:
  // if the graph came from before P1–P3, take the URL if we can and drop the code.
  const d: ToolData = {
    name: data.name || "",
    description: data.description || "",
    request: data.request || {
      ...emptyRequest(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      method: ((data as any).httpMethod as HttpReqMethod) || "GET",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      url: (data as any).httpUrl || "",
    },
    input: data.input || { fields: [] },
    response: data.response || { kind: "raw" },
  };
  // If migration happened, persist it on any subsequent edit so we never write
  // the legacy fields back.
  const set = <K extends keyof ToolData>(k: K, v: ToolData[K]) =>
    onChange({ ...emptyToolData(), ...d, [k]: v });

  const tabs: { id: ToolTab; label: string }[] = [
    { id: "basics",   label: "Basics" },
    { id: "inputs",   label: "Inputs" },
    { id: "request",  label: "Request" },
    { id: "response", label: "Response" },
  ];

  return (
    <>
      <div className="am-tabs2">
        {tabs.map(t => (
          <button
            key={t.id}
            type="button"
            className={`am-tabs2-btn${tab === t.id ? " am-tabs2-btn--active" : ""}`}
            onClick={() => setTab(t.id)}
          >{t.label}</button>
        ))}
      </div>
      {tab === "basics" && (
        <>
          <label className="am-field">
            <span>Name for this tool</span>
            <input
              ref={firstRef as React.RefObject<HTMLInputElement>}
              className="am-input am-mono"
              value={d.name}
              onChange={e => set("name", e.target.value)}
              placeholder="get_weather"
            />
            <span className="am-hint-block">Short, no spaces — the agent uses this to call the tool.</span>
          </label>
          <label className="am-field">
            <span>What does this tool do?</span>
            <textarea
              className="am-textarea"
              value={d.description}
              onChange={e => set("description", e.target.value)}
              rows={3}
              placeholder="Look up the current weather for a city."
            />
            <span className="am-hint-block">The agent reads this to decide when to use the tool. Be specific.</span>
          </label>
        </>
      )}
      {tab === "inputs" && (
        <InputSchemaBuilder
          schema={d.input}
          onChange={s => set("input", s)}
        />
      )}
      {tab === "request" && (
        <RequestBuilder
          request={d.request}
          onChange={r => set("request", r)}
          fields={d.input.fields}
        />
      )}
      {tab === "response" && (
        <ResponseMapper
          response={d.response}
          onChange={r => set("response", r)}
          request={d.request}
          fields={d.input.fields}
        />
      )}
    </>
  );
}

type HttpReqMethod = ToolData["request"]["method"];

// ── Flow tabs ───────────────────────────────────────────────────────────────

type FlowTab = "basics" | "inputs" | "steps";

function FlowTabs({ data, onChange, firstRef }: {
  data: FlowData;
  onChange: (d: FlowData) => void;
  firstRef: React.MutableRefObject<HTMLInputElement | HTMLTextAreaElement | null>;
}) {
  const [tab, setTab] = useState<FlowTab>("basics");
  const set = <K extends keyof FlowData>(k: K, v: FlowData[K]) => onChange({ ...data, [k]: v });
  const tabs: { id: FlowTab; label: string }[] = [
    { id: "basics", label: "Basics" },
    { id: "inputs", label: "Inputs" },
    { id: "steps",  label: "Steps" },
  ];
  const rootFields = data.input?.fields ?? [];
  const chipFields = scopedFields(rootFields, data.steps);
  return (
    <>
      <div className="am-tabs2">
        {tabs.map(t => (
          <button
            key={t.id}
            type="button"
            className={`am-tabs2-btn${tab === t.id ? " am-tabs2-btn--active" : ""}`}
            onClick={() => setTab(t.id)}
          >{t.label}</button>
        ))}
      </div>
      {tab === "basics" && (
        <>
          <label className="am-field">
            <span>Name for this flow</span>
            <input
              ref={firstRef as React.RefObject<HTMLInputElement>}
              className="am-input am-mono"
              value={data.name}
              onChange={e => set("name", e.target.value)}
              placeholder="get_weather_and_summarize"
            />
            <span className="am-hint-block">Short, no spaces — the agent calls this as a tool.</span>
          </label>
          <label className="am-field">
            <span>What does this flow do?</span>
            <textarea
              className="am-textarea"
              value={data.description}
              onChange={e => set("description", e.target.value)}
              rows={3}
              placeholder="Look up the weather for a city and summarize it in one line."
            />
          </label>
        </>
      )}
      {tab === "inputs" && (
        <InputSchemaBuilder
          schema={data.input}
          onChange={s => set("input", s)}
        />
      )}
      {tab === "steps" && (
        <StepList
          steps={data.steps}
          onChange={s => set("steps", s)}
          fields={chipFields}
          rootFields={rootFields}
        />
      )}
    </>
  );
}

// ── Agent tabs ──────────────────────────────────────────────────────────────

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
          <span>How should the agent behave?</span>
          <textarea
            ref={firstRef}
            className="am-textarea"
            value={data.instructions || ""}
            onChange={e => set("instructions", e.target.value)}
            rows={14}
            placeholder="You are a helpful assistant that reads incoming emails and drafts short replies. Always ask before sending."
          />
          <span className="am-hint-block">Written like a job description — the agent reads this every run.</span>
        </label>
      )}
      {tab === "model" && (
        <>
          <label className="am-field">
            <span>Which model should the agent use?</span>
            <ModelPicker
              value={data.model || ""}
              onChange={v => set("model", v)}
            />
          </label>
          <label className="am-field">
            <span>Reasoning effort</span>
            <select
              className="am-input"
              value={data.reasoning || "provider-default"}
              onChange={e => set("reasoning", e.target.value === "provider-default" ? "" : e.target.value)}
            >
              {["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"].map(r => (
                <option key={r}>{r}</option>
              ))}
            </select>
            <span className="am-hint-block">Higher = slower but thinks harder. Leave on default if unsure.</span>
          </label>
        </>
      )}
      {tab === "sandbox" && (
        <label className="am-field">
          <span>Where should the agent run code?</span>
          <select
            className="am-input"
            value={data.sandbox || "auto"}
            onChange={e => set("sandbox", e.target.value)}
          >
            <option value="auto">Auto (recommended)</option>
            <option value="docker">Docker (needs Docker Desktop)</option>
            <option value="none">None — run on this machine directly</option>
          </select>
          <span className="am-hint-block">Sandboxes isolate the agent so it can't touch your files by accident.</span>
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
            <span className="am-hint-block">Caps how much text the agent can read in one run. Leave blank for provider default.</span>
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
            <span className="am-hint-block">Caps how much the agent can write in one run.</span>
          </label>
        </>
      )}
    </>
  );
}
