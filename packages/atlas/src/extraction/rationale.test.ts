/**
 * Self-check for rationale extraction. Ponytail: one assert-based demo, no
 * framework. Run with: `npx tsx src/extraction/rationale.test.ts` from
 * packages/atlas.
 */
import * as assert from 'node:assert/strict';
import { Node } from '../types';
import { extractRationale } from './rationale';

function fn(name: string, startLine: number, endLine: number): Node {
  return {
    id: `function:${name}`,
    kind: 'function',
    name,
    qualifiedName: `test.ts::${name}`,
    filePath: 'test.ts',
    language: 'typescript',
    startLine,
    endLine,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
  };
}

function demo(): void {
  // Every marker style used by supported languages, plus a false-positive trap
  // ("URL:" inside a comment must NOT match).
  const source = [
    /* 1 */ '// WHY: entry banner',
    /* 2 */ 'function outer() {',
    /* 3 */ '  // NOTE: outer uses a shared cache',
    /* 4 */ '  const x = 1;',
    /* 5 */ '  function inner() {',
    /* 6 */ '    // HACK: retry loop, upstream flakes',
    /* 7 */ '    return x;',
    /* 8 */ '  }',
    /* 9 */ '  # WHY: hash-style comment (Python-ish)',
    /* 10 */ '  -- TODO: SQL-style comment',
    /* 11 */ '  /* NOTE: block comment on one line */',
    /* 12 */ '  // see URL: https://example.com — should NOT match',
    /* 13 */ '  return inner();',
    /* 14 */ '}',
  ].join('\n');

  const nodes: Node[] = [fn('outer', 2, 14), fn('inner', 5, 8)];
  const { nodes: rat, edges } = extractRationale('test.ts', source, 'typescript', nodes);

  const byTag = (t: string) => rat.filter((r) => r.signature === `${t}:`);
  assert.equal(byTag('WHY').length, 2, 'two WHY nodes (banner + hash line)');
  assert.equal(byTag('NOTE').length, 2, 'two NOTE nodes (line 3 + line 11)');
  assert.equal(byTag('HACK').length, 1, 'one HACK node');
  assert.equal(byTag('TODO').length, 1, 'one TODO node');
  assert.equal(rat.length, 6, 'six rationale nodes total (URL trap must not match)');

  // Every non-orphan rationale points at its nearest enclosing symbol.
  const edgeTargetsForLine = (line: number) =>
    edges.filter((e) => e.line === line).map((e) => e.target);
  assert.deepEqual(edgeTargetsForLine(6), ['function:inner'], 'HACK on line 6 explains inner (smaller span wins)');
  assert.deepEqual(edgeTargetsForLine(3), ['function:outer'], 'NOTE on line 3 explains outer');
  assert.equal(edgeTargetsForLine(1).length, 0, 'banner WHY on line 1 has no enclosing symbol');

  // Every emitted edge is the `explains` kind with EXTRACTED confidence.
  for (const e of edges) {
    assert.equal(e.kind, 'explains');
    assert.equal(e.confidence, 'EXTRACTED');
  }

  // Every rationale node carries its full text in docstring so embedding + FTS
  // both see the "why".
  const hack = byTag('HACK')[0]!;
  assert.equal(hack.docstring, 'HACK: retry loop, upstream flakes');
  assert.equal(hack.startLine, 6);
  assert.equal(hack.kind, 'rationale');

  console.log('rationale.test.ts OK — ' + rat.length + ' nodes, ' + edges.length + ' edges');
}

demo();
