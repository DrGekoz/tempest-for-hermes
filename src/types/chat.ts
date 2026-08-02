export type TextPart = { type: "text"; content: string };

export type ToolCallPart = {
  type: "tool-call";
  id: string;
  toolName: string;
  args: unknown;
  result?: unknown;
  status: "running" | "complete";
};

export type ProposalPart = {
  type: "proposal";
  id: string;
  agent: string;
  model?: string;
  task: string;
  reason: string;
  launched: boolean;
  dismissed: boolean;
};

// Claude Code (CLI backend) permission prompt. Emitted when the agent wants to
// use a tool; the user approves/denies inline and the decision travels back to
// the sidecar over stdin. `decision` set once resolved (freezes the card).
export type PermissionPart = {
  type: "permission";
  id: string;
  toolName: string;
  title?: string;
  description?: string;
  input: unknown;
  decision?: "allow" | "deny";
};

export type MessagePart = TextPart | ToolCallPart | ProposalPart | PermissionPart;

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
}

export interface PersistedMessage {
  id: string;
  role: "user" | "assistant";
  content?: string;
  parts?: MessagePart[];
}
