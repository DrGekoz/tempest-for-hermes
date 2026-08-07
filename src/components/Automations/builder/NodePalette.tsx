import { nodeIcon, nodeLabel, nodeDescription } from "./nodes";
import type { NodeKind } from "./graph";

interface Group { label: string; kinds: NodeKind[] }
const GROUPS: Group[] = [
  { label: "1. Pick a trigger", kinds: ["trigger-manual", "trigger-schedule"] },
  {
    // P8: channel triggers. Webhook / Slack / GitHub (P5) will land in a
    // separate group once they ship; for now these six cover the rest.
    label: "More triggers",
    kinds: [
      "trigger-linear", "trigger-discord", "trigger-telegram",
      "trigger-teams", "trigger-photon", "trigger-poll",
    ],
  },
  { label: "2. Add the agent", kinds: ["agent"] },
  { label: "3. Give it capabilities", kinds: ["tool", "flow", "skill", "connection", "subagent"] },
];

interface Props {
  hasAgent: boolean;
  onDragStart: (kind: NodeKind, e: React.DragEvent) => void;
  onClick: (kind: NodeKind) => void;
}

export function NodePalette({ hasAgent, onDragStart, onClick }: Props) {
  return (
    <div className="am-palette">
      <div className="am-palette-intro">
        Drag blocks onto the canvas, or click to drop one in the middle.
      </div>
      {GROUPS.map(g => (
        <div key={g.label} className="am-palette-group">
          <div className="am-palette-label">{g.label}</div>
          {g.kinds.map(k => {
            const disabled = k === "agent" && hasAgent;
            return (
              <div
                key={k}
                className={`am-palette-item am-palette-item--${k}${disabled ? " am-palette-item--disabled" : ""}`}
                draggable={!disabled}
                onDragStart={e => !disabled && onDragStart(k, e)}
                onClick={() => !disabled && onClick(k)}
                title={disabled ? "Only one Agent per automation" : `Click or drag to add`}
              >
                <span className="am-palette-icon">{nodeIcon[k]}</span>
                <div className="am-palette-text">
                  <span className="am-palette-name">{nodeLabel[k]}</span>
                  <span className="am-palette-desc">{nodeDescription[k]}</span>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
