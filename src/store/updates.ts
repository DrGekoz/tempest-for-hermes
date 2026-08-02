import { useSyncExternalStore } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { openUrl } from '@tauri-apps/plugin-opener';
import { track } from '../lib/telemetry';

/// One check at startup, then once a day for as long as the app stays open.
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface State {
  update: Update | null;
  /// Cleared by every check, so dismissing hides the notice until the next
  /// 24h tick rather than forever.
  dismissed: boolean;
}

let _state: State = { update: null, dismissed: false };
let _started = false;
const _listeners = new Set<() => void>();

function notify() {
  _listeners.forEach(l => l());
}

/// The update worth showing, or `null` when there is none or it was dismissed.
export function useAvailableUpdate(): Update | null {
  const state = useSyncExternalStore(
    cb => { _listeners.add(cb); return () => _listeners.delete(cb); },
    () => _state,
  );
  return state.dismissed ? null : state.update;
}

export function dismissUpdate(): void {
  _state = { ..._state, dismissed: true };
  notify();
}

async function runCheck(): Promise<void> {
  try {
    // A resolved `null` means we are current; either way the result is fresh,
    // so a previous dismissal no longer applies.
    _state = { update: await check(), dismissed: false };
    notify();
  } catch (e) {
    // No network, GitHub down, malformed manifest — none of it is worth
    // surfacing. The user did not ask for this check.
    console.error('[updater] check failed:', e);
  }
}

/// Safe to call multiple times — only the first call schedules anything.
export function startUpdateChecks(): void {
  if (_started) return;
  _started = true;
  void runCheck();
  setInterval(() => void runCheck(), CHECK_INTERVAL_MS);
}

/// Download, install, and restart into the new version. On Windows the NSIS
/// installer runs in quiet mode and takes the app down with it, so everything
/// still running dies here.
export async function installUpdate(update: Update): Promise<void> {
  try {
    await update.downloadAndInstall();
    await relaunch();
  } catch (e) {
    void track("update_failed", { reason_kind: "install_error" });
    throw e;
  }
}

/// The release page. `latest.json` carries it in `notes`, which the plugin
/// surfaces as `body`.
export function openReleaseNotes(update: Update): void {
  if (update.body) openUrl(update.body).catch(() => {});
}
