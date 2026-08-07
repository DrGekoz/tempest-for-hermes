import { BaseEdge, EdgeLabelRenderer, getBezierPath, useReactFlow, type EdgeProps } from "@xyflow/react";
import { X } from "lucide-react";

// Removable connection edge. Mirrors threads/ThreadEdge — React Flow has no
// built-in disconnect gesture, so each edge carries a midpoint × button.
export function AutomationEdge({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, markerEnd,
}: EdgeProps) {
  const { deleteElements } = useReactFlow();
  const [path, labelX, labelY] = getBezierPath({
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  });

  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <button
          className="am-edge-del nodrag nopan"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          onClick={(e) => { e.stopPropagation(); void deleteElements({ edges: [{ id }] }); }}
          title="Remove connection"
        >
          <X size={11} strokeWidth={2.5} />
        </button>
      </EdgeLabelRenderer>
    </>
  );
}
