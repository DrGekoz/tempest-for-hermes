import { useState } from "react";
import { Play, Loader2, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { HttpRequest, ResponseMap, ToolInputField } from "../graph";

interface Props {
  response: ResponseMap;
  onChange: (r: ResponseMap) => void;
  request: HttpRequest;
  fields: ToolInputField[];
}

interface TryResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;   // parsed JSON when possible; otherwise the raw string
  ms: number;
}

type TryHttpArgs = {
  request: HttpRequest;
  sample: Record<string, unknown>;
} & Record<string, unknown>;

// Returned by the Rust command; shape matches TryHttpResult in automations.rs.
interface RustTryResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  ms: number;
}

export function ResponseMapper({ response, onChange, request, fields }: Props) {
  const [sample, setSample] = useState<Record<string, string>>({});
  const [result, setResult] = useState<TryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const patchSample = (name: string, v: string) => setSample(s => ({ ...s, [name]: v }));

  // Coerce string inputs to their declared types before shipping to the request.
  // Booleans and numbers arrive as strings from <input>; JSON body etc. wants
  // the real value.
  const coerce = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = sample[f.name] ?? "";
      if (raw === "" && !f.required) continue;
      if (f.type === "number") out[f.name] = Number(raw);
      else if (f.type === "boolean") out[f.name] = raw === "true" || raw === "1";
      else out[f.name] = raw;
    }
    return out;
  };

  const run = async () => {
    setBusy(true); setError(null); setResult(null);
    try {
      const args: TryHttpArgs = { request, sample: coerce() };
      const raw = await invoke<RustTryResult>("try_http_request", args);
      let body: unknown = raw.body;
      try { body = JSON.parse(raw.body); } catch { /* keep raw */ }
      setResult({ status: raw.status, headers: raw.headers, body, ms: raw.ms });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="am-resp">
      <label className="am-field">
        <span>What should this tool return to the agent?</span>
        <select
          className="am-input"
          value={response.kind}
          onChange={e => onChange(
            e.target.value === "pick"
              ? { kind: "pick", pick: response.pick || "" }
              : { kind: "raw" }
          )}
        >
          <option value="raw">Whole response body</option>
          <option value="pick">Pick one field from the response</option>
        </select>
      </label>

      {response.kind === "pick" && (
        <label className="am-field">
          <span>Path</span>
          <div className="am-row am-row--tight">
            <input
              className="am-input am-mono"
              value={response.pick || ""}
              onChange={e => onChange({ kind: "pick", pick: e.target.value })}
              placeholder="data.items[0].name"
              readOnly={!!result}
            />
            {response.pick && (
              <button
                type="button"
                className="am-fldrow-icon"
                onClick={() => onChange({ kind: "pick", pick: "" })}
                title="Clear"
              >
                <X size={13} />
              </button>
            )}
          </div>
          <span className="am-hint-block">Click a value in the response tree below to fill this in.</span>
        </label>
      )}

      <div className="am-resp-try">
        <div className="am-req-section-head">Try it with sample inputs</div>
        {fields.length === 0 ? (
          <div className="am-kv-empty">No inputs declared — Try it will run with none.</div>
        ) : (
          <div className="am-resp-sample">
            {fields.map(f => (
              <label key={f.name} className="am-field">
                <span>{f.name} <span className="am-hint">({f.type}{f.required ? ", required" : ""})</span></span>
                <input
                  className="am-input am-mono"
                  value={sample[f.name] ?? ""}
                  onChange={e => patchSample(f.name, e.target.value)}
                  placeholder={f.type === "boolean" ? "true / false" : f.description}
                />
              </label>
            ))}
          </div>
        )}
        <button
          type="button"
          className="am-modal-primary am-resp-run"
          onClick={run}
          disabled={busy || !request.url.trim()}
        >
          {busy ? <><Loader2 size={13} className="am-spin" /> Running…</> : <><Play size={13} /> Try it</>}
        </button>
      </div>

      {error && <div className="am-callout am-callout--err">{error}</div>}
      {result && (
        <div className="am-resp-result">
          <div className="am-resp-status">
            <span className={`am-resp-status-code am-resp-status-code--${statusClass(result.status)}`}>{result.status}</span>
            <span className="am-hint">{result.ms} ms</span>
          </div>
          <JsonTree
            value={result.body}
            path=""
            onPick={p => response.kind === "pick" && onChange({ kind: "pick", pick: p })}
            active={response.kind === "pick" ? (response.pick || "") : ""}
            selectable={response.kind === "pick"}
          />
        </div>
      )}
    </div>
  );
}

