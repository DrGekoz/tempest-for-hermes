// Telemetry choke point.
//
// The ONLY place PostHog is touched. Nothing here runs — the posthog-js code is
// not even loaded into memory — until the user has explicitly opted in. Three
// gates, all default-closed:
//   1. `telemetryEnabled` in AppSettings defaults to false (see appSettings.ts).
//   2. The posthog-js module is dynamic-imported only after consent, so with no
//      opt-in the library never loads, never inits, never opens a connection.
//   3. Every event goes through `track()`, which re-checks consent on each call.
//
// Every state transition and every event is logged to the console so there is a
// visible, auditable trail of exactly when anything wakes up or fires.
import { getSettings, updateSetting } from "../store/appSettings";
import { getRuntimeState, setRuntimeState } from "./runtimeState";

// Sourced from build-time env so the key is never hardcoded. If absent,
// telemetry stays fully dormant regardless of consent — a fourth safety gate.
const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const POSTHOG_HOST =
  (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? "https://us.i.posthog.com";

const LOG = "[telemetry]";

type PostHog = typeof import("posthog-js")["default"];
let ph: PostHog | null = null; // set only after a real, consented init
let initPromise: Promise<PostHog | null> | null = null;
let warnedNoKey = false;

/** Load + init PostHog on first need. Returns null unless fully consented. */
async function ensureInit(): Promise<PostHog | null> {
  if (ph) return ph;
  if (getSettings().telemetryEnabled !== true) return null; // gate: no consent
  if (!POSTHOG_KEY) {
    if (!warnedNoKey) {
      console.warn(`${LOG} consent is ON but no VITE_POSTHOG_KEY configured — staying dormant`);
      warnedNoKey = true;
    }
    return null;
  }
  if (initPromise) return initPromise;
  initPromise = (async () => {
    // Durable anonymous id, minted once at first opt-in and kept on disk. Pinning
    // distinct_id here means the identity is ours, stable across restarts and
    // localStorage clears — and we never call identify(), so it stays anonymous.
    let anonId = getRuntimeState().telemetryAnonId;
    if (!anonId) {
      anonId = crypto.randomUUID();
      setRuntimeState({ telemetryAnonId: anonId });
      console.info(`${LOG} minted anonymous id (first opt-in)`);
    }
    console.info(`${LOG} consent present — loading PostHog for the first time`);
    const posthog = (await import("posthog-js")).default;
    posthog.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      autocapture: false,
      capture_pageview: false,
      disable_session_recording: true,
      persistence: "localStorage",
      bootstrap: { distinctID: anonId },
      loaded: () => console.info(`${LOG} PostHog initialized as ${anonId} — events will now be sent`),
    });
    ph = posthog;
    return posthog;
  })();
  return initPromise;
}

/**
 * Record one event. No-op (nothing loaded, nothing sent) unless the user has
 * opted in. This is the single choke point — never call posthog.capture directly.
 */
export async function track(event: string, props?: Record<string, unknown>): Promise<void> {
  if (getSettings().telemetryEnabled !== true) return; // gate, checked every call
  const posthog = await ensureInit();
  if (!posthog) return;
  console.info(`${LOG} fire → ${event}`, props ?? {});
  posthog.capture(event, props);
}

/** Snapshot of config on the anonymous person, for segmentation. Gated. */
export async function setPersonProperties(props: Record<string, unknown>): Promise<void> {
  if (getSettings().telemetryEnabled !== true) return;
  const posthog = await ensureInit();
  if (!posthog) return;
  console.info(`${LOG} person properties`, props);
  posthog.setPersonProperties(props);
}

/** Coarse OS bucket from the webview UA — no fingerprinting detail. */
export function osName(): "windows" | "macos" | "linux" | "other" {
  const ua = navigator.userAgent;
  if (ua.includes("Windows")) return "windows";
  if (ua.includes("Mac")) return "macos";
  if (ua.includes("Linux")) return "linux";
  return "other";
}

/** Flip consent and act on it. The single writer for `telemetryEnabled`. */
export function setTelemetryEnabled(next: boolean): void {
  updateSetting("telemetryEnabled", next);
  if (next) {
    console.info(`${LOG} consent GRANTED by user`);
    void ensureInit().then((p) => p?.opt_in_capturing());
  } else {
    console.info(`${LOG} consent REVOKED by user — opting out and halting capture`);
    ph?.opt_out_capturing();
    ph?.reset();
  }
}
