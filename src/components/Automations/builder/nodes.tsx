import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  Bot, Wrench, BookOpen, Plug, Users, Play, Clock,
} from "lucide-react";
import type {
  AgentData, ToolData, SkillData, ConnectionData, SubagentData,
  TriggerManualData, TriggerScheduleData,
} from "./graph";

// One bottom port on Agent for all sub-node attachments. Edge color derives
// from the connected sub-node kind (see builder.tsx / edge style). Keeps the
// component simple; typed handles can come later if visual grouping matters.
// ponytail: one handle, color the wire; upgrade to 4 typed handles if the
// visual grouping becomes worth the code.

function NodeCard(props: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  tone: "trigger" | "agent" | "tool" | "skill" | "connection" | "subagent";
  selected?: boolean;
  topHandle?: boolean;
  bottomHandle?: boolean;
  rightHandle?: boolean;
  leftHandle?: boolean;
}) {
  return (
    <div className={`amn amn--${props.tone}${props.selected ? " amn--selected" : ""}`}>
      {props.topHandle && <Handle type="target" position={Position.Top} id="t" />}
      {props.leftHandle && <Handle type="target" position={Position.Left} id="l" />}
      <div className="amn-body">
        <span className="amn-icon">{props.icon}</span>
        <div className="amn-text">
          <span className="amn-title">{props.title}</span>
          {props.subtitle && <span className="amn-sub">{props.subtitle}</span>}
        </div>
      </div>
      {props.rightHandle && <Handle type="source" position={Position.Right} id="r" />}
      {props.bottomHandle && <Handle type="source" position={Position.Bottom} id="b" />}
    </div>
  );
}

const TriggerManualNode = memo(({ data, selected }: NodeProps) => {
  const d = data as unknown as TriggerManualData;
  return (
    <NodeCard
      icon={<Play size={14} />}
      title="Manual"
      subtitle={d.label || "Start button"}
      tone="trigger"
      selected={selected}
      rightHandle
    />
  );
});

const TriggerScheduleNode = memo(({ data, selected }: NodeProps) => {
  const d = data as unknown as TriggerScheduleData;
  return (
    <NodeCard
      icon={<Clock size={14} />}
      title="Schedule"
      subtitle={d.cron || "Set cron"}
      tone="trigger"
      selected={selected}
      rightHandle
    />
  );
});

const AgentNode = memo(({ data, selected }: NodeProps) => {
  const d = data as unknown as AgentData;
  return (
    <NodeCard
      icon={<Bot size={14} />}
      title="Agent"
      subtitle={d.model || "claude-sonnet-5"}
      tone="agent"
      selected={selected}
      leftHandle
      bottomHandle
    />
  );
});

const ToolNode = memo(({ data, selected }: NodeProps) => {
  const d = data as unknown as ToolData;
  return (
    <NodeCard
      icon={<Wrench size={14} />}
      title={d.name || "Tool"}
      subtitle={d.preset === "http" ? `${d.httpMethod || "GET"} ${d.httpUrl || ""}` : "Custom"}
      tone="tool"
      selected={selected}
      topHandle
    />
  );
});

const SkillNode = memo(({ data, selected }: NodeProps) => {
  const d = data as unknown as SkillData;
  return (
    <NodeCard
      icon={<BookOpen size={14} />}
      title={d.name || "Skill"}
      subtitle="Markdown"
      tone="skill"
      selected={selected}
      topHandle
    />
  );
});

const ConnectionNode = memo(({ data, selected }: NodeProps) => {
  const d = data as unknown as ConnectionData;
  return (
    <NodeCard
      icon={<Plug size={14} />}
      title={d.name || "Connection"}
      subtitle={`${d.kind?.toUpperCase() || "MCP"}`}
      tone="connection"
      selected={selected}
      topHandle
    />
  );
});

const SubagentNode = memo(({ data, selected }: NodeProps) => {
  const d = data as unknown as SubagentData;
  return (
    <NodeCard
      icon={<Users size={14} />}
      title={d.name || "Subagent"}
      subtitle={d.model || "claude-sonnet-5"}
      tone="subagent"
      selected={selected}
      topHandle
    />
  );
});

export const nodeTypes = {
  "trigger-manual": TriggerManualNode,
  "trigger-schedule": TriggerScheduleNode,
  "agent": AgentNode,
  "tool": ToolNode,
  "skill": SkillNode,
  "connection": ConnectionNode,
  "subagent": SubagentNode,
};

export const nodeIcon: Record<string, React.ReactNode> = {
  "trigger-manual": <Play size={13} />,
  "trigger-schedule": <Clock size={13} />,
  "agent": <Bot size={13} />,
  "tool": <Wrench size={13} />,
  "skill": <BookOpen size={13} />,
  "connection": <Plug size={13} />,
  "subagent": <Users size={13} />,
};

export const nodeLabel: Record<string, string> = {
  "trigger-manual": "Manual trigger",
  "trigger-schedule": "Schedule trigger",
  "agent": "Agent",
  "tool": "Tool",
  "skill": "Skill",
  "connection": "Connection",
  "subagent": "Subagent",
};
