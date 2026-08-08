import { useEffect, useMemo, useState } from "react";
import { humanizeRrule } from "../../lib/automationSchedule";
import { Segmented } from "../ui/Segmented";
import "../SettingsPanel.css";

interface Props {
  value: string;
  onChange: (rrule: string) => void;
}

type Freq = "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY";

const FREQS = [
  { value: "HOURLY", label: "Hourly" },
  { value: "DAILY", label: "Daily" },
  { value: "WEEKLY", label: "Weekly" },
  { value: "MONTHLY", label: "Monthly" },
];

const WEEKDAYS: { code: string; label: string }[] = [
  { code: "MO", label: "Mon" },
  { code: "TU", label: "Tue" },
  { code: "WE", label: "Wed" },
  { code: "TH", label: "Thu" },
  { code: "FR", label: "Fri" },
  { code: "SA", label: "Sat" },
  { code: "SU", label: "Sun" },
];

interface Parsed {
  freq: Freq;
  hour: number;
  minute: number;
  byday: string[];
  bymonthday: number;
  interval: number;
}

function parse(rrule: string): Parsed {
  const parts = new Map<string, string>();
  for (const seg of rrule.replace(/^RRULE:/, "").split(";")) {
    const [k, v] = seg.split("=");
    if (k && v) parts.set(k.toUpperCase(), v);
  }
  const freq = (parts.get("FREQ") as Freq) || "DAILY";
  return {
    freq: (["HOURLY", "DAILY", "WEEKLY", "MONTHLY"] as Freq[]).includes(freq) ? freq : "DAILY",
    hour: Number(parts.get("BYHOUR") ?? 9),
    minute: Number(parts.get("BYMINUTE") ?? 0),
    byday: (parts.get("BYDAY") || "MO").split(",").filter(Boolean),
    bymonthday: Number(parts.get("BYMONTHDAY") ?? 1),
    interval: Number(parts.get("INTERVAL") ?? 1),
  };
}

function build(p: Parsed): string {
  const bits: string[] = [`FREQ=${p.freq}`];
  if (p.interval > 1) bits.push(`INTERVAL=${p.interval}`);
  if (p.freq === "WEEKLY") bits.push(`BYDAY=${p.byday.join(",") || "MO"}`);
  if (p.freq === "MONTHLY") bits.push(`BYMONTHDAY=${p.bymonthday}`);
  if (p.freq !== "HOURLY") {
    bits.push(`BYHOUR=${p.hour}`, `BYMINUTE=${p.minute}`, `BYSECOND=0`);
  }
  return bits.join(";");
}

const QUICK: { label: string; rrule: string }[] = [
  { label: "Every hour", rrule: "FREQ=HOURLY" },
  { label: "Daily 9am", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0" },
  { label: "Weekdays 9am", rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0;BYSECOND=0" },
  { label: "Mon 9am", rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0;BYSECOND=0" },
];

export function SchedulePicker({ value, onChange }: Props) {
  const [state, setState] = useState<Parsed>(() => parse(value));

  useEffect(() => {
    setState(parse(value));
  }, [value]);

  const timeStr = useMemo(
    () => `${String(state.hour).padStart(2, "0")}:${String(state.minute).padStart(2, "0")}`,
    [state.hour, state.minute],
  );

  function update(patch: Partial<Parsed>) {
    const next = { ...state, ...patch };
    setState(next);
    onChange(build(next));
  }

  function toggleDay(code: string) {
    const has = state.byday.includes(code);
    const next = has ? state.byday.filter((d) => d !== code) : [...state.byday, code];
    update({ byday: next.length ? next : [code] });
  }

  return (
    <div className="sched">
      <Segmented options={FREQS} value={state.freq} onChange={(v) => update({ freq: v as Freq })} />

      {state.freq === "HOURLY" && (
        <div className="sched-row">
          <span className="sched-label">Every</span>
          <input
            type="number"
            min={1}
            max={24}
            value={state.interval}
            onChange={(e) => update({ interval: Math.max(1, Number(e.target.value) || 1) })}
            className="sched-num"
          />
          <span className="sched-label">hour(s)</span>
        </div>
      )}

      {state.freq === "WEEKLY" && (
        <div className="sched-days">
          {WEEKDAYS.map((d) => (
            <button
              key={d.code}
              type="button"
              className={`sched-day${state.byday.includes(d.code) ? " sched-day--on" : ""}`}
              onClick={() => toggleDay(d.code)}
            >
              {d.label}
            </button>
          ))}
        </div>
      )}

      {state.freq === "MONTHLY" && (
        <div className="sched-row">
          <span className="sched-label">Day of month</span>
          <input
            type="number"
            min={1}
            max={31}
            value={state.bymonthday}
            onChange={(e) => update({ bymonthday: Math.min(31, Math.max(1, Number(e.target.value) || 1)) })}
            className="sched-num"
          />
        </div>
      )}

      {state.freq !== "HOURLY" && (
        <div className="sched-row">
          <span className="sched-label">at</span>
          <input
            type="time"
            value={timeStr}
            onChange={(e) => {
              const [h, m] = e.target.value.split(":").map(Number);
              update({ hour: h || 0, minute: m || 0 });
            }}
            className="sched-time"
          />
        </div>
      )}

      <div className="sched-summary">
        <span className="sched-summary-dot" />
        {humanizeRrule(build(state))}
      </div>

      <div className="sched-quick">
        <span className="sched-quick-label">Presets</span>
        {QUICK.map((q) => (
          <button
            key={q.label}
            type="button"
            className="sched-quick-btn"
            onClick={() => {
              const p = parse(q.rrule);
              setState(p);
              onChange(build(p));
            }}
          >
            {q.label}
          </button>
        ))}
      </div>
    </div>
  );
}
