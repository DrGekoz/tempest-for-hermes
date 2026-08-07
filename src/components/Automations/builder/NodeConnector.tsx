import { Handle, Position, useConnection, useNodeConnections } from "@xyflow/react";
import { Hexagon } from "lucide-react";

// Threads-style connector: a Hexagon icon rendered inline in a node header
// (not a floating border dot). React Flow's absolute-positioned handle styling
// is neutralized in CSS so this sits as a header icon that still starts a
// connection drag / click-to-connect.
export function NodeConnector({ nodeId, side }: { nodeId: string; side: "left" | "right" }) {
  const connecting = useConnection((c) => c.inProgress && c.fromNode?.id === nodeId);
  const connected = useNodeConnections({
    id: nodeId,
    handleType: side === "left" ? "target" : "source",
  }).length > 0;

  const fill = connecting
    ? "var(--tempest-accent-yellow, #f5c518)"
    : connected
    ? "currentColor"
    : "none";

  const handle = (
    <Handle
      type={side === "left" ? "target" : "source"}
      position={side === "left" ? Position.Left : Position.Right}
      id={side === "left" ? "in" : "out"}
      className={`am-connector nodrag${connecting ? " connecting" : ""}${connected ? " connected" : ""}`}
      title={side === "left" ? "Connect into this node" : "Click or drag to connect"}
    >
      <Hexagon size={13} fill={fill} />
    </Handle>
  );
  if (side === "right") return handle;
  return (
    <>
      {handle}
      <span className="am-connector-sep" />
    </>
  );
}
