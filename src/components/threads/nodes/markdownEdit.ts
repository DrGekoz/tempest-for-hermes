// Pure markdown edit transforms for the TextNode toolbar / selection bubble.
// No CodeMirror or DOM here — the CM command wrappers (in TextNode.tsx) feed
// these the selected text and splice the result back. Kept pure so they run
// under the repo's node-based `*.check.ts` harness.

export type LineOp = "h1" | "h2" | "h3" | "bullet" | "numbered" | "quote";

// Strip any leading block marker (heading / list / quote) so ops can swap
// cleanly between block types instead of stacking `- > # text`.
const stripBlock = (l: string) => l.replace(/^(#{1,6} |[-*] |\d+\. |> )/, "");

const nonEmpty = (lines: string[]) => lines.filter((l) => l.trim().length > 0);

// Inline wrap toggle. If the selection is already fenced by the markers,
// unwrap; otherwise wrap. Toggling off requires the markers to be inside the
// selection (select `**word**`, not just `word`).
export function applyWrap(sel: string, before: string, after = before): string {
  if (sel.startsWith(before) && sel.endsWith(after) && sel.length >= before.length + after.length) {
    return sel.slice(before.length, sel.length - after.length);
  }
  return before + sel + after;
}

// Block toggle over a run of lines. If every non-empty line already carries the
// op's marker, remove it from all; otherwise apply it to all (numbered lines
// renumber sequentially).
export function applyLineOp(lines: string[], op: LineOp): string[] {
  if (op === "h1" || op === "h2" || op === "h3") {
    const p = "#".repeat(Number(op[1])) + " ";
    const on = nonEmpty(lines).length > 0 && nonEmpty(lines).every((l) => l.startsWith(p));
    return lines.map((l) => (on ? stripBlock(l) : p + stripBlock(l)));
  }
  if (op === "bullet" || op === "quote") {
    const p = op === "bullet" ? "- " : "> ";
    const on = nonEmpty(lines).length > 0 && nonEmpty(lines).every((l) => l.startsWith(p));
    return lines.map((l) => (on ? (l.startsWith(p) ? l.slice(p.length) : l) : p + stripBlock(l)));
  }
  // numbered
  const on = nonEmpty(lines).length > 0 && nonEmpty(lines).every((l) => /^\d+\. /.test(l));
  let n = 0;
  return lines.map((l) => (on ? l.replace(/^\d+\. /, "") : `${++n}. ` + stripBlock(l)));
}
