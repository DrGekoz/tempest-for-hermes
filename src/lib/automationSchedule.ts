import { RRule } from "rrule";

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
    // BYHOUR/BYMINUTE are stored in UTC; shift them to the viewer's local
    // wall-clock time before humanizing so "Daily 9am" reads as 9am wherever
    // they are, not 9am GMT.
    const opts = { ...rule.origOptions };
    const byhour = opts.byhour;
    const byminute = opts.byminute;
    const utcH = Array.isArray(byhour) ? byhour[0] : (typeof byhour === "number" ? byhour : undefined);
    const utcM = Array.isArray(byminute) ? byminute[0] : (typeof byminute === "number" ? byminute : undefined);
    if (utcH !== undefined || utcM !== undefined) {
      const offset = new Date().getTimezoneOffset();
      const total = ((((utcH ?? 0) * 60 + (utcM ?? 0) - offset) % 1440) + 1440) % 1440;
      opts.byhour = [Math.floor(total / 60)];
      opts.byminute = [total % 60];
    }
    return new RRule(opts).toText();
  } catch {
    return rruleStr;
  }
}

export function promptBucketAt(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const minute = Math.floor(now.getMinutes() / 10) * 10;
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(minute)}`;
}
