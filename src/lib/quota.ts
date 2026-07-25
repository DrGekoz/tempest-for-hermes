// Rate-limit windows read from the agent CLIs' own credentials, surfaced by the
// title-bar island. Pure shape + formatting here; the reader lands beside it.

export interface QuotaWindow {
  /** Stable key — provider + window, e.g. `claude-5h`. */
  id: string;
  /** Shown verbatim in the island, e.g. `Claude · 5h`. */
  label: string;
  /** Fraction of the window consumed. Clamped on display, not here. */
  used: number;
  /** Epoch ms at which the window rolls over. */
  resetsAt: number;
}

export type QuotaLevel = "ok" | "warn" | "crit";

/** Below WARN the island stays a dot; at WARN it opens up and names the window. */
export const WARN = 0.75;
export const CRIT = 0.9;

export function levelOf(used: number): QuotaLevel {
  return used >= CRIT ? "crit" : used >= WARN ? "warn" : "ok";
}

export function pct(used: number): number {
  return Math.round(Math.min(1, Math.max(0, used)) * 100);
}

/** The window the island speaks for: the fullest one. */
export function peakQuota(quotas: QuotaWindow[]): QuotaWindow | null {
  return quotas.reduce<QuotaWindow | null>((a, b) => (a && a.used >= b.used ? a : b), null);
}

/**
 * Stand-in so the island can be looked at before the reader exists — wired in
 * under `import.meta.env.DEV` only, so it never reaches a build. Delete this
 * and its call site once real windows are being read.
 * ponytail: dev-only placeholder, goes away with the CLI reader.
 */
export const SAMPLE_QUOTAS: QuotaWindow[] = [
  { id: "claude-5h", label: "Claude · 5h", used: 0.82, resetsAt: Date.now() + 134 * 60_000 },
  { id: "claude-week", label: "Claude · weekly", used: 0.41, resetsAt: Date.now() + 3.2 * 86_400_000 },
  { id: "codex", label: "Codex", used: 0.16, resetsAt: Date.now() + 47 * 60_000 },
];

export function formatReset(resetsAt: number, now = Date.now()): string {
  const ms = resetsAt - now;
  if (ms <= 0) return "resetting";
  // Round to whole minutes first so 59m30s never prints as "0h 60m".
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return `resets in ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `resets in ${h}h ${m}m` : `resets in ${h}h`;
}
