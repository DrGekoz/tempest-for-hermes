import {
  dbListThreads, dbUpsertThread, dbDeleteThread,
  dbListThreadNodes, dbUpsertThreadNode, dbDeleteThreadNode,
  type DbThread, type DbThreadNode,
} from "../lib/db";

// In-memory mirror of the threads / thread_nodes tables (canvas chat — see
// claude-docs/threads-plan.md). Unlike sessions.ts, threads are project-scoped
// and loaded lazily: loadProjectThreads(projectId) on project open,
// loadThreadNodes(threadId) on canvas open. Reads are synchronous against the
// maps; writes update the mirror synchronously and flush to SQLite async.
const _threads = new Map<string, DbThread>();     // threadId  -> thread
const _nodes = new Map<string, DbThreadNode>();   // nodeId    -> node

const logErr = (op: string) => (e: unknown) => console.error(`[threads] ${op} failed:`, e);

// ── Hydration ────────────────────────────────────────────────────────────────
export async function loadProjectThreads(projectId: string): Promise<DbThread[]> {
  const rows = await dbListThreads(projectId);
  for (const t of rows) _threads.set(t.id, t);
  return rows;
}

export async function loadThreadNodes(threadId: string): Promise<DbThreadNode[]> {
  const rows = await dbListThreadNodes(threadId);
  for (const n of rows) _nodes.set(n.id, n);
  return rows;
}

// ── Reads (synchronous, against the mirror) ──────────────────────────────────
// Ties (equal sort_order) fall back to id so the order stays total.
function bySortOrder(a: DbThread, b: DbThread): number {
  return a.sortOrder - b.sortOrder || a.id.localeCompare(b.id);
}

export function getProjectThreads(projectId: string): DbThread[] {
  return [..._threads.values()].filter((t) => t.projectId === projectId).sort(bySortOrder);
}

export function getThread(id: string): DbThread | null {
  return _threads.get(id) ?? null;
}

export function getThreadNodes(threadId: string): DbThreadNode[] {
  return [..._nodes.values()].filter((n) => n.threadId === threadId);
}

export function getThreadNode(id: string): DbThreadNode | null {
  return _nodes.get(id) ?? null;
}

// ── Writes (sync mirror + async SQLite) ──────────────────────────────────────
export function saveThread(thread: DbThread): void {
  _threads.set(thread.id, thread);
  dbUpsertThread(thread).catch(logErr("save thread"));
}

export function deleteThread(id: string): void {
  _threads.delete(id);
  for (const [nid, n] of _nodes) if (n.threadId === id) _nodes.delete(nid);
  dbDeleteThread(id).catch(logErr("delete thread")); // DB cascade drops nodes + messages
}

// Persist a node, chaining its parent thread first so the FK always holds — the
// two commands otherwise acquire the Rust connection mutex in unspecified order
// and the node's thread_id FK could be rejected (mirrors persistSession).
export function saveThreadNode(node: DbThreadNode): void {
  _nodes.set(node.id, node);
  const thread = _threads.get(node.threadId);
  const chain = thread ? dbUpsertThread(thread) : Promise.resolve();
  chain.then(() => dbUpsertThreadNode(node)).catch(logErr("save thread node"));
}

export function deleteThreadNode(id: string): void {
  if (!_nodes.delete(id)) return;
  dbDeleteThreadNode(id).catch(logErr("delete thread node"));
}
