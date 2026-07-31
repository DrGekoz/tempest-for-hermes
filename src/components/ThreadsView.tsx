import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { MessagesSquare, StickyNote, Bot, SquareTerminal } from "lucide-react";
import {
  ReactFlow, Background, Controls, MiniMap,
  applyNodeChanges, applyEdgeChanges, addEdge, ConnectionMode,
  useStore, useStoreApi,
  type Node, type NodeChange, type Edge, type EdgeChange, type Connection, type Viewport,
  type NodeTypes, type EdgeTypes, type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  getThread, getThreadNodes, loadProjectThreads, loadThreadNodes, loadThreadEdges,
  saveThread, saveThreadNode, deleteThreadNode, saveThreadEdge, deleteThreadEdge,
} from "../store/threads";
import type { DbThreadEdge } from "../lib/db";
import { useTheme } from "../themes/ThemeContext";
import { TextNode } from "./threads/nodes/TextNode";
import { invoke } from "@tauri-apps/api/core";
import { ChatNode, buildAgentSeedContext } from "./threads/nodes/ChatNode";
import { AgentNode, TerminalNode } from "./threads/nodes/SessionNode";
import { ThreadEdge } from "./threads/ThreadEdge";
import { ThreadNodeContext } from "./threads/ThreadNodeContext";
import { getSession } from "../store/sessions";
import type { DbThreadNode } from "../lib/db";

// Custom node kinds → their component. Module-level so the object identity is
// stable across renders (React Flow warns otherwise). Unlisted kinds fall back to
// React Flow's default box.
const nodeTypes: NodeTypes = { text: TextNode, chat: ChatNode, agent: AgentNode, terminal: TerminalNode };
const CUSTOM_KINDS = new Set(Object.keys(nodeTypes));
// Kinds whose height is driven by content — the node grows downward as messages
// stack instead of scrolling. We apply width only and let React Flow measure height.
const AUTO_HEIGHT_KINDS = new Set(["chat"]);
const edgeTypes: EdgeTypes = { thread: ThreadEdge };

// Default canvas footprint per kind at creation (persisted; user-resizable later).
const KIND_SIZE: Record<string, { w: number; h: number }> = {
  text: { w: 500, h: 500 },
  chat: { w: 700, h: 500 },
  agent: { w: 480, h: 340 },
  terminal: { w: 480, h: 300 },
};

// Phase 2: renders exactly one canvas (named by `threadId`) as a bare React Flow
// surface — pan/zoom, minimap, node dragging. Node *types* (chat/text/agent/
// terminal) and node creation land in phase 3+; here every persisted node shows
// as a default box so positions still round-trip. Viewport + node positions
// persist back to SQLite via the threads store.

// A persisted thread_node → a React Flow node. Label comes from data.title,
// falling back to the kind. Node bodies are phase 3.
function toFlowNode(n: DbThreadNode): Node {
  let title = n.kind;
  try {
    const d = n.data ? JSON.parse(n.data) : null;
    if (d && typeof d.title === "string" && d.title) title = d.title;
  } catch { /* keep kind */ }
  return {
    id: n.id,
    ...(CUSTOM_KINDS.has(n.kind) ? { type: n.kind } : {}),
    position: { x: n.x, y: n.y },
    data: { label: title },
    // Auto-height kinds get width only so height measures to content.
    ...(AUTO_HEIGHT_KINDS.has(n.kind)
      ? (n.width ? { width: n.width } : {})
      : (n.width && n.height ? { width: n.width, height: n.height } : {})),
  };
}

// A persisted thread_edge → a React Flow edge (and back). The DB id is the RF id
// so removes/updates round-trip by the same key.
function toFlowEdge(e: DbThreadEdge): Edge {
  return {
    id: e.id, source: e.source, target: e.target,
    sourceHandle: e.sourceHandle ?? undefined, targetHandle: e.targetHandle ?? undefined,
  };
}

