export type IslandNotifType = "permission" | "done";

export interface IslandNotif {
  id: string;
  type: IslandNotifType;
  agent: string;
  title: string;
  detail: string;
  sessionId: string;
}

const MAX = 20;
let _notifs: IslandNotif[] = [];
const _listeners = new Set<() => void>();

// The session tab the user is currently looking at. Notifs for this session are
// redundant while the window is focused — the user sees the terminal directly —
// so the agent-hook receiver skips them. Set by WorkspaceView.
let _activeSessionId: string | null = null;
export function setActiveIslandSession(id: string | null): void { _activeSessionId = id; }

// True when a notif for `sessionId` would be redundant: it's the focused tab.
function isViewingSession(sessionId: string): boolean {
  return sessionId === _activeSessionId && document.hasFocus();
}

function emit() {
  _listeners.forEach((fn) => fn());
}

export function pushIslandNotif(n: Omit<IslandNotif, "id">): void {
  // If the user is already looking at this session's tab, the notif is just
  // noise — they see the terminal directly. Suppress it at the source so every
  // caller (hook receiver + PTY heuristics) is covered by one guard.
  if (isViewingSession(n.sessionId)) return;
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  _notifs = [{ ...n, id }, ..._notifs].slice(0, MAX);
  emit();
}

export function dismissIslandNotif(id: string): void {
  _notifs = _notifs.filter((n) => n.id !== id);
  emit();
}

export function getIslandNotifs(): IslandNotif[] {
  return _notifs;
}

export function subscribeIslandNotifs(cb: () => void): () => void {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}
