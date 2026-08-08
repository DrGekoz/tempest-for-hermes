import { useState } from "react";
import { SCHEDULE_PRESETS, validateRrule, humanizeRrule } from "../../lib/automationSchedule";

interface Props {
  value: string;
  onChange: (rrule: string) => void;
}

export function SchedulePicker({ value, onChange }: Props) {
  const matchedPreset = SCHEDULE_PRESETS.find((p) => p.rrule === value && p.rrule !== "");
  const [custom, setCustom] = useState(!matchedPreset ? value : "");
  const [showCustom, setShowCustom] = useState(!matchedPreset);

  const customErr = showCustom ? validateRrule(custom) : null;

  function selectPreset(rrule: string, isCustom: boolean) {
    if (isCustom) {
      setShowCustom(true);
    } else {
      setShowCustom(false);
      onChange(rrule);
    }
  }

  function handleCustomChange(v: string) {
    setCustom(v);
    if (!validateRrule(v)) onChange(v);
  }

  return (
    <div className="am-schedule-picker">
      <div className="am-schedule-presets">
        {SCHEDULE_PRESETS.map((p) => {
          const active = p.rrule === "" ? showCustom : (!showCustom && value === p.rrule);
          return (
            <button
              key={p.label}
              className={`am-schedule-preset${active ? " am-schedule-preset--active" : ""}`}
              onClick={() => selectPreset(p.rrule, p.rrule === "")}
              type="button"
            >
              {p.label}
            </button>
          );
        })}
      </div>
      {showCustom && (
        <div className="am-schedule-custom">
          <input
            className={`am-schedule-input${customErr ? " am-schedule-input--error" : ""}`}
            value={custom}
            onChange={(e) => handleCustomChange(e.target.value)}
            placeholder="FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9"
          />
          {customErr && <span className="am-schedule-error">{customErr}</span>}
          {!customErr && custom && (
            <span className="am-schedule-hint">{humanizeRrule(custom)}</span>
          )}
        </div>
      )}
      {!showCustom && value && (
        <span className="am-schedule-hint">{humanizeRrule(value)}</span>
      )}
    </div>
  );
}
