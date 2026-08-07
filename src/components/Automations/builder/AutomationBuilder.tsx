import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap,
  addEdge, applyEdgeChanges, applyNodeChanges, useReactFlow, ConnectionMode,
  type Node as RFNode, type Edge as RFEdge, type Connection,
  type NodeChange, type EdgeChange, type EdgeTypes,
} from "@xyflow/react";
import { AutomationEdge } from "./AutomationEdge";
import "@xyflow/react/dist/style.css";
import { invoke } from "@tauri-apps/api/core";
import { useTheme } from "../../../themes/ThemeContext";
import {
  parseGraph, type Graph, type Node, type NodeKind, type EdgeKind,
} from "./graph";
import { nodeTypes } from "./nodes";
import { NodePalette } from "./NodePalette";
import { BuildBar, type BuildState } from "./BuildBar";
import { NodeModal } from "./NodeModal";
import { ChatPanel } from "./ChatPanel";

interface Props {
  automationId: string;
  initialGraph: string;
  builtAt: string | null;
  onBuiltAtChange: (v: string | null) => void;
}

const NODE_DEFAULTS: Record<NodeKind, Node["data"]> = {
  "trigger-manual": { label: "" },
  "trigger-schedule": { cron: "0 9 * * 1-5", prompt: "" },
  // P8: trigger channels — all share the TriggerChannelData shape.
  "trigger-linear":   { fields: [], secrets: [], prompt: "" },
  "trigger-discord":  { fields: [], secrets: [], prompt: "" },
  "trigger-telegram": { fields: [], secrets: [], prompt: "" },
  "trigger-teams":    { fields: [], secrets: [], prompt: "" },
  "trigger-photon":   { fields: [], secrets: [], prompt: "" },
  "trigger-poll":     { fields: [], secrets: [], prompt: "" },
  "agent": { model: "anthropic/claude-sonnet-5", instructions: "", sandbox: "auto" },
  "tool": {
    name: "new_tool",
    description: "",
    request: { method: "GET", url: "", queryParams: [], headers: [], auth: { kind: "none" }, body: { kind: "none" } },
    input: { fields: [] },
    response: { kind: "raw" },
  },
  "skill": { name: "new_skill", markdown: "" },
  "connection": { name: "new_connection", kind: "mcp", url: "" },
  "subagent": { name: "researcher", model: "anthropic/claude-sonnet-5", description: "", instructions: "" },
  // P6/P7: a flow is a callable capability with a linear step-tree.
  "flow": { name: "new_flow", description: "", input: { fields: [] }, steps: [] },
};

const edgeTypes: EdgeTypes = { auto: AutomationEdge };

function toRF(g: Graph): { nodes: RFNode[]; edges: RFEdge[] } {
  return {
    nodes: g.nodes.map(n => ({
      id: n.id,
      type: n.kind,
      position: n.position,
      data: n.data as Record<string, unknown>,
    })),
    edges: g.edges.map(e => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: "auto",
      data: { kind: e.kind },
      style: { stroke: edgeColor(e.kind), strokeWidth: 3 },
    })),
  };
}

function fromRF(nodes: RFNode[], edges: RFEdge[]): Graph {
  return {
    nodes: nodes.map(n => ({
      id: n.id,
      kind: (n.type as NodeKind) ?? "agent",
      position: n.position,
      data: n.data as never,
    } as Node)),
    edges: edges.map(e => ({
      id: e.id,
      source: e.source,
      target: e.target,
      kind: ((e.data as { kind?: EdgeKind } | undefined)?.kind ?? "tool") as EdgeKind,
    })),
  };
}

function edgeColor(_k: EdgeKind): string {
  return "var(--tempest-accent-yellow, #f5c518)";
}

function edgeKindFor(sourceKind: NodeKind, targetKind: NodeKind): EdgeKind | null {
  if (sourceKind.startsWith("trigger-") && targetKind === "agent") return "fires";
  if (sourceKind === "agent") {
    switch (targetKind) {
      case "tool": return "tool";
      case "flow": return "flow";
      case "skill": return "skill";
      case "connection": return "connection";
      case "subagent": return "subagent";
      default: return null;
    }
  }
  return null;
}

