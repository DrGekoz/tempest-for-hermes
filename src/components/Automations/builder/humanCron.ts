// Human-friendly schedule presets over cron strings.
// The graph still stores raw cron ("0 9 * * 1-5") so the Rust writer is unchanged.
// Custom-cron is no code path in the UI — unrecognized cron parses to `custom`
// only as a *display* fallback (the readback shows the raw string) so old data
// stays viewable; the picker never exposes it as a selectable preset.

export type SchedulePreset =
  | "every-minutes"
  | "every-hours"
  | "daily"
  | "weekdays"
  | "on-days"          // subset of weekdays at one time  → "M H * * D,D,D"
  | "times-per-day"    // several hours (shared minute)   → "M H,H,H * * *"
  | "weekly"
  | "monthly"
  | "custom";          // read-only fallback for unknown cron

export interface ScheduleState {
  preset: SchedulePreset;
  n: number;              // every-minutes / every-hours
  hour: number;           // 0-23
  minute: number;         // 0-59
  weekday: number;        // 0-6 (Sun=0)  — weekly
  day: number;            // 1-28         — monthly
  weekdays: number[];     // sorted subset of 0-6 — on-days
  hours: number[];        // sorted subset of 0-23 — times-per-day
}

const DEFAULT: ScheduleState = {
  preset: "weekdays",
  n: 15,
  hour: 9,
  minute: 0,
  weekday: 1,
  day: 1,
  weekdays: [1, 3, 5],
  hours: [9, 15],
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pad(n: number) { return String(n).padStart(2, "0"); }

export function formatTime(h: number, m: number): string {
  const period = h < 12 ? "AM" : "PM";
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${pad(m)} ${period}`;
}

const parseList = (s: string, max: number): number[] | null => {
  const out: number[] = [];
  for (const p of s.split(",")) {
    if (!/^\d+$/.test(p)) return null;
    const n = +p;
    if (n < 0 || n > max) return null;
    out.push(n);
  }
  return Array.from(new Set(out)).sort((a, b) => a - b);
};

// Parse a cron string back into a preset+state. Falls back to "custom" if it
// doesn't match one of the friendly patterns — the picker treats that as
// read-only, but readback still shows the raw string.
export function parseCron(cron: string): ScheduleState {
  const s = (cron || "").trim();
  if (!s) return DEFAULT;
  const parts = s.split(/\s+/);
  if (parts.length !== 5) return { ...DEFAULT, preset: "custom" };
  const [mn, hr, dom, mon, dow] = parts;

  const mMin = /^\*\/(\d+)$/.exec(mn);
  if (mMin && hr === "*" && dom === "*" && mon === "*" && dow === "*") {
    return { ...DEFAULT, preset: "every-minutes", n: Math.max(1, +mMin[1]) };
  }
  const mHr = /^\*\/(\d+)$/.exec(hr);
  if (mn === "0" && mHr && dom === "*" && mon === "*" && dow === "*") {
    return { ...DEFAULT, preset: "every-hours", n: Math.max(1, +mHr[1]) };
  }
  const isNum = (v: string) => /^\d+$/.test(v);

  // times-per-day: M H1,H2,H3 * * *
  if (isNum(mn) && mn.length && dom === "*" && mon === "*" && dow === "*" && hr.includes(",")) {
    const hours = parseList(hr, 23);
    if (hours) return { ...DEFAULT, preset: "times-per-day", minute: +mn, hours };
  }

  if (isNum(mn) && isNum(hr) && mon === "*") {
    const minute = +mn, hour = +hr;
    if (dom === "*" && dow === "*") return { ...DEFAULT, preset: "daily", hour, minute };
    if (dom === "*" && dow === "1-5") return { ...DEFAULT, preset: "weekdays", hour, minute };
    if (dom === "*" && dow.includes(",")) {
      const weekdays = parseList(dow, 6);
      if (weekdays) return { ...DEFAULT, preset: "on-days", hour, minute, weekdays };
    }
    if (dom === "*" && isNum(dow)) return { ...DEFAULT, preset: "weekly", hour, minute, weekday: +dow };
    if (isNum(dom) && dow === "*") return { ...DEFAULT, preset: "monthly", hour, minute, day: +dom };
  }
  return { ...DEFAULT, preset: "custom" };
}

export function buildCron(st: ScheduleState): string {
  switch (st.preset) {
    case "every-minutes": return `*/${Math.max(1, Math.min(59, st.n | 0))} * * * *`;
    case "every-hours":   return `0 */${Math.max(1, Math.min(23, st.n | 0))} * * *`;
    case "daily":         return `${st.minute} ${st.hour} * * *`;
    case "weekdays":      return `${st.minute} ${st.hour} * * 1-5`;
    case "on-days": {
      const ds = (st.weekdays.length ? st.weekdays : [1]).slice().sort((a, b) => a - b).join(",");
      return `${st.minute} ${st.hour} * * ${ds}`;
    }
    case "times-per-day": {
      const hs = (st.hours.length ? st.hours : [9]).slice().sort((a, b) => a - b).join(",");
      return `${st.minute} ${hs} * * *`;
    }
    case "weekly":        return `${st.minute} ${st.hour} * * ${st.weekday}`;
    case "monthly":       return `${st.minute} ${st.hour} ${Math.max(1, Math.min(28, st.day | 0))} * *`;
    case "custom":        return "";
  }
}

const listWeekdays = (ds: number[]): string =>
  ds.length === 0 ? "no days"
  : ds.length === 1 ? WEEKDAYS[ds[0]]
  : ds.slice(0, -1).map(d => WEEKDAYS_SHORT[d]).join(", ") + " and " + WEEKDAYS_SHORT[ds[ds.length - 1]];

export function describeCron(cron: string): string {
  const st = parseCron(cron);
  switch (st.preset) {
    case "every-minutes": return `Every ${st.n} minute${st.n === 1 ? "" : "s"}`;
    case "every-hours":   return `Every ${st.n} hour${st.n === 1 ? "" : "s"}`;
    case "daily":         return `Every day at ${formatTime(st.hour, st.minute)}`;
    case "weekdays":      return `Weekdays at ${formatTime(st.hour, st.minute)}`;
    case "on-days":       return `${listWeekdays(st.weekdays)} at ${formatTime(st.hour, st.minute)}`;
    case "times-per-day": {
      const hs = st.hours.map(h => formatTime(h, st.minute)).join(", ");
      return `Every day at ${hs}`;
    }
    case "weekly":        return `Every ${WEEKDAYS[st.weekday]} at ${formatTime(st.hour, st.minute)}`;
    case "monthly":       return `Day ${st.day} each month at ${formatTime(st.hour, st.minute)}`;
    case "custom":        return cron ? `Custom cron: ${cron}` : "No schedule set";
  }
}

export const WEEKDAY_NAMES = WEEKDAYS;
export const WEEKDAY_NAMES_SHORT = WEEKDAYS_SHORT;
