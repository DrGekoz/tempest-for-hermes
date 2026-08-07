import type { FlowStep, ToolInputField, SetVar, SwitchCase, HttpRequest } from "../graph";
import { emptyCondition, emptyRequest } from "../graph";
import { Plus, Trash2, GripVertical } from "lucide-react";
import { ConditionBuilder } from "./ConditionBuilder";
import { RequestBuilder } from "../tool/RequestBuilder";
import { ValueChipsInput } from "../tool/ValueChipsInput";

// P6/P7: renders a step list. Recursive — `if`/`switch`/`loop`/`parallel`
// steps embed nested StepList editors. Kept dense — every collapsible would
// double the code. If step-count in real flows explodes, add collapse then.
// ponytail: flat rendering, add collapsing when a real user has >20 steps.

const KIND_LABELS: Record<FlowStep["kind"], string> = {
  call:     "HTTP call",
  if:       "If / Else",
  switch:   "Switch",
  set:      "Set variable(s)",
  return:   "Return",
  loop:     "Loop",
  parallel: "Parallel (merge)",
};

const KINDS = Object.keys(KIND_LABELS) as FlowStep["kind"][];

function rid() { return Math.random().toString(36).slice(2, 10); }

function emptyStep(kind: FlowStep["kind"]): FlowStep {
  switch (kind) {
    case "call":     return { id: rid(), kind, assignTo: "", request: emptyRequest() };
    case "if":       return { id: rid(), kind, condition: emptyCondition(), then: [], else: [] };
    case "switch":   return { id: rid(), kind, cases: [], default: [] };
    case "set":      return { id: rid(), kind, vars: [{ name: "", value: "" }] };
    case "return":   return { id: rid(), kind, value: "" };
    case "loop":     return {
      id: rid(), kind, shape: "for-each",
      listChip: "", itemVar: "item",
      condition: emptyCondition(), body: [],
    };
    case "parallel": return { id: rid(), kind, mode: "all", branches: [[], []] };
  }
}

// Chip fields visible inside a flow: the flow inputs + variables introduced
// by prior `set`/`call` steps + any loop iteration var currently in scope.
// We only surface `set`/`call` names — chasing "prior in the tree" precisely
// isn't worth the cycles; the chip menu is a hint, users can type anything.
export function scopedFields(
  base: ToolInputField[],
  steps: FlowStep[],
): ToolInputField[] {
  const extras: ToolInputField[] = [];
  const walk = (ss: FlowStep[]) => {
    for (const s of ss) {
      if (s.kind === "set") {
        for (const v of s.vars) if (v.name) extras.push({ name: v.name, type: "string", required: false });
      }
      if (s.kind === "call" && s.assignTo) {
        extras.push({ name: s.assignTo, type: "string", required: false });
      }
      if (s.kind === "if") { walk(s.then); walk(s.else); }
      if (s.kind === "switch") { for (const c of s.cases) walk(c.steps); walk(s.default); }
      if (s.kind === "loop") { extras.push({ name: s.itemVar || "item", type: "string", required: false }); walk(s.body); }
      if (s.kind === "parallel") { for (const b of s.branches) walk(b); }
    }
  };
  walk(steps);
  // Dedupe by name — later wins.
  const merged = new Map<string, ToolInputField>();
  for (const f of base) merged.set(f.name, f);
  for (const f of extras) if (f.name) merged.set(f.name, f);
  return Array.from(merged.values());
}

interface Props {
  steps: FlowStep[];
  onChange: (s: FlowStep[]) => void;
  fields: ToolInputField[];
  /** Root flow-input fields (used for chip menus in nested editors too). */
  rootFields: ToolInputField[];
}

