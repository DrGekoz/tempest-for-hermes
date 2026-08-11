import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Atlas from '../src';
import type { Node } from '../src/types';

// End-to-end asset lifecycle: add → link → list → content → unlink → remove.
// A real SQLite instance behind a real Atlas — the FK cascade, FTS trigger, and
// edge dedup are the exact interactions we want to lock down, so mocks would
// hide the bugs this test exists to catch.

function seedCodeNode(atlas: Atlas): Node {
  // Insert a synthetic code node directly through the query layer so the test
  // doesn't depend on tree-sitter grammars loading. It's a `function` kind so
  // an asset can attach to something realistic.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const queries = (atlas as any).queries;
  const node: Node = {
    id: 'fn:test:doThing',
    kind: 'function',
    name: 'doThing',
    qualifiedName: 'src/example.ts::doThing',
    filePath: 'src/example.ts',
    language: 'typescript',
    startLine: 10,
    endLine: 20,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
  };
  queries.insertNode(node);
  return node;
}

describe('assets — Rung 3 lifecycle', () => {
  let projectRoot: string;
  let atlas: Atlas;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'atlas-assets-'));
    mkdirSync(join(projectRoot, 'docs'), { recursive: true });
    atlas = Atlas.initSync(projectRoot);
  });

  afterEach(() => {
    atlas.close();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('adds a markdown asset, links it, lists it, then unlinks and removes it', async () => {
    const notePath = join(projectRoot, 'docs', 'auth-notes.md');
    writeFileSync(notePath, '# Auth Notes\n\nRotate the JWT secret on incident.', 'utf-8');

    const asset = await atlas.addAsset(notePath);
    expect(asset.name).toBe('auth-notes.md');
    expect(asset.sourcePath).toBe('docs/auth-notes.md');
    expect(asset.contentType).toBe('text/markdown');
    expect(asset.extractedText).toContain('Rotate the JWT secret');
    expect(asset.id).toMatch(/^asset:/);

    // Deterministic id: resolveAssetIdByPath must match addAsset's id.
    expect(atlas.resolveAssetIdByPath('docs/auth-notes.md')).toBe(asset.id);

    const code = seedCodeNode(atlas);
    atlas.linkAsset(asset.id, code.id);

    // Idempotent link — calling twice must not double-insert (edges UNIQUE index).
    atlas.linkAsset(asset.id, code.id);
    expect(atlas.getAssetLinks(asset.id)).toEqual([code.id]);

    // Listing by contentType prefix + linkedTo filter both surface the asset.
    expect(atlas.listAssets().map((a) => a.id)).toEqual([asset.id]);
    expect(atlas.listAssets({ contentType: 'text/' }).map((a) => a.id)).toEqual([asset.id]);
    expect(atlas.listAssets({ linkedTo: code.id }).map((a) => a.id)).toEqual([asset.id]);

    // getAsset returns the full extracted text.
    const fetched = atlas.getAsset(asset.id);
    expect(fetched?.extractedText).toContain('Rotate the JWT secret');

    // Unlink then confirm the edge is gone but the asset remains.
    expect(atlas.unlinkAsset(asset.id, code.id)).toBe(true);
    expect(atlas.unlinkAsset(asset.id, code.id)).toBe(false); // second call no-op
    expect(atlas.getAssetLinks(asset.id)).toEqual([]);
    expect(atlas.getAsset(asset.id)).not.toBeNull();

    // Removal: asset + its companion row + any residual edges all vanish.
    expect(atlas.removeAsset(asset.id)).toBe(true);
    expect(atlas.removeAsset(asset.id)).toBe(false);
    expect(atlas.getAsset(asset.id)).toBeNull();
    expect(atlas.listAssets()).toEqual([]);
  });

  it('re-adding an existing asset refreshes its extracted text without duplicating', async () => {
    const p = join(projectRoot, 'docs', 'plan.md');
    writeFileSync(p, 'v1 content', 'utf-8');
    const first = await atlas.addAsset(p);
    writeFileSync(p, 'v2 content', 'utf-8');
    const second = await atlas.addAsset(p);

    expect(second.id).toBe(first.id);
    expect(atlas.listAssets()).toHaveLength(1);
    expect(atlas.getAsset(second.id)?.extractedText).toBe('v2 content');
  });

  it('records a binary/unsupported file as an asset with null extracted text', async () => {
    const p = join(projectRoot, 'docs', 'diagram.png');
    writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic bytes
    const asset = await atlas.addAsset(p);

    expect(asset.contentType).toBe('application/octet-stream');
    expect(asset.extractedText).toBeNull();
    // Still fully listable and linkable — presence in the graph is the value.
    expect(atlas.listAssets().map((a) => a.id)).toContain(asset.id);
  });

  it('throws when linking to a missing symbol so callers see an actionable error', async () => {
    const p = join(projectRoot, 'docs', 'x.md');
    writeFileSync(p, 'x', 'utf-8');
    const asset = await atlas.addAsset(p);
    expect(() => atlas.linkAsset(asset.id, 'symbol:does-not-exist')).toThrow(/Symbol not found/);
  });

  it('splits long docs into chunks and clears them on re-add of a short version', async () => {
    const p = join(projectRoot, 'docs', 'long.md');
    // 5000 chars > CHUNK_SIZE (1500) → should produce multiple chunks with overlap.
    writeFileSync(p, 'x'.repeat(5000), 'utf-8');
    const asset = await atlas.addAsset(p);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const queries = (atlas as any).queries;
    const countLong = queries.db.prepare('SELECT COUNT(*) AS n FROM asset_chunks WHERE asset_id = ?').get(asset.id) as { n: number };
    expect(countLong.n).toBeGreaterThan(1);

    // Re-add with a short body → chunk set gets cleared (empty chunks table for this asset).
    writeFileSync(p, 'short', 'utf-8');
    await atlas.addAsset(p);
    const countShort = queries.db.prepare('SELECT COUNT(*) AS n FROM asset_chunks WHERE asset_id = ?').get(asset.id) as { n: number };
    expect(countShort.n).toBe(0);
  });
});