// Cursor-following line for click-to-connect. React Flow arms the connection on a
// single click (store.connectionClickStartHandle) but — unlike a drag — draws no
// rubber-band line, so the click felt inert. We mirror the armed handle: draw a
// bezier from it to the cursor until a second handle click completes it (React Flow
// clears the handle → line vanishes) or a pane click / Escape cancels. Screen
// coords via getBoundingClientRect; a fixed overlay needs no viewport transform.
// Must render inside <ReactFlow> to see the store. ponytail: line origin is frozen
// at arm time — panning mid-connect would drift it; not worth tracking.
function ClickConnectLine() {
  const store = useStoreApi();
  const start = useStore((s) => s.connectionClickStartHandle);
  const [line, setLine] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

  useEffect(() => {
    if (!start) { setLine(null); return; }
    const el = document.querySelector(
      `.react-flow__handle[data-nodeid="${start.nodeId}"][data-handleid="${start.id ?? ""}"]`,
    ) as HTMLElement | null;
    if (!el) { setLine(null); return; }
    const r = el.getBoundingClientRect();
    const x1 = r.left + r.width / 2, y1 = r.top + r.height / 2;
    setLine({ x1, y1, x2: x1, y2: y1 });

    const move = (e: MouseEvent) => setLine((l) => (l ? { ...l, x2: e.clientX, y2: e.clientY } : l));
    // A click anywhere that isn't a handle cancels (a handle click either
    // completes the connection or re-arms — React Flow owns that).
    const cancel = (e: MouseEvent) => {
      if (!(e.target as Element)?.closest?.(".react-flow__handle")) {
        store.setState({ connectionClickStartHandle: null });
      }
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") store.setState({ connectionClickStartHandle: null }); };
    window.addEventListener("mousemove", move);
    window.addEventListener("click", cancel);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("click", cancel);
      window.removeEventListener("keydown", key);
    };
  }, [start, store]);

  if (!line) return null;
  const dx = Math.max(40, Math.abs(line.x2 - line.x1) * 0.5);
  const d = `M ${line.x1},${line.y1} C ${line.x1 + dx},${line.y1} ${line.x2 - dx},${line.y2} ${line.x2},${line.y2}`;
  return createPortal(
    <svg style={{ position: "fixed", inset: 0, width: "100vw", height: "100vh", pointerEvents: "none", zIndex: 8 }}>
      <path d={d} fill="none" stroke="var(--tempest-accent-yellow, #f5c518)" strokeWidth={3} strokeLinecap="round" />
    </svg>,
    document.body,
  );
}

