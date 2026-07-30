// Per-workspace service port. Two worktrees both running `npm run dev` both want
// :3000; this gives each one a stable, distinct port derived from its path, so
// parallel branches stop colliding. Deterministic — no state, no registry: the
// same worktree always resolves to the same port, which is the "stable address"
// the service proxy promised, minus a reverse proxy.
//
// ponytail: deterministic hash into a 1000-port span, so N simultaneous
// worktrees carry a birthday-style collision chance (~18% at 20). Upgrade path
// if it bites: a persisted allocation table in tempest.db keyed on worktree path.

const PORT_BASE = 3000;
const PORT_SPAN = 1000; // 3000–3999

/// Normalize so `\` vs `/` and a trailing slash never split one worktree into
/// two ports.
function key(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/// djb2 — small, stable, and good enough spread for filesystem paths that share
/// a long common prefix and differ only in the worktree name.
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) + s.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

/// The dev-server port allocated to the workspace rooted at `path`.
export function portForWorkspace(path: string): number {
  return PORT_BASE + (hash(key(path)) % PORT_SPAN);
}
