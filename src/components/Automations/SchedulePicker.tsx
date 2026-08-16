import { useEffect, useMemo, useState } from "react";
import { SpSelect } from "../ui/SpSelect";
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

const WEEKDAYS = [
  { value: "MO", label: "Monday" },
  { value: "TU", label: "Tuesday" },
  { value: "WE", label: "Wednesday" },
  { value: "TH", label: "Thursday" },
  { value: "FR", label: "Friday" },
  { value: "SA", label: "Saturday" },
  { value: "SU", label: "Sunday" },
];

interface Parsed {
  freq: Freq;
  hour: number;     // local wall-clock hour (0–23)
  minute: number;   // local wall-clock minute
  byday: string[];
  bymonthday: number;
  interval: number;
}

// ponytail: uses current tz offset, so a rule created in DST will drift by an
// hour after the switch. Store TZID if that matters.
const TZ_OFFSET = new Date().getTimezoneOffset(); // minutes; -330 for IST
function utcToLocal(h: number, m: number) {
  const t = (((h * 60 + m - TZ_OFFSET) % 1440) + 1440) % 1440;
  return { hour: Math.floor(t / 60), minute: t % 60 };
}
function localToUtc(h: number, m: number) {
  const t = (((h * 60 + m + TZ_OFFSET) % 1440) + 1440) % 1440;
  return { hour: Math.floor(t / 60), minute: t % 60 };
}
function tzLabel(): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch { return ""; }
}

function parse(rrule: string): Parsed {
  const parts = new Map<string, string>();
  for (const seg of rrule.replace(/^RRULE:/, "").split(";")) {
    const [k, v] = seg.split("=");
    if (k && v) parts.set(k.toUpperCase(), v);
  }
  const raw = (parts.get("FREQ") as Freq) || "DAILY";
  const utcH = Number(parts.get("BYHOUR") ?? 9);
  const utcM = Number(parts.get("BYMINUTE") ?? 0);
  const { hour, minute } = utcToLocal(utcH, utcM);
  return {
    freq: (["HOURLY", "DAILY", "WEEKLY", "MONTHLY"] as Freq[]).includes(raw) ? raw : "DAILY",
    hour,
    minute,
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
    const { hour, minute } = localToUtc(p.hour, p.minute);
    bits.push(`BYHOUR=${hour}`, `BYMINUTE=${minute}`, `BYSECOND=0`);
  }
  return bits.join(";");
}

// Presets are defined in local time — they're translated to UTC BYHOUR at apply.
const BASE: Parsed = { freq: "DAILY", hour: 9, minute: 0, byday: ["MO"], bymonthday: 1, interval: 1 };
const QUICK: { label: string; state: Parsed }[] = [
  { label: "Every hour", state: { ...BASE, freq: "HOURLY" } },
  { label: "Daily 9am", state: { ...BASE, freq: "DAILY", hour: 9 } },
  { label: "Mon 9am", state: { ...BASE, freq: "WEEKLY", byday: ["MO"], hour: 9 } },
  { label: "Fri 5pm", state: { ...BASE, freq: "WEEKLY", byday: ["FR"], hour: 17 } },
];

function formatTime(h: number, m: number, h12: boolean): string {
  const mm = String(m).padStart(2, "0");
  if (!h12) return `${String(h).padStart(2, "0")}:${mm}`;
  const period = h >= 12 ? "PM" : "AM";
  const hv = h % 12 === 0 ? 12 : h % 12;
  return `${hv}:${mm} ${period}`;
}
function parseTime(s: string, h12: boolean): { hour: number; minute: number } | null {
  const t = s.trim();
  if (h12) {
    const m = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(t);
    if (!m) return null;
    let h = Number(m[1]);
    const min = Number(m[2]);
    if (h < 1 || h > 12 || min < 0 || min > 59) return null;
    if (h === 12) h = 0;
    if (m[3].toLowerCase() === "pm") h += 12;
    return { hour: h, minute: min };
  }
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { hour: h, minute: min };
}

export function SchedulePicker({ value, onChange }: Props) {
  const [state, setState] = useState<Parsed>(() => parse(value));
  const [hour12, setHour12] = useState(false);
  const [timeDraft, setTimeDraft] = useState(() => formatTime(state.hour, state.minute, false));
  const tz = useMemo(tzLabel, []);

  useEffect(() => { setState(parse(value)); }, [value]);
  useEffect(() => {
    setTimeDraft(formatTime(state.hour, state.minute, hour12));
  }, [state.hour, state.minute, hour12]);

  function update(patch: Partial<Parsed>) {
    const next = { ...state, ...patch };
    setState(next);
    onChange(build(next));
  }
  function applyState(next: Parsed) {
    setState(next);
    onChange(build(next));
  }
  function commitTime() {
    const parsed = parseTime(timeDraft, hour12);
    if (!parsed) {
      setTimeDraft(formatTime(state.hour, state.minute, hour12));
      return;
    }
    update(parsed);
  }

  return (
    <div className="sched">
      <div className="sched-row">
        <label className="sched-lbl">Frequency</label>
        <SpSelect
          className="sched-ctrl"
          value={state.freq}
          onChange={(v) => update({ freq: v as Freq })}
          options={FREQS}
        />
      </div>

      {state.freq === "WEEKLY" && (
        <div className="sched-row">
          <label className="sched-lbl">Day</label>
          <SpSelect
            className="sched-ctrl"
            value={state.byday[0] ?? "MO"}
            onChange={(v) => update({ byday: [v] })}
            options={WEEKDAYS}
          />
        </div>
      )}

      {state.freq === "MONTHLY" && (
        <div className="sched-row">
          <label className="sched-lbl">Day of month</label>
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

      {state.freq === "HOURLY" && (
        <div className="sched-row">
          <label className="sched-lbl">Every</label>
          <div className="sched-ctrl-inline">
            <input
              type="number"
              min={1}
              max={24}
              value={state.interval}
              onChange={(e) => update({ interval: Math.max(1, Number(e.target.value) || 1) })}
              className="sched-num"
            />
            <span className="sched-unit">hour{state.interval === 1 ? "" : "s"}</span>
          </div>
        </div>
      )}

      {state.freq !== "HOURLY" && (
        <div className="sched-row">
          <label className="sched-lbl">Time</label>
          <div className="sched-ctrl-inline">
            <input
              type="text"
              className="sched-time-input"
              value={timeDraft}
              onChange={(e) => setTimeDraft(e.target.value)}
              onBlur={commitTime}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitTime(); } }}
              placeholder={hour12 ? "9:00 AM" : "09:00"}
            />
            <div className="sched-hfmt" role="group">
              {(["24", "12"] as const).map((h) => {
                const active = (hour12 ? "12" : "24") === h;
                return (
                  <button
                    key={h}
                    type="button"
                    className={`sched-hfmt-btn${active ? " sched-hfmt-btn--on" : ""}`}
                    onClick={() => setHour12(h === "12")}
                  >
                    {h}h
                  </button>
                );
              })}
            </div>
            {tz && <span className="sched-tz">{tz}</span>}
          </div>
        </div>
      )}

      <div className="sched-presets">
        <span className="sched-presets-label">Or start from</span>
        {QUICK.map((q) => (
          <button
            key={q.label}
            type="button"
            className="sched-preset"
            onClick={() => applyState(q.state)}
          >
            {q.label}
          </button>
        ))}
      </div>
    </div>
  );
}
