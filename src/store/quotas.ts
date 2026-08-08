// Polls the Rust `quota_read_all` command on a 5-minute cadence and exposes
// the current provider list through a `useSyncExternalStore` subscription.
// Explicit refresh is available for "reload now" buttons.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProviderUsage } from "../lib/quota";

const REFRESH_MS = 5 * 60_000;

let _providers: ProviderUsage[] = [];
let _lastFetch = 0;
let _inflight: Promise<ProviderUsage[]> | null = null;
let _timer: ReturnType<typeof setInterval> | null = null;
const _listeners = new Set<() => void>();

function emit() { _listeners.forEach((fn) => fn()); }

async function pull(): Promise<ProviderUsage[]> {
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const list = await invoke<ProviderUsage[]>("quota_read_all");
      _providers = list;
      _lastFetch = Date.now();
      emit();
      return list;
    } catch (e) {
      // Silent: a failed pull leaves the last-known list in place. A hard error
      // in the command itself (rare) shouldn't blank the island; the console
      // is enough for debugging.
      console.warn("[quotas] pull failed:", e);
      return _providers;
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

/// Kick the first pull and start the interval. Idempotent — safe to call from
/// multiple mount points; only the first call starts the timer.
export function startQuotaPolling(): void {
  if (_timer) return;
  void pull();
  _timer = setInterval(() => { void pull(); }, REFRESH_MS);
}

/// Force a fresh fetch (bypasses no cache — we don't hold one here, but the
/// hook is useful for a manual refresh button).
export function refreshQuotas(): Promise<ProviderUsage[]> {
  return pull();
}

export function getQuotas(): ProviderUsage[] { return _providers; }
export function getLastFetched(): number { return _lastFetch; }

export function useQuotas(): ProviderUsage[] {
  return useSyncExternalStore(
    (cb) => { _listeners.add(cb); return () => _listeners.delete(cb); },
    () => _providers,
  );
}
