import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import {
  Bot, Wrench, BookOpen, Plug, Users, Play, Clock, AlertCircle,
  GitBranch, MessageSquare, Send, Layers, Activity, Ticket,
} from "lucide-react";
import type {
  AgentData, ToolData, SkillData, ConnectionData, SubagentData,
  TriggerManualData, TriggerScheduleData, FlowData, TriggerChannelData,
} from "./graph";
import { describeCron } from "./humanCron";
import { NodeConnector } from "./NodeConnector";

// Left-to-right flow, Threads-style connectors:
//   Trigger — [right]
//   Agent   [left] — [right]  (right feeds capabilities)
//   Capability nodes [left] —
// Handles live in the header row via <NodeConnector />.

type Tone = "trigger" | "agent" | "tool" | "skill" | "connection" | "subagent" | "flow";

function NodeCard(props: {
  nodeId: string;
  icon: React.ReactNode;
  kindLabel: string;
  primary: string;
  secondary?: string;
  needsSetup?: boolean;
  tone: Tone;
  selected?: boolean;
  hasLeft?: boolean;
  hasRight?: boolean;
}) {
  return (
    <div className={`amn amn--${props.tone}${props.selected ? " amn--selected" : ""}`}>
      <div className="amn-head">
        {props.hasLeft && <NodeConnector nodeId={props.nodeId} side="left" />}
        <span className="amn-icon">{props.icon}</span>
        <span className="amn-kind">{props.kindLabel}</span>
        {props.needsSetup && (
          <span className="amn-badge" title="This node needs to be set up before it will run">
            <AlertCircle size={11} /> Set up
          </span>
        )}
        {props.hasRight && <NodeConnector nodeId={props.nodeId} side="right" />}
      </div>
      <div className="amn-primary" title={props.primary}>{props.primary}</div>
      {props.secondary && (
        <div className="amn-secondary" title={props.secondary}>{props.secondary}</div>
      )}
    </div>
  );
}

