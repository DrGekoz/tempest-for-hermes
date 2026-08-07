import type { Condition, ConditionOp, ToolInputField } from "../graph";
import { ValueChipsInput } from "../tool/ValueChipsInput";

// P6: shared field+op+value primitive used by `if`, `switch`, and `loop while`.

const OPS: { id: ConditionOp; label: string; unary?: boolean }[] = [
  { id: "equals",         label: "equals" },
  { id: "not-equals",     label: "does not equal" },
  { id: "contains",       label: "contains" },
  { id: "not-contains",   label: "does not contain" },
  { id: "gt",             label: "greater than (>)" },
  { id: "gte",            label: "greater or equal (≥)" },
  { id: "lt",             label: "less than (<)" },
  { id: "lte",            label: "less or equal (≤)" },
  { id: "is-empty",       label: "is empty",     unary: true },
  { id: "is-not-empty",   label: "is not empty", unary: true },
  { id: "matches",        label: "matches regex" },
];

interface Props {
  condition: Condition;
  onChange: (c: Condition) => void;
  fields: ToolInputField[];
}

export function ConditionBuilder({ condition, onChange, fields }: Props) {
  const op = OPS.find(o => o.id === condition.op) || OPS[0];
  return (
    <div className="am-cond">
      <div className="am-cond-row">
        <ValueChipsInput
          value={condition.left}
          onChange={v => onChange({ ...condition, left: v })}
          fields={fields}
          placeholder="{{input.something}}"
          mono
        />
      </div>
      <div className="am-cond-row">
        <select
          className="am-input"
          value={condition.op}
          onChange={e => onChange({ ...condition, op: e.target.value as ConditionOp })}
        >
          {OPS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </div>
      {!op.unary && (
        <div className="am-cond-row">
          <ValueChipsInput
            value={condition.right}
            onChange={v => onChange({ ...condition, right: v })}
            fields={fields}
            placeholder="value or {{input.other}}"
            mono
          />
        </div>
      )}
    </div>
  );
}
