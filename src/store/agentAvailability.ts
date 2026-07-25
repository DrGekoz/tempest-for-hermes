import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getAgents } from '../lib/agentRegistry';

// undefined = not checked yet; true/false = result
export type AvailabilityMap = Record<string, boolean | undefined>;

let _state: AvailabilityMap = {};
const _checked = new Set<string>();
const _listeners = new Set<() => void>();

function notify() {
  _listeners.forEach(l => l());
}

export function useAgentAvailability(): AvailabilityMap {
  return useSyncExternalStore(
    cb => { _listeners.add(cb); return () => _listeners.delete(cb); },
    () => _state,
  );
}

// Check any agents not yet probed. Safe to call repeatedly — each hint is checked
// once. Called again after the remote manifest lands so new agents get probed too.
export function checkAgentAvailability(): void {
  for (const a of getAgents()) {
    if (_checked.has(a.hint)) continue;
    _checked.add(a.hint);
    const program = a.hint.split(' ')[0]!;
    invoke<boolean>('check_program_available', { program })
      .then(ok  => { _state = { ..._state, [a.hint]: ok };    notify(); })
      .catch(()  => { _state = { ..._state, [a.hint]: false }; notify(); });
  }
}
