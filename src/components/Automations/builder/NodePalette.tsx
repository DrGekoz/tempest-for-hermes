import { nodeIcon, nodeLabel } from "./nodes";
import type { NodeKind } from "./graph";

interface Group { label: string; kinds: NodeKind[] }
const GROUPS: Group[] = [
  { label: "Triggers", kinds: ["trigger-manual", "trigger-schedule"] },
  { label: "Core", kinds: ["agent"] },
  { label: "Capabilities", kinds: ["tool", "skill", "connection", "subagent"] },
];

interface Props {
  hasAgent: boolean;
  onDragStart: (kind: NodeKind, e: React.DragEvent) => void;
}

export function NodePalette({ hasAgent, onDragStart }: Props) {
  return (
    <div className="am-palette">
      {GROUPS.map(g => (
        <div key={g.label} className="am-palette-group">
          <div className="am-palette-label">{g.label}</div>
          {g.kinds.map(k => {
            const disabled = k === "agent" && hasAgent;
            return (
              <div
                key={k}
                className={`am-palette-item${disabled ? " am-palette-item--disabled" : ""}`}
                draggable={!disabled}
                onDragStart={e => !disabled && onDragStart(k, e)}
                title={disabled ? "Only one Agent per automation" : `Drag ${nodeLabel[k]}`}
              >
                <span className="am-palette-icon">{nodeIcon[k]}</span>
                <span>{nodeLabel[k]}</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