export function StepList({ steps, onChange, fields, rootFields }: Props) {
  const replaceAt = (i: number, s: FlowStep) => {
    const next = [...steps]; next[i] = s; onChange(next);
  };
  const removeAt = (i: number) => onChange(steps.filter((_, j) => j !== i));
  const moveUp = (i: number) => {
    if (i === 0) return;
    const next = [...steps];
    [next[i - 1], next[i]] = [next[i], next[i - 1]];
    onChange(next);
  };
  const add = (kind: FlowStep["kind"]) => onChange([...steps, emptyStep(kind)]);

  return (
    <div className="am-steplist">
      {steps.map((s, i) => (
        <div key={s.id} className="am-step">
          <div className="am-step-head">
            <button type="button" className="am-step-drag" onClick={() => moveUp(i)} title="Move up">
              <GripVertical size={12} />
            </button>
            <span className="am-step-kind">{KIND_LABELS[s.kind]}</span>
            <button type="button" className="am-step-del" onClick={() => removeAt(i)} title="Delete step">
              <Trash2 size={12} />
            </button>
          </div>
          <div className="am-step-body">
            <StepBody step={s} onChange={next => replaceAt(i, next)} fields={fields} rootFields={rootFields} />
          </div>
        </div>
      ))}
      <div className="am-step-add">
        <span className="am-hint">Add a step:</span>
        {KINDS.map(k => (
          <button key={k} type="button" className="am-step-add-btn" onClick={() => add(k)}>
            <Plus size={11} /> {KIND_LABELS[k]}
          </button>
        ))}
      </div>
    </div>
  );
}

