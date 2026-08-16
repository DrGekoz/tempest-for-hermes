import { useSyncExternalStore } from "react";

// Ephemeral "is this canvas node actively generating/streaming output right
// now" signal — never persisted, purely a live UI flag so a ThreadEdge feeding
// a generating node can animate to show context flowing in (issue #15). Per-node
// listeners (mirrors workState.ts) so one node's flip only re-renders edges
// that target it, not every edge on the canvas.
const generating = new Set<string>();
const listeners = new Map<string, Set<() => void>>();

function emit(nodeId: string) {
  const subs = listeners.get(nodeId);
  if (subs) for (const fn of subs) fn();
}

function subscribe(nodeId: string, fn: () => void): () => void {
  let subs = listeners.get(nodeId);
  if (!subs) { subs = new Set(); listeners.set(nodeId, subs); }
  subs.add(fn);
  return () => {
    subs!.delete(fn);
    if (subs!.size === 0) listeners.delete(nodeId);
  };
}

export function getNodeGenerating(nodeId: string): boolean {
  return generating.has(nodeId);
}

export function setNodeGenerating(nodeId: string, value: boolean): void {
  if (getNodeGenerating(nodeId) === value) return;
  if (value) generating.add(nodeId); else generating.delete(nodeId);
  emit(nodeId);
}

// Subscribe a component to a single node's generating flag (e.g. a ThreadEdge
// watching its target node).
export function useNodeGenerating(nodeId: string): boolean {
  return useSyncExternalStore(
    (fn) => subscribe(nodeId, fn),
    () => getNodeGenerating(nodeId),
    () => getNodeGenerating(nodeId)
  );
}
