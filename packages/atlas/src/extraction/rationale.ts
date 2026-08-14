/**
 * Rationale extraction (atlas-extension-plan note #9).
 *
 * Promotes inline `WHY:` / `NOTE:` / `HACK:` / `TODO:` comments to first-class
 * `rationale` nodes and links each to the nearest enclosing extracted symbol
 * with an `explains` edge. Runs as a language-agnostic post-pass over the raw
 * source and the nodes the language extractor just produced — one place, every
 * grammar, no tree-sitter API. Turns `atlas_explore("why does X do Y")` from
 * "no strong match" into a real graph traversal.
 *
 * ponytail: line-scan regex, not AST. Multi-line continuation comments aren't
 * folded (only the marker line becomes a node). Upgrade path if agent quality
 * demands it: extend the marker line forward through consecutive comment
 * continuation lines of the same style.
 */
import { Node, Edge, Language } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

// (?:^|[^:\w]) prevents "URL: https://foo" or "someWHY:x" from matching. The
// comment-starter half accepts every marker style across the supported
// languages: C-family //, block-comment continuation *, hash #, SQL/Haskell/Lua
// --, Lisp/asm ;, Erlang/MATLAB/Prolog %, and the opening of a /* … */ block.
// Trailing content is captured through end-of-line only — a `*/` closer on the
// same line is stripped after the fact.
const RATIONALE_RE =
  /(?:^|\s)(?:\/\/+|\/\*+|\*+|#+|--+|;+|%+)\s*(WHY|NOTE|HACK|TODO)\s*:\s*(.+?)\s*$/gm;

// Strip a trailing block-comment closer (star-slash) when the marker sat
// inside a one-line block comment.
function cleanText(s: string): string {
  return s.replace(/\*+\/\s*$/, '').trim();
}

/**
 * Find the smallest already-extracted node whose line span contains `line`.
 * Prefers function/method/class-like scopes over file-level so a WHY inside a
 * method attributes to the method, not the file. Returns undefined if nothing
 * contains the line — the rationale node still emits (orphan), but with no
 * `explains` edge.
 */
function enclosingNode(nodes: Node[], line: number): Node | undefined {
  let best: Node | undefined;
  let bestSpan = Infinity;
  for (const n of nodes) {
    if (n.kind === 'rationale' || n.kind === 'asset') continue;
    if (line < n.startLine || line > n.endLine) continue;
    const span = n.endLine - n.startLine;
    if (span < bestSpan) {
      best = n;
      bestSpan = span;
    }
  }
  return best;
}

export interface RationaleResult {
  nodes: Node[];
  edges: Edge[];
}

export function extractRationale(
  filePath: string,
  source: string,
  language: Language,
  extractedNodes: Node[],
): RationaleResult {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const now = Date.now();

  // Pre-compute newline offsets so a regex match index maps to a 1-indexed line
  // without splitting the entire source into lines just for a per-match lookup.
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineOf = (idx: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  RATIONALE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = RATIONALE_RE.exec(source)) !== null) {
    const tag = m[1]!;
    const text = cleanText(m[2]!);
    if (!text) continue;
    const line = lineOf(m.index);

    // Per-file dedupe: same tag + text + line collapses to one node. Guards
    // against the rare case of two overlapping regex matches on one line.
    const key = `${tag}\0${line}\0${text}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const name = text.length > 60 ? text.slice(0, 57) + '...' : text;
    const qualifiedName = `${filePath}::${tag}@${line}`;
    const id = generateNodeId(filePath, 'rationale', qualifiedName, line);

    const rationaleNode: Node = {
      id,
      kind: 'rationale',
      name,
      qualifiedName,
      filePath,
      language,
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: 0,
      signature: `${tag}:`,
      docstring: `${tag}: ${text}`,
      updatedAt: now,
    };
    nodes.push(rationaleNode);

    const enc = enclosingNode(extractedNodes, line);
    if (enc && enc.id !== id) {
      edges.push({
        source: id,
        target: enc.id,
        kind: 'explains',
        line,
        provenance: 'tree-sitter',
        confidence: 'EXTRACTED',
      });
    }
  }

  return { nodes, edges };
}
