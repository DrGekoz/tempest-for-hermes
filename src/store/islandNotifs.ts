import { getSession } from "./sessions";
import { getSettings } from "./appSettings";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { resolveResource } from "@tauri-apps/api/path";

// Windows toast notifications only show an app icon when the app is installed
// with a Start Menu shortcut (AppUserModelID). In dev — and even sometimes in
// installed builds — the OS falls back to a generic icon. Passing an absolute
// `icon` path forces the notification to render our logo. Resolved once and
// cached; resolveResource is a filesystem lookup, no need to repeat it.
let _iconPathPromise: Promise<string | undefined> | null = null;
function getIconPath(): Promise<string | undefined> {
  if (!_iconPathPromise) {
    _iconPathPromise = resolveResource("icons/128x128.png").catch(() => undefined);
  }
  return _iconPathPromise;
}

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
  // Canvas-placed sessions (agent/terminal nodes) have no tab and no island — the
  // node is their sole home. Never route their permission/done events to the island.
  // Both sources (agent-hook receiver + PTY heuristics) funnel through here.
  if (getSession(n.sessionId)?.placement === "canvas") return;
  // If the user is already looking at this session's tab, the notif is just
  // noise — they see the terminal directly. Suppress it at the source so every
  // caller (hook receiver + PTY heuristics) is covered by one guard.
  if (isViewingSession(n.sessionId)) return;
  // One notif per session per type. The same permission prompt is surfaced by
  // several sources (hook receiver plus the 3s/8s/20s PTY rechecks), so without
  // this a single event stacks 4–5 identical "permission needed" rows. Drop any
  // prior match and keep the freshest.
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  _notifs = [{ ...n, id }, ..._notifs.filter((e) => !(e.sessionId === n.sessionId && e.type === n.type))].slice(0, MAX);
  emit();
  // OS-level notification when the user is away (window unfocused). The
  // in-app island already covers the "focused, different tab" case; only the
  // away case needs to break through to the desktop.
  if (!document.hasFocus() && getSettings().desktopNotifications) {
    void fireDesktopNotif(n);
  }
}

async function fireDesktopNotif(n: Omit<IslandNotif, "id">): Promise<void> {
  try {
    const granted = (await isPermissionGranted()) || (await requestPermission()) === "granted";
    if (!granted) return;
    const body = n.type === "permission"
      ? `${n.agent} is asking for permission${n.detail ? ` — ${n.detail}` : ""}`
      : `${n.agent} finished`;
    const icon = await getIconPath();
    sendNotification({ title: n.title, body, icon });
  } catch { /* notification plugin unavailable; ignore */ }
}

export function dismissIslandNotif(id: string): void {
  _notifs = _notifs.filter((n) => n.id !== id);
  emit();
}

export function getIslandNotifs(): IslandNotif[] {
  return _notifs;
}

// "View Agent" in the island lives in the title bar; the session it focuses is
// owned by WorkspaceView. WorkspaceView registers a handler here, the island
// calls it — same shape as `setActiveIslandSession`, other direction.
let _focusHandler: ((sessionId: string) => void) | null = null;
export function onIslandFocusRequest(fn: (sessionId: string) => void): () => void {
  _focusHandler = fn;
  return () => { if (_focusHandler === fn) _focusHandler = null; };
}
export function requestIslandFocus(sessionId: string): void {
  _focusHandler?.(sessionId);
}

export function subscribeIslandNotifs(cb: () => void): () => void {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}
