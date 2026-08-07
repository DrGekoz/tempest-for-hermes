import { Plus, Trash2 } from "lucide-react";
import type { KV, ToolInputField } from "../graph";
import { ValueChipsInput } from "./ValueChipsInput";

interface Props {
  rows: KV[];
  onChange: (rows: KV[]) => void;
  fields: ToolInputField[];
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel?: string;
  monoValue?: boolean;
}

// ponytail: enabled toggle via checkbox is more discoverable than a right-click.
export function KVRows({
  rows, onChange, fields, keyPlaceholder, valuePlaceholder, addLabel, monoValue,
}: Props) {
  const patch = (i: number, p: Partial<KV>) =>
    onChange(rows.map((r, ix) => ix === i ? { ...r, ...p } : r));
  const remove = (i: number) => onChange(rows.filter((_, ix) => ix !== i));
  const add = () => onChange([...rows, { key: "", value: "", enabled: true }]);

  return (
    <div className="am-kv">
      {rows.length === 0 && (
        <div className="am-kv-empty">No rows yet.</div>
      )}
      {rows.map((r, i) => (
        <div key={i} className={`am-kv-row${r.enabled ? "" : " am-kv-row--off"}`}>
          <input
            type="checkbox"
            className="am-kv-check"
            checked={r.enabled}
            onChange={e => patch(i, { enabled: e.target.checked })}
            title={r.enabled ? "Included" : "Skipped"}
          />
          <input
            className="am-input am-mono am-kv-key"
            value={r.key}
            onChange={e => patch(i, { key: e.target.value })}
            placeholder={keyPlaceholder || "key"}
          />
          <div className="am-kv-val">
            <ValueChipsInput
              value={r.value}
              onChange={v => patch(i, { value: v })}
              fields={fields}
              placeholder={valuePlaceholder || "value"}
              mono={monoValue}
            />
          </div>
          <button
            type="button"
            className="am-kv-del"
            onClick={() => remove(i)}
            title="Remove row"
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <button type="button" className="am-kv-add" onClick={add}>
        <Plus size={12} /> {addLabel || "Add row"}
      </button>
    </div>
  );
}
