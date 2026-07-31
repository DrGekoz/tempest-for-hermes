// Ambient "canvas-as-context" — a lightweight metadata graph of every node on a
// thread canvas, injected into a chat node's system prompt alongside the heavy
// wired-content block (see NewChatNode.buildConnectedContext). The model gets
// awareness of the whole canvas (kinds, titles, one-line gists, wiring) without
// paying for each node's full content — content still flows only through explicit
// incoming edges. Mirrors Slashspace's "context graph + metadata of the canvas".
//
// Pure module (type-only imports) so canvasContext.check.ts runs under bare node.
import type { ChatMessage, TextPart } from "../../types/chat";

export interface CanvasNodeMeta { id: string; kind: string; title: string; gist?: string; }
export interface CanvasEdgeMeta { source: string; target: string; }

// Last message as a short "role: text…" line — a chat node's persisted gist, so
// the canvas map can show recent state without loading full history.
export function chatGist(msgs: ChatMessage[]): string {
  const last = msgs[msgs.length - 1];
  if (!last) return "";
  const text = last.parts
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.content)
    .join("")
    .trim()
    .replace(/\s+/g, " ");
  if (!text) return "";
  return `${last.role}: ${text.length > 80 ? text.slice(0, 80) + "…" : text}`;
}

// First non-empty line of a body, trimmed — a text node's gist.
export function firstLine(s: string, max = 100): string {
  const line = (s ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > max ? line.slice(0, max) + "…" : line;
}

// Build the `## Canvas map` block from node + edge metadata. Excludes the calling
// chat node itself; caps node lines (a 100-node canvas stays affordable) and only
// renders edges among the shown nodes to avoid dangling ids.
export function formatCanvasGraph(
  nodes: CanvasNodeMeta[],
  edges: CanvasEdgeMeta[],
  selfId: string,
  max = 60,
): string {
  const others = nodes.filter((n) => n.id !== selfId);
  if (others.length === 0) return "";

  const shown = others.slice(0, max);
  const nodeLines = shown.map((n) => `- [${n.kind}] "${n.title}"${n.gist ? ` — ${n.gist}` : ""}`);
  if (others.length > max) nodeLines.push(`- …and ${others.length - max} more`);

  const shownIds = new Set(shown.map((n) => n.id));
  const titleOf = (id: string) =>
    id === selfId ? "this chat" : nodes.find((n) => n.id === id)?.title ?? id;
  const edgeLines = edges
    .filter(
      (e) =>
        (e.source === selfId || shownIds.has(e.source)) &&
        (e.target === selfId || shownIds.has(e.target)),
    )
    .map((e) => `- "${titleOf(e.source)}" → "${titleOf(e.target)}"`);

  let out =
    "## Canvas map (reference)\n" +
    "Every node on this canvas and how it's wired — ambient reference only: titles and a " +
    "one-line gist, NOT full content. Background you MAY consult, not your task. To read any " +
    "node's FULL content (a note's whole body, another chat's transcript), call " +
    "`read_canvas_node` with its title. Node(s) wired INTO this chat are its lineage — their " +
    'full content is inherited above under "Lineage".\n\n' +
    "Nodes:\n" +
    nodeLines.join("\n");
  if (edgeLines.length) out += "\n\nWiring:\n" + edgeLines.join("\n");
  return out;
}
