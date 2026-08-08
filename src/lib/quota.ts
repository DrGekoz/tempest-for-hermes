// Rate-limit windows read from the agent CLIs' own credentials, surfaced by the
// title-bar island. Pure shape + formatting here; the reader is `store/quotas.ts`.

export interface QuotaWindow {
  /** Stable key — provider + window, e.g. `claude:five_hour`. */
  id: string;
  /** Shown verbatim in the island, e.g. `Claude · 5-hour`. */
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

// ── ProviderUsage — mirror of the Rust `ProviderUsage` type ─────────────────
// Uniform envelope so the island renders every provider through the same
// component, even the ones that only expose a plan name (Copilot) or a USD
// balance (Cursor) instead of a percent window.

export type ProviderStatus = "available" | "unavailable" | "error";
export type Tone = "default" | "ok" | "warning" | "danger";

export interface Window {
  id: string;
  label: string;
  used: number | null;
  resetsAt: number | null;
  tone: Tone;
}

export interface Balance {
  id: string;
  label: string;
  used: number | null;
  remaining: number | null;
  limit: number | null;
  /** "usd" | "credits" | "requests" | "tokens" */
  unit: string;
  resetsAt: number | null;
  tone: Tone;
}

export interface Detail {
  label: string;
  value: string;
}

export interface ProviderUsage {
  providerId: string;
  displayName: string;
  status: ProviderStatus;
  planLabel: string | null;
  windows: Window[];
  balances: Balance[];
  details: Detail[];
  error: string | null;
}

/// Every window across every provider, flattened + namespaced, so `peakQuota`
/// can pick the single fullest one for the island to speak for.
export function windowsFromProviders(providers: ProviderUsage[]): QuotaWindow[] {
  const out: QuotaWindow[] = [];
  for (const p of providers) {
    if (p.status !== "available") continue;
    for (const w of p.windows) {
      if (w.used == null || w.resetsAt == null) continue;
      out.push({
        id: `${p.providerId}:${w.id}`,
        label: `${p.displayName} · ${w.label}`,
        used: w.used,
        resetsAt: w.resetsAt,
      });
    }
  }
  return out;
}
