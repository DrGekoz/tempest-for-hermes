import { RRule } from "rrule";

export const SCHEDULE_PRESETS = [
  { label: "Hourly",            rrule: "FREQ=HOURLY;INTERVAL=1" },
  { label: "Daily at 9AM",      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0" },
  { label: "Weekdays at 9AM",   rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0;BYSECOND=0" },
  { label: "Weekly Mon 9AM",    rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0;BYSECOND=0" },
  { label: "Custom RRULE",      rrule: "" },
] as const;

export function validateRrule(s: string): string | null {
  if (!s.trim()) return "RRULE is required";
  try {
    RRule.fromString(s.startsWith("RRULE:") ? s : `RRULE:${s}`);
    return null;
  } catch {
    return "Invalid RRULE";
  }
}

export function computeNextRunAt(rruleStr: string, dtstart?: Date, _tz?: string): string | null {
  try {
    const rule = RRule.fromString(
      rruleStr.startsWith("RRULE:") ? rruleStr : `RRULE:${rruleStr}`,
    );
    const base = dtstart ?? new Date();
    const next = rule.after(base, false);
    return next ? next.toISOString() : null;
  } catch {
    return null;
  }
}

export function humanizeRrule(rruleStr: string): string {
  try {
    const rule = RRule.fromString(
      rruleStr.startsWith("RRULE:") ? rruleStr : `RRULE:${rruleStr}`,
    );
    return rule.toText();
  } catch {
    return rruleStr;
  }
}

export function promptBucketAt(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const minute = Math.floor(now.getMinutes() / 10) * 10;
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(minute)}`;
}
