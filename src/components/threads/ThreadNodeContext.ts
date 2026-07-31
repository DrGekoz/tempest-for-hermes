import { createContext } from "react";

// Canvas-wide context shared with every node component. React Flow only hands a
// node its own {id, data}, so per-project info (repo path, atlas state, the
// session-spawning callbacks) rides this context from ThreadsView down to the nodes.
export interface ThreadNodeCtx {
  projectId: string;
  projectPath?: string;
  atlasIndexed?: boolean;
  // A chat node's launch proposal → spawn an `agent` node on this canvas, near the
  // firing chat node (`sourceNodeId`), owning a fresh canvas session. Implemented by
  // ThreadsView (it owns the nodes); WorkspaceView only provides the PTY primitive.
  onLaunchAgent?: (agentHint: string, prompt: string, model?: string, sourceNodeId?: string, worktreePath?: string) => void;
  // Spawn a canvas-owned PTY session (no tab). Used by a bare agent/terminal node's
  // "Launch" button. `worktreePath` binds it to a branch (execution binding, plan
  // §3.2); omitted = project root. Resolves once the session is live in sessionManager.
  spawnCanvasSession?: (opts: { agent?: string; name?: string; prompt?: string; model?: string; worktreePath?: string }) => Promise<string | null>;
  // The project's existing worktrees, for the node's "run in" picker.
  worktrees?: { name: string; path: string }[];
  // Cut a new worktree for this project (runs the repo's setup hook). Returns its
  // path, or null on failure. Backs the picker's "New worktree…" option.
  createCanvasWorktree?: (name: string) => Promise<string | null>;
  // Re-spawn a persisted canvas session after an app restart (idempotent).
  resumeCanvasSession?: (sessionId: string) => Promise<void>;
  // Tear down a canvas session (its node was deleted): kill PTY + delete the row.
  closeCanvasSession?: (sessionId: string) => void;
}

export const ThreadNodeContext = createContext<ThreadNodeCtx | null>(null);