function StepBody({ step, onChange, fields, rootFields }: {
  step: FlowStep;
  onChange: (s: FlowStep) => void;
  fields: ToolInputField[];
  rootFields: ToolInputField[];
}) {
  if (step.kind === "call") {
    return (
      <>
        <label className="am-field">
          <span>Save the response as</span>
          <input
            className="am-input am-mono"
            value={step.assignTo}
            onChange={e => onChange({ ...step, assignTo: e.target.value })}
            placeholder="weather"
          />
          <span className="am-hint-block">Later steps can read this back as <code>{`{{input.${step.assignTo || "name"}}}`}</code>.</span>
        </label>
        <RequestBuilder
          request={step.request as HttpRequest}
          onChange={r => onChange({ ...step, request: r })}
          fields={fields}
        />
      </>
    );
  }
  if (step.kind === "if") {
    return (
      <>
        <div className="am-field"><span>Condition</span>
          <ConditionBuilder
            condition={step.condition}
            onChange={c => onChange({ ...step, condition: c })}
            fields={fields}
          />
        </div>
        <div className="am-branch">
          <div className="am-branch-label">Then</div>
          <StepList
            steps={step.then}
            onChange={s => onChange({ ...step, then: s })}
            fields={scopedFields(rootFields, step.then)}
            rootFields={rootFields}
          />
        </div>
        <div className="am-branch">
          <div className="am-branch-label">Else</div>
          <StepList
            steps={step.else}
            onChange={s => onChange({ ...step, else: s })}
            fields={scopedFields(rootFields, step.else)}
            rootFields={rootFields}
          />
        </div>
      </>
    );
  }
  if (step.kind === "switch") {
    const addCase = () => onChange({
      ...step,
      cases: [...step.cases, { label: "case", condition: emptyCondition(), steps: [] }],
    });
    const setCase = (i: number, c: SwitchCase) => {
      const next = [...step.cases]; next[i] = c; onChange({ ...step, cases: next });
    };
    const removeCase = (i: number) =>
      onChange({ ...step, cases: step.cases.filter((_, j) => j !== i) });
    return (
      <>
        {step.cases.map((c, i) => (
          <div key={i} className="am-branch">
            <div className="am-branch-label">
              <input
                className="am-input am-input--fit"
                value={c.label}
                onChange={e => setCase(i, { ...c, label: e.target.value })}
                placeholder="Case name"
              />
              <button type="button" className="am-step-del" onClick={() => removeCase(i)}>
                <Trash2 size={12} />
              </button>
            </div>
            <ConditionBuilder
              condition={c.condition}
              onChange={cond => setCase(i, { ...c, condition: cond })}
              fields={fields}
            />
            <StepList
              steps={c.steps}
              onChange={ss => setCase(i, { ...c, steps: ss })}
              fields={scopedFields(rootFields, c.steps)}
              rootFields={rootFields}
            />
          </div>
        ))}
        <button type="button" className="am-step-add-btn" onClick={addCase}>
          <Plus size={11} /> Add case
        </button>
        <div className="am-branch">
          <div className="am-branch-label">Default (none matched)</div>
          <StepList
            steps={step.default}
            onChange={s => onChange({ ...step, default: s })}
            fields={scopedFields(rootFields, step.default)}
            rootFields={rootFields}
          />
        </div>
      </>
    );
  }
  if (step.kind === "set") {
    const setVar = (i: number, v: SetVar) => {
      const next = [...step.vars]; next[i] = v; onChange({ ...step, vars: next });
    };
    return (
      <>
        {step.vars.map((v, i) => (
          <div key={i} className="am-row am-row--tight">
            <input
              className="am-input am-mono am-input--fit"
              value={v.name}
              onChange={e => setVar(i, { ...v, name: e.target.value })}
              placeholder="name"
            />
            <div className="am-field am-field--grow">
              <ValueChipsInput
                value={v.value}
                onChange={val => setVar(i, { ...v, value: val })}
                fields={fields}
                placeholder="value (chips allowed)"
                mono
              />
            </div>
            <button type="button" className="am-step-del"
              onClick={() => onChange({ ...step, vars: step.vars.filter((_, j) => j !== i) })}>
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        <button type="button" className="am-step-add-btn"
          onClick={() => onChange({ ...step, vars: [...step.vars, { name: "", value: "" }] })}>
          <Plus size={11} /> Add variable
        </button>
      </>
    );
  }
  if (step.kind === "return") {
    return (
      <label className="am-field">
        <span>Return this value to the agent</span>
        <ValueChipsInput
          value={step.value}
          onChange={v => onChange({ ...step, value: v })}
          fields={fields}
          placeholder="{{input.result}} or a literal"
          multiline
          rows={2}
          mono
        />
      </label>
    );
  }
  if (step.kind === "loop") {
    return (
      <>
        <div className="am-segmented">
          <button type="button"
            className={`am-segmented-btn${step.shape === "for-each" ? " am-segmented-btn--active" : ""}`}
            onClick={() => onChange({ ...step, shape: "for-each" })}
          >For each item</button>
          <button type="button"
            className={`am-segmented-btn${step.shape === "while" ? " am-segmented-btn--active" : ""}`}
            onClick={() => onChange({ ...step, shape: "while" })}
          >While condition</button>
        </div>
        {step.shape === "for-each" ? (
          <div className="am-row">
            <label className="am-field am-field--grow">
              <span>List to iterate</span>
              <ValueChipsInput
                value={step.listChip}
                onChange={v => onChange({ ...step, listChip: v })}
                fields={fields}
                placeholder="{{input.items}}"
                mono
              />
            </label>
            <label className="am-field am-field--fixed">
              <span>Each item as</span>
              <input
                className="am-input am-mono"
                value={step.itemVar}
                onChange={e => onChange({ ...step, itemVar: e.target.value })}
                placeholder="item"
              />
            </label>
          </div>
        ) : (
          <div className="am-field"><span>Condition (loops while true)</span>
            <ConditionBuilder
              condition={step.condition}
              onChange={c => onChange({ ...step, condition: c })}
              fields={fields}
            />
          </div>
        )}
        <div className="am-branch">
          <div className="am-branch-label">Do these steps each time</div>
          <StepList
            steps={step.body}
            onChange={s => onChange({ ...step, body: s })}
            fields={scopedFields(rootFields, step.body)}
            rootFields={rootFields}
          />
        </div>
      </>
    );
  }
  if (step.kind === "parallel") {
    return (
      <>
        <div className="am-segmented">
          <button type="button"
            className={`am-segmented-btn${step.mode === "all" ? " am-segmented-btn--active" : ""}`}
            onClick={() => onChange({ ...step, mode: "all" })}
          >Wait for all branches</button>
          <button type="button"
            className={`am-segmented-btn${step.mode === "race" ? " am-segmented-btn--active" : ""}`}
            onClick={() => onChange({ ...step, mode: "race" })}
          >First finished wins</button>
        </div>
        {step.branches.map((b, i) => (
          <div key={i} className="am-branch">
            <div className="am-branch-label">
              Branch {i + 1}
              <button type="button" className="am-step-del"
                onClick={() => onChange({ ...step, branches: step.branches.filter((_, j) => j !== i) })}>
                <Trash2 size={12} />
              </button>
            </div>
            <StepList
              steps={b}
              onChange={ss => {
                const next = [...step.branches]; next[i] = ss;
                onChange({ ...step, branches: next });
              }}
              fields={scopedFields(rootFields, b)}
              rootFields={rootFields}
            />
          </div>
        ))}
        <button type="button" className="am-step-add-btn"
          onClick={() => onChange({ ...step, branches: [...step.branches, []] })}>
          <Plus size={11} /> Add branch
        </button>
      </>
    );
  }
  return null;
}
