import {
  dbLoadThreadMessages, dbReplaceThreadMessages, type DbThreadMessage,
} from "../lib/db";
import type { ChatMessage } from "../types/chat";

// Node-scoped chat history for `chat` thread nodes — the canvas analogue of
// chatHistory.ts, keyed by node_id instead of project_id (see threads-plan.md
// §6.3). Loaded lazily when a chat node mounts; synchronous reads against the
// mirror, writes flush to SQLite async.
const _messages = new Map<string, ChatMessage[]>(); // nodeId -> messages
const logErr = (op: string) => (e: unknown) => console.error(`[threadMessages] ${op} failed:`, e);

const toChatMessage = (r: DbThreadMessage): ChatMessage => ({
  id: r.id,
  role: r.role as ChatMessage["role"],
  parts: JSON.parse(r.parts) as ChatMessage["parts"],
});

export async function loadNodeMessages(nodeId: string): Promise<ChatMessage[]> {
  const rows = await dbLoadThreadMessages(nodeId);
  const msgs = rows.map(toChatMessage);
  _messages.set(nodeId, msgs);
  return msgs;
}

export function getNodeMessages(nodeId: string): ChatMessage[] {
  return _messages.get(nodeId) ?? [];
}

export function saveNodeMessages(nodeId: string, msgs: ChatMessage[]): void {
  _messages.set(nodeId, msgs);
  dbReplaceThreadMessages(
    nodeId,
    msgs.map((m) => ({ id: m.id, role: m.role, parts: JSON.stringify(m.parts ?? []) })),
  ).catch(logErr("replace messages"));
}
