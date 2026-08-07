// Graph JSON schema — single source of truth for the builder.
// Serialized into automations.graph (TEXT); consumed by both React Flow and the
// Rust `generate_eve_project` writer. Keep field names snake_case-free so JSON
// maps 1:1 to Rust structs via serde.

export type NodeKind =
  | "trigger-manual"
  | "trigger-schedule"
  // P8: additional trigger channels (P5's webhook/slack/github deferred — TODO).
  | "trigger-linear"
  | "trigger-discord"
  | "trigger-telegram"
  | "trigger-teams"
  | "trigger-photon"
  | "trigger-poll"
  | "agent"
  | "tool"
  | "skill"
  | "connection"
  | "subagent"
  // P6/P7: control-flow container. Its data.steps carries a linear tree of
  // `FlowStep` values (if/switch/set/return/loop/parallel/call). The Rust
  // writer compiles it to one `agent/tools/<flowName>.ts` file. We keep
  // steps *inside* the flow node's data rather than as separate top-level
  // nodes on the canvas — same semantics, a small fraction of the wiring
  // work, and no need for a nested sub-canvas UI.
  | "flow";

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
// ── Tool: HTTP-request-first, code-free ─────────────────────────────────────
// Everything is visual. Values in `url`, `queryParams[].value`, `headers[].value`,
// `body.fields[].value`, and `body.text` may contain chip tokens like
// `{{input.city}}` which the Rust writer resolves at runtime against `input`.
// See automations-enhance.md Phase 1-3.

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface KV { key: string; value: string; enabled: boolean }

export type HttpAuth =
  | { kind: "none" }
  | { kind: "bearer"; token: string }
  | { kind: "basic"; user: string; pass: string }
  | { kind: "apiKey"; in: "header" | "query"; name: string; value: string };

export type HttpBody =
  | { kind: "none" }
  | { kind: "json"; fields: KV[] }
  | { kind: "form"; fields: KV[] }
  | { kind: "raw"; contentType: string; text: string };

export interface HttpRequest {
  method: HttpMethod;
  url: string;
  queryParams: KV[];
  headers: KV[];
  auth: HttpAuth;
  body: HttpBody;
}

export type ToolInputType = "string" | "number" | "boolean" | "enum";
export interface ToolInputField {
  name: string;
  type: ToolInputType;
  required: boolean;
  enumValues?: string[];
  description?: string;
}
export interface ToolInputSchema {
  fields: ToolInputField[];
}

export interface ResponseMap {
  kind: "raw" | "pick";
  pick?: string;   // JSONPath-ish: "data.items[0].name" — set by the visual picker
}

export interface ToolData {
  name: string;              // filename slug the agent calls
  description: string;       // shown to the agent
  request: HttpRequest;
  input: ToolInputSchema;
  response: ResponseMap;
}

export function emptyRequest(): HttpRequest {
  return {
    method: "GET",
    url: "",
    queryParams: [],
    headers: [],
    auth: { kind: "none" },
    body: { kind: "none" },
  };
}
export function emptyToolData(): ToolData {
  return {
    name: "",
    description: "",
    request: emptyRequest(),
    input: { fields: [] },
    response: { kind: "raw" },
  };
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

// ── P6/P7: control-flow tree ─────────────────────────────────────────────────
// A `flow` node is a callable capability (like a tool). Its data.steps is a
// linear tree; the compiler walks it and emits one `agent/tools/<name>.ts`.
//
// Chip resolution: every {{input.<name>}} inside a flow resolves against a
// merged runtime scope: flow inputs, `set`-vars, `call.assignTo` results,
// and loop iteration variables. The chip helper is the same one tools use.

export type ConditionOp =
  | "equals" | "not-equals"
  | "contains" | "not-contains"
  | "gt" | "gte" | "lt" | "lte"
  | "is-empty" | "is-not-empty"
  | "matches";               // regex

export interface Condition {
  left: string;              // chip expression, e.g. "{{input.city}}"
  op: ConditionOp;
  right: string;             // chip expression or literal (unused for is-empty)
}

export interface SetVar { name: string; value: string }

export interface SwitchCase {
  label: string;
  condition: Condition;
  steps: FlowStep[];
}

export type FlowStep =
  | { id: string; kind: "call"; assignTo: string; request: HttpRequest }
  | { id: string; kind: "if"; condition: Condition; then: FlowStep[]; else: FlowStep[] }
  | { id: string; kind: "switch"; cases: SwitchCase[]; default: FlowStep[] }
  | { id: string; kind: "set"; vars: SetVar[] }
  | { id: string; kind: "return"; value: string }
  | {
      id: string;
      kind: "loop";
      shape: "for-each" | "while";
      listChip: string;      // for-each: chip resolving to an array (or JSON string)
      itemVar: string;       // name introduced into scope inside the body
      condition: Condition;  // while shape
      body: FlowStep[];
    }
  | {
      id: string;
      kind: "parallel";
      mode: "all" | "race";
      branches: FlowStep[][];
    };

export interface FlowData {
  name: string;              // filename slug — the agent calls this as a tool
  description: string;       // shown to the agent (like ToolData.description)
  input: ToolInputSchema;    // reuse tool input shape
  steps: FlowStep[];
}

export function emptyCondition(): Condition {
  return { left: "", op: "equals", right: "" };
}
export function emptyFlowData(): FlowData {
  return {
    name: "",
    description: "",
    input: { fields: [] },
    steps: [],
  };
}

// ── P8: trigger channel node data ────────────────────────────────────────────
// Every trigger-channel kind shares the same shape: a set of KV fields plus a
// per-automation secret bag (`.env` refs). We keep it uniform so one modal
// serves all six kinds and the Rust writer branches once on `kind`.
//
// Field values may be chip refs like `{{secrets.<slug>}}` — those are stored
// verbatim; the Rust writer emits a `.env` alongside the project and rewrites
// the reference to `process.env.<slug>` at generate time.

export interface ChannelSecret { slug: string; value: string }

export interface TriggerChannelData {
  // Fields keyed by channel kind — see writer for the schema per kind.
  fields: KV[];
  // Per-node secret bag. Persisted; user pastes once, chip form is
  // `{{secrets.<slug>}}` and the `slug` here matches the chip.
  secrets: ChannelSecret[];
  // Free-text prompt fired when the trigger delivers input to the agent.
  prompt: string;
}

export function emptyTriggerChannelData(): TriggerChannelData {
  return { fields: [], secrets: [], prompt: "" };
}

export type Node =
  | BaseNode<"trigger-manual", TriggerManualData>
  | BaseNode<"trigger-schedule", TriggerScheduleData>
  | BaseNode<"trigger-linear", TriggerChannelData>
  | BaseNode<"trigger-discord", TriggerChannelData>
  | BaseNode<"trigger-telegram", TriggerChannelData>
  | BaseNode<"trigger-teams", TriggerChannelData>
  | BaseNode<"trigger-photon", TriggerChannelData>
  | BaseNode<"trigger-poll", TriggerChannelData>
  | BaseNode<"agent", AgentData>
  | BaseNode<"tool", ToolData>
  | BaseNode<"skill", SkillData>
  | BaseNode<"connection", ConnectionData>
  | BaseNode<"subagent", SubagentData>
  | BaseNode<"flow", FlowData>;

// Typed edges. `fires` connects a Trigger to the Agent (top port).
// `model|tool|skill|connection|subagent|flow` connect the Agent's bottom
// typed handles to sub-node top handles.
export type EdgeKind = "fires" | "model" | "tool" | "skill" | "connection" | "subagent" | "flow";

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