function statusClass(s: number): string {
  if (s >= 200 && s < 300) return "ok";
  if (s >= 300 && s < 400) return "redirect";
  if (s >= 400) return "err";
  return "unk";
}

// ── JSON tree ───────────────────────────────────────────────────────────────
// Renders arbitrary parsed JSON as a collapsible tree. Clicking a leaf path
// calls onPick with the JSONPath-ish string ("data.items[0].name").

interface JsonTreeProps {
  value: unknown;
  path: string;
  onPick: (p: string) => void;
  active: string;
  selectable: boolean;
}

function JsonTree({ value, path, onPick, active, selectable }: JsonTreeProps) {
  if (value === null) return <Leaf label="null" path={path} onPick={onPick} active={active} selectable={selectable} kind="null" />;
  const t = typeof value;
  if (t === "string") return <Leaf label={JSON.stringify(value)} path={path} onPick={onPick} active={active} selectable={selectable} kind="str" />;
  if (t === "number" || t === "boolean") return <Leaf label={String(value)} path={path} onPick={onPick} active={active} selectable={selectable} kind={t as "number" | "boolean"} />;
  if (Array.isArray(value)) return <ArrayNode items={value} path={path} onPick={onPick} active={active} selectable={selectable} />;
  if (t === "object") return <ObjectNode obj={value as Record<string, unknown>} path={path} onPick={onPick} active={active} selectable={selectable} />;
  return <Leaf label={String(value)} path={path} onPick={onPick} active={active} selectable={selectable} kind="str" />;
}

function Leaf({ label, path, onPick, active, selectable, kind }: {
  label: string; path: string; onPick: (p: string) => void; active: string; selectable: boolean;
  kind: "str" | "number" | "boolean" | "null";
}) {
  const on = selectable && path && path === active;
  return (
    <span
      className={`am-json-leaf am-json-leaf--${kind}${selectable && path ? " am-json-leaf--pick" : ""}${on ? " am-json-leaf--on" : ""}`}
      onClick={() => selectable && path && onPick(path)}
      title={selectable && path ? `Click to use ${path}` : ""}
    >{label}</span>
  );
}

function ObjectNode({ obj, path, onPick, active, selectable }: {
  obj: Record<string, unknown>; path: string; onPick: (p: string) => void; active: string; selectable: boolean;
}) {
  const [open, setOpen] = useState(true);
  const keys = Object.keys(obj);
  if (keys.length === 0) return <span className="am-json-empty">{"{ }"}</span>;
  return (
    <div className="am-json-obj">
      <button type="button" className="am-json-toggle" onClick={() => setOpen(o => !o)}>
        {open ? "▾" : "▸"} {`{${keys.length}}`}
      </button>
      {open && (
        <div className="am-json-body">
          {keys.map(k => {
            const child = path ? `${path}.${k}` : k;
            return (
              <div key={k} className="am-json-row">
                <span
                  className={`am-json-key${selectable ? " am-json-key--pick" : ""}${selectable && child === active ? " am-json-key--on" : ""}`}
                  onClick={() => selectable && onPick(child)}
                >{k}</span>
                <span className="am-json-colon">:</span>
                <JsonTree value={obj[k]} path={child} onPick={onPick} active={active} selectable={selectable} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ArrayNode({ items, path, onPick, active, selectable }: {
  items: unknown[]; path: string; onPick: (p: string) => void; active: string; selectable: boolean;
}) {
  const [open, setOpen] = useState(true);
  if (items.length === 0) return <span className="am-json-empty">{"[]"}</span>;
  return (
    <div className="am-json-obj">
      <button type="button" className="am-json-toggle" onClick={() => setOpen(o => !o)}>
        {open ? "▾" : "▸"} {`[${items.length}]`}
      </button>
      {open && (
        <div className="am-json-body">
          {items.map((v, i) => {
            const child = `${path}[${i}]`;
            return (
              <div key={i} className="am-json-row">
                <span
                  className={`am-json-key am-json-key--idx${selectable ? " am-json-key--pick" : ""}${selectable && child === active ? " am-json-key--on" : ""}`}
                  onClick={() => selectable && onPick(child)}
                >{i}</span>
                <span className="am-json-colon">:</span>
                <JsonTree value={v} path={child} onPick={onPick} active={active} selectable={selectable} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
