import { useContext } from "react";
import { Maximize2, MessagesSquare, StickyNote, Bot, SquareTerminal } from "lucide-react";
import { NodeConnector } from "./NodeConnector";
import { getThreadNode, getNodeData } from "../../../store/threads";
import { getSession, getBranch } from "../../../store/sessions";
import { firstLine } from "../canvasContext";
import { ThreadNodeContext } from "../ThreadNodeContext";

// Compact form of any node when data.collapsed is set (Minimize all / per-node
// maximize). A single-row pill — kind icon, title, one-line gist — reusing the
// same metadata the canvas map shows (no full content loaded). Connectors stay
// live so wiring survives collapse; double-click or the maximize button expands.
const ICON: Record<string, typeof StickyNote> = {
  chat: MessagesSquare, text: StickyNote, agent: Bot, terminal: SquareTerminal,
};

function gistFor(id: string, kind: string, data: { body?: string; gist?: string; msgCount?: number }): string {
  if (kind === "text") return firstLine(data.body ?? "");
  if (kind === "chat") {
    const parts: string[] = [];
    if (data.msgCount) parts.push(`${data.msgCount} msg${data.msgCount === 1 ? "" : "s"}`);
    if (data.gist) parts.push(data.gist);
    return parts.join(" · ");
  }
  // agent / terminal — branch binding, no PTY scrollback.
  const node = getThreadNode(id);
  const bid = node?.sessionId ? getSession(node.sessionId)?.branchId : node?.branchId;
  const branch = bid ? getBranch(bid)?.name : undefined;
  return branch ?? "session";
}

export function CollapsedNode({ id }: { id: string }) {
  const ctx = useContext(ThreadNodeContext);
  const node = getThreadNode(id);
  const kind = node?.kind ?? "text";
  const data = getNodeData<{ title?: string; body?: string; gist?: string; msgCount?: number }>(id);
  const title = data.title ?? kind;
  const Icon = ICON[kind] ?? StickyNote;
  const gist = gistFor(id, kind, data);
  const expand = () => ctx?.setNodeCollapsed?.(id, false);

  return (
    <div
      className="tnode-card"
      onDoubleClick={expand}
      style={{
        width: "100%", boxSizing: "border-box", cursor: "grab",
        display: "flex", alignItems: "center", gap: 8, overflow: "hidden",
        padding: "7px 9px", whiteSpace: "nowrap",
        background: "var(--tempest-bg-elevated, #161616)",
        border: "1px solid var(--tempest-border-subtle, #2a2a2a)",
        borderRadius: 8,
        font: '12px "Geist", system-ui, sans-serif',
      }}
    >
      <NodeConnector nodeId={id} side="left" />
      <Icon size={14} style={{ flexShrink: 0, opacity: 0.7 }} />
      <span style={{
        color: "var(--tempest-fg-default, #e6e6e6)", flexShrink: 0,
        maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis",
      }}>{title}</span>
      {gist && (
        <span style={{
          color: "var(--tempest-fg-muted, #888)", minWidth: 0,
          overflow: "hidden", textOverflow: "ellipsis",
        }}>{gist}</span>
      )}
      <div style={{ flex: 1 }} />
      <button
        className="tnode-header-btn nodrag"
        title="Expand node"
        onClick={(e) => { e.stopPropagation(); expand(); }}
      >
        <Maximize2 size={12} />
      </button>
      <NodeConnector nodeId={id} side="right" />
    </div>
  );
}
