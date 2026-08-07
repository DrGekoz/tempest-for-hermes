import { Plus, Trash2, ChevronUp, ChevronDown } from "lucide-react";
import type { ToolInputSchema, ToolInputField, ToolInputType } from "../graph";

interface Props {
  schema: ToolInputSchema;
  onChange: (s: ToolInputSchema) => void;
}

const TYPES: ToolInputType[] = ["string", "number", "boolean", "enum"];

// Slug-check: agent will fail to invoke tools with non-identifier field names.
function normalizeName(v: string): string {
  return v.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "_$1");
}

export function InputSchemaBuilder({ schema, onChange }: Props) {
  const rows = schema.fields;
  const setRows = (next: ToolInputField[]) => onChange({ fields: next });
  const patch = (i: number, p: Partial<ToolInputField>) =>
    setRows(rows.map((r, ix) => ix === i ? { ...r, ...p } : r));
  const remove = (i: number) => setRows(rows.filter((_, ix) => ix !== i));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = rows.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setRows(next);
  };
  const add = () => setRows([...rows, { name: "", type: "string", required: true }]);

  return (
    <div className="am-fields">
      <div className="am-fields-hint">
        Declare what the agent must pass to this tool. Names must be identifiers (letters, digits, underscore).
      </div>
      {rows.length === 0 && (
        <div className="am-kv-empty">No inputs — this tool takes nothing.</div>
      )}
      {rows.map((f, i) => (
        <div key={i} className="am-fldrow">
          <div className="am-fldrow-head">
            <input
              className="am-input am-mono am-fldrow-name"
              value={f.name}
              onChange={e => patch(i, { name: normalizeName(e.target.value) })}
              placeholder="city"
            />
            <select
              className="am-input am-fldrow-type"
              value={f.type}
              onChange={e => patch(i, { type: e.target.value as ToolInputType })}
            >
              {TYPES.map(t => <option key={t}>{t}</option>)}
            </select>
            <label className="am-fldrow-req" title="Agent must supply a value">
              <input
                type="checkbox"
                checked={f.required}
                onChange={e => patch(i, { required: e.target.checked })}
              />
              <span>required</span>
            </label>
            <button type="button" className="am-fldrow-icon" onClick={() => move(i, -1)} title="Move up" disabled={i === 0}>
              <ChevronUp size={13} />
            </button>
            <button type="button" className="am-fldrow-icon" onClick={() => move(i, 1)} title="Move down" disabled={i === rows.length - 1}>
              <ChevronDown size={13} />
            </button>
            <button type="button" className="am-fldrow-icon am-fldrow-del" onClick={() => remove(i)} title="Remove">
              <Trash2 size={13} />
            </button>
          </div>
          {f.type === "enum" && (
            <input
              className="am-input am-mono am-fldrow-enum"
              value={(f.enumValues || []).join(", ")}
              onChange={e => patch(i, {
                enumValues: e.target.value.split(",").map(s => s.trim()).filter(Boolean),
              })}
              placeholder="metric, imperial, kelvin"
            />
          )}
          <input
            className="am-input am-fldrow-desc"
            value={f.description || ""}
            onChange={e => patch(i, { description: e.target.value })}
            placeholder="Description — shown to the agent"
          />
        </div>
      ))}
      <button type="button" className="am-kv-add" onClick={add}>
        <Plus size={12} /> Add input
      </button>
    </div>
  );
}