function Inner({ automationId, initialGraph, builtAt, onBuiltAtChange }: Props) {
  const { theme } = useTheme();
  const rf = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const initial = useMemo(() => toRF(parseGraph(initialGraph)), [initialGraph]);
  const [nodes, setNodes] = useState<RFNode[]>(initial.nodes);
  const [edges, setEdges] = useState<RFEdge[]>(initial.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [buildState, setBuildState] = useState<BuildState>("idle");
  const [buildOutput, setBuildOutput] = useState<string>("");
  const [port, setPort] = useState<number | undefined>(undefined);
  const [chatOpen, setChatOpen] = useState(false);
  const [savingLabel, setSavingLabel] = useState<"idle" | "saving" | "saved">("idle");
  const saveTimer = useRef<number | null>(null);

  // Detect existing process (page reopen with a still-running agent).
  useEffect(() => {
    invoke<{ port: number; pid: number } | null>("get_automation_process", { id: automationId })
      .then(p => {
        if (p) { setPort(p.port); setBuildState("running"); }
      })
      .catch(() => {});
  }, [automationId]);

  const scheduleSave = useCallback((next: { nodes: RFNode[]; edges: RFEdge[] }) => {
    setSavingLabel("saving");
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const g = fromRF(next.nodes, next.edges);
      invoke("update_automation", { id: automationId, req: { graph: JSON.stringify(g) } })
        .then(() => {
          setSavingLabel("saved");
          window.setTimeout(() => setSavingLabel("idle"), 900);
          // Graph changed → treat as needing rebuild if it was previously built.
          if (buildState === "built") setBuildState("idle");
        })
        .catch(() => setSavingLabel("idle"));
    }, 500);
  }, [automationId, buildState]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes(prev => {
      const next = applyNodeChanges(changes, prev);
      const meaningful = changes.some(c => c.type === "position" ? !c.dragging : true);
      if (meaningful) scheduleSave({ nodes: next, edges });
      return next;
    });
  }, [edges, scheduleSave]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges(prev => {
      const next = applyEdgeChanges(changes, prev);
      scheduleSave({ nodes, edges: next });
      return next;
    });
  }, [nodes, scheduleSave]);

  const onConnect = useCallback((c: Connection) => {
    const src = nodes.find(n => n.id === c.source);
    const tgt = nodes.find(n => n.id === c.target);
    if (!src || !tgt) return;
    const kind = edgeKindFor(src.type as NodeKind, tgt.type as NodeKind);
    if (!kind) return;
    setEdges(prev => {
      const next = addEdge({
        ...c,
        type: "auto",
        data: { kind },
        style: { stroke: edgeColor(kind), strokeWidth: 3 },
      }, prev);
      scheduleSave({ nodes, edges: next });
      return next;
    });
  }, [nodes, scheduleSave]);

  const isValidConnection = useCallback((c: Connection | RFEdge) => {
    const src = nodes.find(n => n.id === c.source);
    const tgt = nodes.find(n => n.id === c.target);
    if (!src || !tgt) return false;
    return edgeKindFor(src.type as NodeKind, tgt.type as NodeKind) !== null;
  }, [nodes]);

  const onNodeClick = useCallback((_: React.MouseEvent, n: RFNode) => setSelectedId(n.id), []);

  const onPaneClick = useCallback(() => setSelectedId(null), []);

  const onDragOverCanvas = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const addNodeAt = useCallback((kind: NodeKind, position: { x: number; y: number }) => {
    const id = `${kind}-${Math.random().toString(36).slice(2, 9)}`;
    const data = structuredClone(NODE_DEFAULTS[kind]);
    setNodes(prev => {
      const next = [...prev, { id, type: kind, position, data: data as Record<string, unknown> }];
      scheduleSave({ nodes: next, edges });
      return next;
    });
  }, [edges, scheduleSave]);

  const onDropCanvas = (e: React.DragEvent) => {
    e.preventDefault();
    const kind = e.dataTransfer.getData("application/tempest-node") as NodeKind;
    if (!kind) return;
    // screenToFlowPosition takes viewport (client) coords; don't subtract offsets.
    const position = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    addNodeAt(kind, position);
  };

  const handleDragStartFromPalette = (kind: NodeKind, e: React.DragEvent) => {
    e.dataTransfer.setData("application/tempest-node", kind);
    e.dataTransfer.effectAllowed = "move";
  };

  // Click a palette item → drop node near the viewport centre with a small
  // scatter so successive clicks don't stack on the same pixel.
  const handleClickFromPalette = useCallback((kind: NodeKind) => {
    if (!wrapperRef.current) return;
    const rect = wrapperRef.current.getBoundingClientRect();
    const jitter = () => (Math.random() - 0.5) * 60;
    const position = rf.screenToFlowPosition({
      x: rect.left + rect.width / 2 + jitter(),
      y: rect.top + rect.height / 2 + jitter(),
    });
    addNodeAt(kind, position);
  }, [rf, addNodeAt]);

  const selectedNode = selectedId
    ? (() => {
        const rfn = nodes.find(n => n.id === selectedId);
        if (!rfn) return null;
        return {
          id: rfn.id,
          kind: rfn.type as NodeKind,
          position: rfn.position,
          data: rfn.data,
        } as Node;
      })()
    : null;

  const updateSelected = (data: Node["data"]) => {
    if (!selectedId) return;
    setNodes(prev => {
      const next = prev.map(n => n.id === selectedId ? { ...n, data: data as Record<string, unknown> } : n);
      scheduleSave({ nodes: next, edges });
      return next;
    });
  };

  const deleteSelected = () => {
    if (!selectedId) return;
    setNodes(prev => {
      const next = prev.filter(n => n.id !== selectedId);
      const nextEdges = edges.filter(e => e.source !== selectedId && e.target !== selectedId);
      setEdges(nextEdges);
      scheduleSave({ nodes: next, edges: nextEdges });
      return next;
    });
    setSelectedId(null);
  };

  const hasAgent = useMemo(() => nodes.some(n => n.type === "agent"), [nodes]);
  const hasManualTrigger = useMemo(
    () => nodes.some(n => n.type === "trigger-manual") &&
          edges.some(e => (e.data as { kind?: EdgeKind } | undefined)?.kind === "fires"),
    [nodes, edges]
  );

  const handleBuild = async () => {
    setBuildState("building");
    setBuildOutput("");
    try {
      const res = await invoke<{ success: boolean; output: string; durationMs: number }>(
        "build_automation", { id: automationId }
      );
      if (res.success) {
        setBuildState("built");
        setBuildOutput(res.output || "Build succeeded.");
        onBuiltAtChange(new Date().toISOString());
      } else {
        setBuildState("error");
        setBuildOutput(res.output || "Build failed.");
      }
    } catch (e) {
      setBuildState("error");
      setBuildOutput(String(e));
    }
  };

  const handleStart = async () => {
    setBuildState("starting");
    try {
      const p = await invoke<{ port: number; pid: number }>("start_automation", { id: automationId });
      setPort(p.port);
      setBuildState("running");
    } catch (e) {
      setBuildState("error");
      setBuildOutput(String(e));
    }
  };

  const handleStop = async () => {
    try { await invoke("stop_automation", { id: automationId }); } catch {}
    setPort(undefined);
    setBuildState(builtAt ? "built" : "idle");
    setChatOpen(false);
  };

  return (
    <div className="am-builder">
      <BuildBar
        state={buildState}
        port={port}
        builtAt={builtAt}
        onBuild={handleBuild}
        onStart={handleStart}
        onStop={handleStop}
        onOpenChat={hasManualTrigger && port ? () => setChatOpen(true) : undefined}
      />
      <div className="am-builder-body">
        <NodePalette
          hasAgent={hasAgent}
          onDragStart={handleDragStartFromPalette}
          onClick={handleClickFromPalette}
        />
        <div className="am-canvas" ref={wrapperRef} onDragOver={onDragOverCanvas} onDrop={onDropCanvas}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            colorMode={theme.type}
            proOptions={{ hideAttribution: true }}
            fitView={nodes.length > 0}
            fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
            connectOnClick
            connectionMode={ConnectionMode.Loose}
            connectionLineStyle={{ stroke: "var(--tempest-accent-yellow, #f5c518)", strokeWidth: 3 }}
          >
            <Background
              id="am-bg"
              bgColor="var(--tempest-bg-editor)"
              color="var(--tempest-border-subtle)"
              gap={28}
              size={2.5}
            />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable />
          </ReactFlow>
          <div className={`am-savechip am-savechip--${savingLabel}`}>
            {savingLabel === "saving" ? "Saving…" : savingLabel === "saved" ? "Saved" : ""}
          </div>
          {buildOutput && (buildState === "error" || buildState === "built") && (
            <div className={`am-buildpanel am-buildpanel--${buildState}`}>
              <div className="am-buildpanel-title">
                {buildState === "error" ? "Build output (error)" : "Build output"}
              </div>
              <pre className="am-buildpanel-pre">{buildOutput}</pre>
            </div>
          )}
        </div>
      </div>
      {selectedNode && (
        <NodeModal
          node={selectedNode}
          onChange={updateSelected}
          onClose={() => setSelectedId(null)}
          onDelete={deleteSelected}
        />
      )}
      {chatOpen && port && (
        <ChatPanel port={port} onClose={() => setChatOpen(false)} />
      )}
    </div>
  );
}

export function AutomationBuilder(props: Props) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
