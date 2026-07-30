import { useEffect, useRef, useState, useCallback } from "react";
import {
  ReactFlow, Background, Controls, MiniMap,
  applyNodeChanges,
  type Node, type NodeChange, type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  getThread, getThreadNodes, loadProjectThreads, loadThreadNodes,
  saveThread, saveThreadNode,
} from "../store/threads";
import type { DbThreadNode } from "../lib/db";

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
    position: { x: n.x, y: n.y },
    data: { label: title },
    ...(n.width && n.height ? { width: n.width, height: n.height } : {}),
  };
}

export function ThreadsView({ threadId, projectId, hidden }: { threadId: string; projectId: string; hidden?: boolean }) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [ready, setReady] = useState(false); // flips once the thread row is in the store
  const viewportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    // Ensure the thread row exists in the store (restored tabs open before the
    // sidebar hydrates the project's threads) so viewport read/write works.
    const rows = getThread(threadId) ? Promise.resolve() : loadProjectThreads(projectId).then(() => {});
    Promise.all([rows, loadThreadNodes(threadId)]).then(([, nodeRows]) => {
      if (!alive) return;
      setNodes(nodeRows.map(toFlowNode));
      setReady(true);
    });
    return () => { alive = false; };
  }, [threadId, projectId]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((prev) => applyNodeChanges(changes, prev));
    // Persist finished drags only (position changes with dragging=false).
    for (const c of changes) {
      if (c.type === "position" && !c.dragging && c.position) {
        const stored = getThreadNodes(threadId).find((n) => n.id === c.id);
        if (stored) saveThreadNode({ ...stored, x: c.position.x, y: c.position.y });
      }
    }
  }, [threadId]);

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

  // Wait for hydration so the saved viewport applies on ReactFlow mount
  // (defaultViewport is mount-only). Keep the tab mounted when hidden.
  if (!ready) return <div style={{ width: "100%", height: "100%", display: hidden ? "none" : "block" }} />;

  return (
    <div style={{ width: "100%", height: "100%", display: hidden ? "none" : "block" }}>
      <ReactFlow
        nodes={nodes}
        onNodesChange={onNodesChange}
        onMove={onMove}
        defaultViewport={defaultViewport}
        fitView={!defaultViewport}
        proOptions={{ hideAttribution: true }}
        colorMode="dark" // ponytail: hardcoded; theme against --tempest-* when node UI lands (phase 3)
      >
        <Background />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}
