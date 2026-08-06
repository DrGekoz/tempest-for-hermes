// Graph JSON schema — single source of truth for the builder.
// Serialized into automations.graph (TEXT); consumed by both React Flow and the
// Rust `generate_eve_project` writer. Keep field names snake_case-free so JSON
// maps 1:1 to Rust structs via serde.

export type NodeKind =
  | "trigger-manual"
  | "trigger-schedule"
  | "agent"
  | "tool"
  | "skill"
  | "connection"
  | "subagent";

export interface XY { x: number; y: number }

interface BaseNode<K extends NodeKind, D> {
  id: string;
  kind: K;
  position: XY;
  data: D;
}

export interface TriggerManualData {
  label?: string;
}
export interface TriggerScheduleData {
  cron: string;              // "0 9 * * 1-5"
  prompt: string;            // markdown fire-and-forget prompt
}
export interface AgentData {
  model: string;             // e.g. "anthropic/claude-sonnet-5"
  instructions: string;      // system prompt (markdown)
  sandbox: "auto" | "docker" | "none";
  reasoning?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  maxInputTokens?: number;
  maxOutputTokens?: number;
}
export type ToolPreset = "http" | "custom";
export interface ToolData {
  name: string;              // filename slug
  description: string;
  preset: ToolPreset;
  // preset === "http"
  httpMethod?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  httpUrl?: string;
  // preset === "custom" — raw TS body of `execute`
  customInputSchema?: string;  // e.g. `z.object({ query: z.string() })`
  customExecute?: string;      // body of async execute(input, ctx) { ... }
}
export interface SkillData {
  name: string;              // filename slug
  markdown: string;
}
export type ConnectionKind = "mcp" | "openapi";
export interface ConnectionData {
  name: string;              // filename slug
  kind: ConnectionKind;
  url: string;               // MCP server URL or OpenAPI spec URL
}
export interface SubagentData {
  name: string;              // directory slug under subagents/
  model: string;
  description: string;       // required by Eve for delegation
  instructions: string;
}

export type Node =
  | BaseNode<"trigger-manual", TriggerManualData>
  | BaseNode<"trigger-schedule", TriggerScheduleData>
  | BaseNode<"agent", AgentData>
  | BaseNode<"tool", ToolData>
  | BaseNode<"skill", SkillData>
  | BaseNode<"connection", ConnectionData>
  | BaseNode<"subagent", SubagentData>;

// Typed edges. `fires` connects a Trigger to the Agent (top port).
// `model|tool|skill|connection|subagent` connect the Agent's bottom typed
// handles to sub-node top handles.
export type EdgeKind = "fires" | "model" | "tool" | "skill" | "connection" | "subagent";

export interface Edge {
  id: string;
  source: string;   // node id
  target: string;   // node id
  kind: EdgeKind;
}

export interface Graph {
  nodes: Node[];
  edges: Edge[];
}

export const emptyGraph: Graph = { nodes: [], edges: [] };

export function parseGraph(s: string | null | undefined): Graph {
  if (!s) return emptyGraph;
  try {
    const g = JSON.parse(s) as Graph;
    return { nodes: g.nodes ?? [], edges: g.edges ?? [] };
  } catch {
    return emptyGraph;
  }
}

export function findAgent(g: Graph): Extract<Node, { kind: "agent" }> | undefined {
  return g.nodes.find((n): n is Extract<Node, { kind: "agent" }> => n.kind === "agent");
}

// ponytail: slugify is one line, kept here so backend + frontend agree.
export function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
}
