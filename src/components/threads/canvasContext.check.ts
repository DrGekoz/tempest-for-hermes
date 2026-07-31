// Self-check for the pure canvas-context builders. Run with
// `node src/components/threads/canvasContext.check.ts` (Node strips types; no build).
import assert from "node:assert";
import { chatGist, firstLine, formatCanvasGraph } from "./canvasContext.ts";
import type { ChatMessage } from "../../types/chat";

// ── chatGist: last message, role-prefixed, truncated ─────────────────────────
{
  const msgs: ChatMessage[] = [
    { id: "1", role: "user", parts: [{ type: "text", content: "hello" }] },
    { id: "2", role: "assistant", parts: [{ type: "text", content: "  many   spaces\nhere " }] },
  ];
  assert.strictEqual(chatGist(msgs), "assistant: many spaces here");
  assert.strictEqual(chatGist([]), "");
  // Non-text parts (tool-call/proposal) contribute nothing; empty text → "".
  assert.strictEqual(
    chatGist([{ id: "3", role: "assistant", parts: [{ type: "tool-call", id: "t", toolName: "x", args: {}, status: "running" }] }]),
    "",
  );
  // Truncates past 80 chars with an ellipsis.
  const long = "x".repeat(200);
  const g = chatGist([{ id: "4", role: "user", parts: [{ type: "text", content: long }] }]);
  assert.strictEqual(g, "user: " + "x".repeat(80) + "…");
}

// ── firstLine: first non-empty line, trimmed ─────────────────────────────────
{
  assert.strictEqual(firstLine("\n\n  # Title  \nbody"), "# Title");
  assert.strictEqual(firstLine(""), "");
  assert.strictEqual(firstLine("a".repeat(150), 100), "a".repeat(100) + "…");
}

// ── formatCanvasGraph: excludes self, renders nodes + wiring, caps ───────────
{
  const nodes = [
    { id: "self", kind: "chat", title: "me" },
    { id: "a", kind: "text", title: "spec", gist: "# API" },
    { id: "b", kind: "agent", title: "bot", gist: "branch=feat · live" },
  ];
  const edges = [
    { source: "a", target: "self" }, // wired into self → "this chat"
    { source: "b", target: "a" },
    { source: "a", target: "ghost" }, // dangling target → dropped
  ];
  const out = formatCanvasGraph(nodes, edges, "self");
  assert.ok(!out.includes('"me"'), "self node excluded");
  assert.ok(out.includes('- [text] "spec" — # API'));
  assert.ok(out.includes('- [agent] "bot" — branch=feat · live'));
  assert.ok(out.includes('- "spec" → "this chat"'), "self rendered as 'this chat'");
  assert.ok(out.includes('- "bot" → "spec"'));
  assert.ok(!out.includes("ghost"), "edge to unknown node dropped");

  // Empty when nothing but self.
  assert.strictEqual(formatCanvasGraph([{ id: "self", kind: "chat", title: "me" }], [], "self"), "");

  // Cap: 3 nodes, max 2 → 2 lines + "and 1 more".
  const many = [
    { id: "1", kind: "text", title: "one" },
    { id: "2", kind: "text", title: "two" },
    { id: "3", kind: "text", title: "three" },
  ];
  const capped = formatCanvasGraph(many, [], "self", 2);
  assert.ok(capped.includes("…and 1 more"), "overflow noted");
  assert.ok(!capped.includes('"three"'), "capped node not listed");
}

console.log("canvasContext: all checks passed");