function firstLine(s: string | undefined, max = 60): string | undefined {
  if (!s) return undefined;
  const line = s.replace(/^#+\s*/, "").split(/\r?\n/).find(l => l.trim().length > 0);
  if (!line) return undefined;
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try { return new URL(url).host; } catch { return url.length > 40 ? url.slice(0, 39) + "…" : url; }
}

function modelName(id: string | undefined): string {
  if (!id) return "Default model";
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(slash + 1) : id;
}

const TriggerManualNode = memo(({ id, data, selected }: NodeProps) => {
  const d = data as unknown as TriggerManualData;
  return (
    <NodeCard
      nodeId={id}
      tone="trigger"
      icon={<Play size={14} />}
      kindLabel="When I click Start"
      primary={d.label?.trim() || "Start button"}
      secondary="Click Start in the chat to run this automation"
      selected={selected}
      hasRight
    />
  );
});

const TriggerScheduleNode = memo(({ id, data, selected }: NodeProps) => {
  const d = data as unknown as TriggerScheduleData;
  const needsSetup = !d.cron?.trim();
  return (
    <NodeCard
      nodeId={id}
      tone="trigger"
      icon={<Clock size={14} />}
      kindLabel="On a schedule"
      primary={describeCron(d.cron || "")}
      secondary={firstLine(d.prompt) || "No prompt set yet"}
      needsSetup={needsSetup}
      selected={selected}
      hasRight
    />
  );
});

const AgentNode = memo(({ id, data, selected }: NodeProps) => {
  const d = data as unknown as AgentData;
  const needsSetup = !d.instructions?.trim();
  return (
    <NodeCard
      nodeId={id}
      tone="agent"
      icon={<Bot size={14} />}
      kindLabel="AI Agent"
      primary={firstLine(d.instructions) || "No instructions yet"}
      secondary={`Using ${modelName(d.model)}`}
      needsSetup={needsSetup}
      selected={selected}
      hasLeft
      hasRight
    />
  );
});

const ToolNode = memo(({ id, data, selected }: NodeProps) => {
  const d = data as unknown as ToolData;
  const primary = d.description?.trim() || d.name?.trim() || "New tool";
  const method = d.request?.method || "GET";
  const url = d.request?.url || "";
  const secondary = `${method} ${hostOf(url) || "(no URL yet)"}`;
  const needsSetup = !url.trim();
  return (
    <NodeCard
      nodeId={id}
      tone="tool"
      icon={<Wrench size={14} />}
      kindLabel="Tool the agent can call"
      primary={primary}
      secondary={secondary}
      needsSetup={needsSetup}
      selected={selected}
      hasLeft
    />
  );
});

const SkillNode = memo(({ id, data, selected }: NodeProps) => {
  const d = data as unknown as SkillData;
  const needsSetup = !d.markdown?.trim();
  return (
    <NodeCard
      nodeId={id}
      tone="skill"
      icon={<BookOpen size={14} />}
      kindLabel="Skill (instructions on demand)"
      primary={d.name?.trim() || "New skill"}
      secondary={firstLine(d.markdown) || "Empty — write what the agent should do"}
      needsSetup={needsSetup}
      selected={selected}
      hasLeft
    />
  );
});

const ConnectionNode = memo(({ id, data, selected }: NodeProps) => {
  const d = data as unknown as ConnectionData;
  const needsSetup = !d.url?.trim();
  return (
    <NodeCard
      nodeId={id}
      tone="connection"
      icon={<Plug size={14} />}
      kindLabel={d.kind === "openapi" ? "OpenAPI connection" : "MCP connection"}
      primary={d.name?.trim() || "New connection"}
      secondary={hostOf(d.url) || "No URL set"}
      needsSetup={needsSetup}
      selected={selected}
      hasLeft
    />
  );
});

const SubagentNode = memo(({ id, data, selected }: NodeProps) => {
  const d = data as unknown as SubagentData;
  const needsSetup = !d.description?.trim() || !d.instructions?.trim();
  return (
    <NodeCard
      nodeId={id}
      tone="subagent"
      icon={<Users size={14} />}
      kindLabel="Helper agent"
      primary={d.name?.trim() || "New helper"}
      secondary={firstLine(d.description) || "Describe when to use this helper"}
      needsSetup={needsSetup}
      selected={selected}
      hasLeft
    />
  );
});

// ── P6/P7: flow node card ───────────────────────────────────────────────────
const FlowNode = memo(({ id, data, selected }: NodeProps) => {
  const d = data as unknown as FlowData;
  const steps = d.steps?.length ?? 0;
  const needsSetup = steps === 0 || !d.name?.trim();
  return (
    <NodeCard
      nodeId={id}
      tone="flow"
      icon={<GitBranch size={14} />}
      kindLabel="Flow (multi-step tool)"
      primary={d.name?.trim() || "New flow"}
      secondary={steps ? `${steps} step${steps === 1 ? "" : "s"}` : "No steps yet"}
      needsSetup={needsSetup}
      selected={selected}
      hasLeft
    />
  );
});

// ── P8: shared trigger-channel card ─────────────────────────────────────────
function makeChannelTriggerNode(label: string, icon: React.ReactNode) {
  return memo(({ id, data, selected }: NodeProps) => {
    const d = data as unknown as TriggerChannelData;
    const needsSetup = (d.fields?.length ?? 0) === 0;
    return (
      <NodeCard
        nodeId={id}
        tone="trigger"
        icon={icon}
        kindLabel={label}
        primary={firstLine(d.prompt) || `Runs when ${label.toLowerCase()} fires`}
        secondary={needsSetup ? "Not configured yet" : "Configured"}
        needsSetup={needsSetup}
        selected={selected}
        hasRight
      />
    );
  });
}

const TriggerLinearNode   = makeChannelTriggerNode("On Linear event",   <Ticket size={14} />);
const TriggerDiscordNode  = makeChannelTriggerNode("On Discord event",  <MessageSquare size={14} />);
const TriggerTelegramNode = makeChannelTriggerNode("On Telegram message", <Send size={14} />);
const TriggerTeamsNode    = makeChannelTriggerNode("On Teams message",   <Layers size={14} />);
const TriggerPhotonNode   = makeChannelTriggerNode("On iMessage (Photon)", <MessageSquare size={14} />);
const TriggerPollNode     = makeChannelTriggerNode("Poll an endpoint",   <Activity size={14} />);

export const nodeTypes = {
  "trigger-manual": TriggerManualNode,
  "trigger-schedule": TriggerScheduleNode,
  "trigger-linear": TriggerLinearNode,
  "trigger-discord": TriggerDiscordNode,
  "trigger-telegram": TriggerTelegramNode,
  "trigger-teams": TriggerTeamsNode,
  "trigger-photon": TriggerPhotonNode,
  "trigger-poll": TriggerPollNode,
  "agent": AgentNode,
  "tool": ToolNode,
  "skill": SkillNode,
  "connection": ConnectionNode,
  "subagent": SubagentNode,
  "flow": FlowNode,
};

export const nodeIcon: Record<string, React.ReactNode> = {
  "trigger-manual": <Play size={13} />,
  "trigger-schedule": <Clock size={13} />,
  "trigger-linear": <Ticket size={13} />,
  "trigger-discord": <MessageSquare size={13} />,
  "trigger-telegram": <Send size={13} />,
  "trigger-teams": <Layers size={13} />,
  "trigger-photon": <MessageSquare size={13} />,
  "trigger-poll": <Activity size={13} />,
  "agent": <Bot size={13} />,
  "tool": <Wrench size={13} />,
  "skill": <BookOpen size={13} />,
  "connection": <Plug size={13} />,
  "subagent": <Users size={13} />,
  "flow": <GitBranch size={13} />,
};

export const nodeLabel: Record<string, string> = {
  "trigger-manual": "Manual trigger",
  "trigger-schedule": "Schedule trigger",
  "trigger-linear": "Linear trigger",
  "trigger-discord": "Discord trigger",
  "trigger-telegram": "Telegram trigger",
  "trigger-teams": "Teams trigger",
  "trigger-photon": "iMessage trigger",
  "trigger-poll": "HTTP poll trigger",
  "agent": "AI Agent",
  "tool": "Tool",
  "skill": "Skill",
  "connection": "Connection",
  "subagent": "Helper agent",
  "flow": "Flow",
};

export const nodeDescription: Record<string, string> = {
  "trigger-manual": "Runs when you click Start in the chat.",
  "trigger-schedule": "Runs automatically on a schedule you pick.",
  "trigger-linear": "Runs when a Linear issue or comment fires.",
  "trigger-discord": "Runs when a Discord message or command fires.",
  "trigger-telegram": "Runs when a Telegram bot receives a message.",
  "trigger-teams": "Runs when a Teams message hits the bot.",
  "trigger-photon": "Runs on iMessage via Photon.",
  "trigger-poll": "Fetches an endpoint on a schedule.",
  "agent": "The brain. Reads instructions and uses tools.",
  "tool": "Something the agent can do — call an API, run code.",
  "skill": "A recipe the agent reads only when it's relevant.",
  "connection": "A service the agent can talk to (MCP or OpenAPI).",
  "subagent": "A smaller specialist the agent can delegate to.",
  "flow": "Multi-step tool with branches, loops, and set/return.",
};