export function ThreadsView({
  threadId, projectId, hidden, projectPath, atlasIndexed, spawnCanvasSession, resumeCanvasSession, closeCanvasSession,
  worktrees, createCanvasWorktree, autoNameThread,
}: {
  threadId: string;
  projectId: string;
  hidden?: boolean;
  projectPath?: string;
  atlasIndexed?: boolean;
  spawnCanvasSession?: (projectId: string, opts: { agent?: string; name?: string; prompt?: string; model?: string; worktreePath?: string }) => Promise<string | null>;
  resumeCanvasSession?: (sessionId: string) => Promise<void>;
  closeCanvasSession?: (sessionId: string) => void;
  worktrees?: { name: string; path: string }[];
  createCanvasWorktree?: (projectId: string, name: string) => Promise<string | null>;
  autoNameThread?: (threadId: string, firstMessage: string) => void;
}) {
  const { theme } = useTheme();
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [ready, setReady] = useState(false); // flips once the thread row is in the store
  const viewportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rfRef = useRef<ReactFlowInstance<Node> | null>(null);
  // Right-click "add node" menu: screen coords for placement, flow coords for the node.
  const [menu, setMenu] = useState<{ x: number; y: number; flow: { x: number; y: number } } | null>(null);

  useEffect(() => {
    let alive = true;
    // Ensure the thread row exists in the store (restored tabs open before the
    // sidebar hydrates the project's threads) so viewport read/write works.
    const rows = getThread(threadId) ? Promise.resolve() : loadProjectThreads(projectId).then(() => {});
    Promise.all([rows, loadThreadNodes(threadId), loadThreadEdges(threadId)]).then(([, nodeRows, edgeRows]) => {
      if (!alive) return;
      setNodes(nodeRows.map(toFlowNode));
      setEdges(edgeRows.map(toFlowEdge));
      setReady(true);
    });
    return () => { alive = false; };
  }, [threadId, projectId]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((prev) => {
      const next = applyNodeChanges(changes, prev);
      // Persist finished drags (position, dragging=false) and finished resizes
      // (dimensions, resizing=false) — read the merged node so size + position
      // round-trip together (top/left resize moves the node too).
      for (const c of changes) {
        if (c.type === "remove") {
          // A deleted agent/terminal node owns its canvas session — tear it down
          // (kill PTY + drop the row) so it doesn't leak or resume as a zombie.
          const sid = getThreadNodes(threadId).find((n) => n.id === c.id)?.sessionId;
          if (sid) closeCanvasSession?.(sid);
          deleteThreadNode(c.id);
          continue;
        }
        const done =
          (c.type === "position" && c.dragging === false) ||
          (c.type === "dimensions" && c.resizing === false);
        if (!done) continue;
        const nn = next.find((n) => n.id === c.id);
        const stored = getThreadNodes(threadId).find((n) => n.id === c.id);
        if (!nn || !stored) continue;
        const w = Math.round(nn.width ?? nn.measured?.width ?? stored.width ?? 0);
        const h = Math.round(nn.height ?? nn.measured?.height ?? stored.height ?? 0);
        saveThreadNode({
          ...stored,
          x: nn.position.x, y: nn.position.y,
          width: w || stored.width, height: h || stored.height,
        });
      }
      return next;
    });
  }, [threadId, closeCanvasSession]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    for (const c of changes) if (c.type === "remove") deleteThreadEdge(c.id);
    setEdges((prev) => applyEdgeChanges(changes, prev));
  }, []);

  const onConnect = useCallback((c: Connection) => {
    const id = crypto.randomUUID();
    saveThreadEdge({
      id, threadId, source: c.source, target: c.target,
      sourceHandle: c.sourceHandle ?? null, targetHandle: c.targetHandle ?? null,
    });
    setEdges((prev) => addEdge({ ...c, id }, prev));
  }, [threadId]);

  const onPaneContextMenu = useCallback((e: React.MouseEvent | MouseEvent) => {
    e.preventDefault();
    const rf = rfRef.current;
    if (!rf) return;
    const { clientX, clientY } = e as React.MouseEvent;
    setMenu({ x: clientX, y: clientY, flow: rf.screenToFlowPosition({ x: clientX, y: clientY }) });
  }, []);

  const createNode = useCallback((kind: string) => {
    setMenu((m) => {
      if (!m) return null;
      const size = KIND_SIZE[kind] ?? { w: 240, h: 140 };
      const node: DbThreadNode = {
        id: crypto.randomUUID(), threadId, kind,
        x: m.flow.x, y: m.flow.y, width: size.w, height: size.h,
        branchId: null, sessionId: null, data: null,
      };
      saveThreadNode(node);
      setNodes((prev) => [...prev, toFlowNode(node)]);
      return null;
    });
  }, [threadId]);

  // A chat node's launch proposal → spawn an `agent` node on this canvas (plan
  // §6.4). The session is spawned first (canvas-placed, no tab), then the node is
  // created already bound to it — so SessionNode mounts with a live session and
  // renders its terminal immediately (no post-mount rebind race). Placed just right
  // of the firing chat node when known, else at the viewport centre.
  const launchAgentNode = useCallback(
    async (agentHint: string, prompt: string, model?: string, sourceNodeId?: string, worktreePath?: string) => {
      if (!spawnCanvasSession) return;
      // Drop a canvas MCP config into the agent's cwd so it discovers canvas_map /
      // read_canvas_node on its own (the Tempest Bridge — works for any launch path).
      const cwd = worktreePath ?? projectPath;
      if (cwd) { try { await invoke("write_canvas_mcp_config", { projectPath: cwd, projectId }); } catch { /* best-effort */ } }
      // Seed the CLI agent with canvas context (lineage from the firing chat + ambient map).
      const seed = buildAgentSeedContext(threadId, sourceNodeId);
      const seededPrompt = seed ? `${seed}\n\n---\n\n${prompt}` : prompt;
      const sid = await spawnCanvasSession(projectId, { agent: agentHint, prompt: seededPrompt, model, worktreePath });
      if (!sid) return;

      const src = sourceNodeId ? getThreadNodes(threadId).find((n) => n.id === sourceNodeId) : undefined;
      const size = KIND_SIZE.agent;
      let pos: { x: number; y: number };
      if (src) {
        pos = { x: src.x + (src.width ?? 700) + 40, y: src.y };
      } else {
        const c = rfRef.current?.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
        pos = c ?? { x: 0, y: 0 };
      }

      const node: DbThreadNode = {
        id: crypto.randomUUID(), threadId, kind: "agent",
        x: pos.x, y: pos.y, width: size.w, height: size.h,
        branchId: getSession(sid)?.branchId ?? null, sessionId: sid,
        data: JSON.stringify({ title: getSession(sid)?.name ?? agentHint }),
      };
      saveThreadNode(node);
      setNodes((prev) => [...prev, toFlowNode(node)]);
    },
    [projectId, threadId, spawnCanvasSession],
  );

  // Debounce viewport writes — pan/zoom fire continuously.
  const onMove = useCallback((_: unknown, vp: Viewport) => {
    if (viewportTimer.current) clearTimeout(viewportTimer.current);
    viewportTimer.current = setTimeout(() => {
      const t = getThread(threadId);
      if (t) saveThread({ ...t, viewport: JSON.stringify(vp) });
    }, 400);
  }, [threadId]);

  const thread = getThread(threadId);
  let defaultViewport: Viewport | undefined;
  try { if (thread?.viewport) defaultViewport = JSON.parse(thread.viewport); } catch { /* none */ }

  const nodeCtx = useMemo(
    () => ({
      projectId, projectPath, atlasIndexed,
      onLaunchAgent: launchAgentNode,
      spawnCanvasSession: spawnCanvasSession ? (opts: { agent?: string; name?: string; prompt?: string; model?: string; worktreePath?: string }) => spawnCanvasSession(projectId, opts) : undefined,
      resumeCanvasSession,
      closeCanvasSession,
      worktrees,
      createCanvasWorktree: createCanvasWorktree ? (name: string) => createCanvasWorktree(projectId, name) : undefined,
      autoNameThread: autoNameThread ? (firstMessage: string) => autoNameThread(threadId, firstMessage) : undefined,
    }),
    [projectId, threadId, projectPath, atlasIndexed, launchAgentNode, spawnCanvasSession, resumeCanvasSession, closeCanvasSession, worktrees, createCanvasWorktree, autoNameThread],
  );

  // Wait for hydration so the saved viewport applies on ReactFlow mount
  // (defaultViewport is mount-only). Keep the tab mounted when hidden.
  if (!ready) return <div style={{ width: "100%", height: "100%", display: hidden ? "none" : "block" }} />;

  return (
    <ThreadNodeContext.Provider value={nodeCtx}>
    <div style={{ width: "100%", height: "100%", display: hidden ? "none" : "block" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onInit={(inst) => { rfRef.current = inst; }}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        connectOnClick
        connectionMode={ConnectionMode.Loose}
        connectionLineStyle={{ stroke: "var(--tempest-accent-yellow, #f5c518)", strokeWidth: 3 }}
        defaultEdgeOptions={{ type: "thread", style: { stroke: "var(--tempest-accent-yellow, #f5c518)", strokeWidth: 3 } }}
        onMove={onMove}
        onPaneClick={() => setMenu(null)}
        onPaneContextMenu={onPaneContextMenu}
        defaultViewport={defaultViewport}
        fitView={!defaultViewport}
        proOptions={{ hideAttribution: true }}
        colorMode={theme.type}
      >
        <Background bgColor="var(--tempest-bg-base)" color="var(--tempest-border-subtle)" />
        <Controls />
        <MiniMap pannable zoomable />
        <ClickConnectLine />
      </ReactFlow>

      {menu && (
        <div
          className="thread-node-menu"
          style={{
            position: "fixed", top: menu.y, left: menu.x, zIndex: 10,
            minWidth: 140, padding: 4, borderRadius: 8,
            background: "var(--tempest-bg-elevated, #161616)",
            border: "1px solid var(--tempest-border-subtle, #2a2a2a)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            font: '13px "Geist", system-ui, sans-serif',
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {[
            { kind: "chat", label: "Add Chat node", Icon: MessagesSquare },
            { kind: "text", label: "Add Text note", Icon: StickyNote },
            { kind: "agent", label: "Add Agent node", Icon: Bot },
            { kind: "terminal", label: "Add Terminal node", Icon: SquareTerminal },
          ].map((item) => (
            <button
              key={item.kind}
              onClick={() => createNode(item.kind)}
              style={{
                display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
                padding: "6px 10px", borderRadius: 5, border: "none",
                background: "transparent", color: "var(--tempest-fg-default, #e6e6e6)",
                cursor: "pointer", font: "inherit",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--tempest-bg-hover, #232323)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <item.Icon size={15} style={{ flexShrink: 0, opacity: 0.8 }} />
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
    </ThreadNodeContext.Provider>
  );
}
