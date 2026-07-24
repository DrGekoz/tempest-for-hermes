import type { ProjectSettings } from "./useProjectSettings";

function NumericField({
  label, desc, unit, value, onChange, min, max, placeholder,
}: {
  label: string; desc: string; unit?: string;
  value: string; onChange: (v: string) => void;
  min?: number; max?: number; placeholder?: string;
}) {
  return (
    <div className="psp-field">
      <div className="psp-field-label">{label}</div>
      <div className="psp-field-desc">{desc}</div>
      <div className="psp-field-input-row">
        <input
          className="psp-input psp-input--sm"
          type="number"
          min={min}
          max={max}
          placeholder={placeholder ?? "unlimited"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {unit && <span className="psp-field-unit">{unit}</span>}
      </div>
    </div>
  );
}

type Resources = ProjectSettings["resources"];

/// Blank input → `null` (no limit). Anything unparseable is also `null` rather
/// than `NaN`, so a half-typed value never reaches the backend as a quota.
const toValue = (s: string): number | null => {
  const n = Number(s);
  return s.trim() === "" || !Number.isFinite(n) ? null : n;
};

const toInput = (n: number | null): string => (n === null ? "" : String(n));

export function ResourcesSection({
  value, onChange,
}: {
  value: Resources;
  onChange: (v: Resources) => void;
}) {
  const set = <K extends keyof Resources>(key: K) => (raw: string) =>
    onChange({ ...value, [key]: toValue(raw) });

  return (
    <div className="sp-section">
      <div className="sp-section-heading">Resource Limits</div>
      <p className="sp-section-desc">
        Cap what sessions can consume per project. Leave blank for no limit.
        Enforced via OS-level Job Objects; applied at session spawn.
      </p>
      <div className="psp-fields">
        <NumericField
          label="Max memory"
          desc="Peak memory limit per process in the session."
          unit="MB"
          value={toInput(value.maxMemoryMb)}
          onChange={set("maxMemoryMb")}
          min={64}
        />
        <NumericField
          label="Max processes"
          desc="Maximum concurrent processes the session may run."
          value={toInput(value.maxProcesses)}
          onChange={set("maxProcesses")}
          min={1}
        />
        <NumericField
          label="Disk write limit"
          desc="Total bytes written to disk per session. Not enforced on Windows."
          unit="MB"
          value={toInput(value.maxDiskWriteMb)}
          onChange={set("maxDiskWriteMb")}
          min={1}
        />
        <NumericField
          label="CPU weight"
          desc="Relative scheduling share (1–10000). Lower = less CPU."
          value={toInput(value.cpuWeight)}
          onChange={set("cpuWeight")}
          min={1}
          max={10000}
          placeholder="OS default"
        />
      </div>
    </div>
  );
}
