import { Hammer, Loader, Play, RefreshCw, Square } from "lucide-react";

export type BuildState = "idle" | "building" | "built" | "starting" | "running" | "error";

interface Props {
  state: BuildState;
  port?: number;
  builtAt: string | null;
  onBuild: () => void;
  onStart: () => void;
  onStop: () => void;
  onOpenChat?: () => void;
}

export function BuildBar({ state, port, builtAt, onBuild, onStart, onStop, onOpenChat }: Props) {
  const isBuilding = state === "building";
  const isRunning = state === "running";
  const isStarting = state === "starting";
  const canBuild = !isBuilding && !isRunning && !isStarting;
  const canStart = state === "built" || (builtAt !== null && state === "idle") || state === "error";

  return (
    <div className="am-buildbar">
      <div className="am-buildbar-left">
        <span className={`am-buildbar-dot am-buildbar-dot--${state}`} />
        <span className="am-buildbar-state">
          {state === "idle" && (builtAt ? "Built" : "Not built")}
          {state === "building" && "Building…"}
          {state === "built" && "Built"}
          {state === "starting" && "Starting…"}
          {state === "running" && `Running · :${port}`}
          {state === "error" && "Build failed"}
        </span>
      </div>
      <div className="am-buildbar-right">
        <button
          className="am-buildbar-btn"
          onClick={onBuild}
          disabled={!canBuild}
          title="Regenerate Eve project and run `eve build`"
        >
          {isBuilding ? <Loader size={13} className="am-spin" /> : <Hammer size={13} />}
          {builtAt ? "Rebuild" : "Build"}
        </button>
        {isRunning ? (
          <>
            {onOpenChat && (
              <button className="am-buildbar-btn am-buildbar-btn--primary" onClick={onOpenChat}>
                <Play size={13} />
                Chat
              </button>
            )}
            <button className="am-buildbar-btn am-buildbar-btn--stop" onClick={onStop}>
              <Square size={13} />
              Stop
            </button>
          </>
        ) : (
          <button
            className="am-buildbar-btn am-buildbar-btn--primary"
            onClick={onStart}
            disabled={!canStart || isStarting}
            title={canStart ? "Start the agent" : "Build first"}
          >
            {isStarting ? <Loader size={13} className="am-spin" /> : <RefreshCw size={13} />}
            Start
          </button>
        )}
      </div>
    </div>
  );
}
