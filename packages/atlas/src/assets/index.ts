/**
 * Asset nodes — human-attached knowledge (atlas-extension-plan Rung 3).
 *
 * An asset is a file the developer attaches to the graph (a markdown note, a
 * design doc, an ADR). It lives as a `nodes` row with `kind: 'asset'` — which
 * gets it FTS indexing, embedding sync, and edges FK "for free" — plus a row
 * in the `assets` companion table for asset-only fields (content_type,
 * extracted_text, source_path). Attach an asset to a code symbol with
 * {@link linkAsset}; the link is a normal `describes` edge, so it flows
 * through the existing traversal.
 *
 * ponytail: no chunking, no PDF, no image embeddings. Long docs are truncated
 * at the embed window; add {@link ../db/schema.sql}'s `asset_chunks` table
 * when a real long asset regresses recall.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'node:crypto';
import type { QueryBuilder } from '../db/queries';
import type { Asset, Edge, Node } from '../types';

/**
 * Content types we can read as text right now. Everything else stores as an
 * asset row with `extractedText = null` — the file is tracked and linkable,
 * but its content doesn't feed FTS/embedding. Add a case in
 * {@link extractText} when a new type actually matters.
 */
const TEXT_EXTENSIONS: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.mdx': 'text/markdown',
  '.txt': 'text/plain',
  '.text': 'text/plain',
  '.json': 'application/json',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.rst': 'text/x-rst',
  '.adoc': 'text/asciidoc',
  '.org': 'text/org',
  '.log': 'text/plain',
};

/** Max characters kept in `docstring` — feeds FTS + the embed-text. MiniLM's
 * ~256-token window is well under this; the extra room helps FTS. */
const DOCSTRING_MAX_CHARS = 4000;

/** Max characters kept in `extracted_text` — the field `atlas_asset_content`
 * returns. Bounded so a stray huge log file can't blow up query results. */
const EXTRACTED_TEXT_MAX_CHARS = 200_000;

function assetId(sourcePath: string): string {
  return 'asset:' + createHash('sha1').update(sourcePath).digest('hex');
}

function detectContentType(absPath: string): string {
  const ext = path.extname(absPath).toLowerCase();
  return TEXT_EXTENSIONS[ext] ?? 'application/octet-stream';
}

/**
 * Read + text-extract the file, returning `null` for unsupported types.
 * ponytail: PDF/image handled later — wire `pdf-parse` in when the first PDF
 * asset actually gets attached, not before.
 */
function extractText(absPath: string, contentType: string): string | null {
  if (!contentType.startsWith('text/') && contentType !== 'application/json') {
    return null;
  }
  try {
    const raw = fs.readFileSync(absPath, 'utf-8');
    return raw.length > EXTRACTED_TEXT_MAX_CHARS ? raw.slice(0, EXTRACTED_TEXT_MAX_CHARS) : raw;
  } catch {
    return null;
  }
}

function relPath(projectRoot: string, absPath: string): string {
  const rel = path.relative(projectRoot, absPath);
  return rel.split(path.sep).join('/');
}

function toAsset(
  nodeRow: Pick<Node, 'name' | 'updatedAt'>,
  assetRow: { id: string; content_type: string; source_path: string; extracted_text: string | null }
): Asset {
  return {
    id: assetRow.id,
    name: nodeRow.name,
    sourcePath: assetRow.source_path,
    contentType: assetRow.content_type,
    extractedText: assetRow.extracted_text,
    updatedAt: nodeRow.updatedAt,
  };
}

/**
 * Add or refresh an asset from a file on disk. Idempotent — call again after
 * the file changes to re-read and re-hash; the id is stable across re-adds.
 * Throws only if the file doesn't exist.
 */
export function addAsset(
  queries: QueryBuilder,
  projectRoot: string,
  sourcePathInput: string,
  opts: { name?: string } = {}
): Asset {
  const absPath = path.isAbsolute(sourcePathInput)
    ? sourcePathInput
    : path.resolve(projectRoot, sourcePathInput);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Asset file not found: ${absPath}`);
  }
  const sourcePath = relPath(projectRoot, absPath);
  const id = assetId(sourcePath);
  const contentType = detectContentType(absPath);
  const extractedText = extractText(absPath, contentType);
  const name = opts.name ?? path.basename(sourcePath);
  const now = Date.now();

  // Feed FTS + the embedder via the existing `docstring` channel. The embed-text
  // template is `{name} {qualifiedName} {signature} {docstring}` — for an asset,
  // qualifiedName is the path, signature is the content-type, docstring is a
  // truncated prefix of the content. That means an asset's semantic vector
  // captures both its identity and (a slice of) its content in one pass, no
  // parallel pipeline needed.
  const docstring = extractedText ? extractedText.slice(0, DOCSTRING_MAX_CHARS) : null;

  const node: Node = {
    id,
    kind: 'asset',
    name,
    qualifiedName: sourcePath,
    filePath: sourcePath,
    language: 'unknown',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    docstring: docstring ?? undefined,
    signature: contentType,
    updatedAt: now,
  };
  queries.insertNode(node); // INSERT OR REPLACE — safe re-add
  queries.upsertAssetRow(id, contentType, sourcePath, extractedText);

  return {
    id,
    name,
    sourcePath,
    contentType,
    extractedText,
    updatedAt: now,
  };
}

/**
 * Remove an asset entirely. Its describes-edges cascade via the nodes FK.
 * Returns true if an asset row was deleted.
 */
export function removeAsset(queries: QueryBuilder, id: string): boolean {
  if (!queries.getAssetRow(id)) return false;
  // The nodes-row delete cascades edges (source or target) via ON DELETE CASCADE
  // in the schema, and cascades the assets companion row too (FK on id).
  queries.deleteNode(id);
  return true;
}

/**
 * Add a `describes` edge from an asset to a code symbol. Idempotent —
 * the UNIQUE(source,target,kind,line,col) index on edges dedups.
 * Throws if either node is missing so the caller sees an actionable error
 * instead of a silently-dropped edge.
 */
export function linkAsset(queries: QueryBuilder, assetId: string, symbolId: string): void {
  if (!queries.getAssetRow(assetId)) {
    throw new Error(`Asset not found: ${assetId}`);
  }
  if (!queries.getNodeById(symbolId)) {
    throw new Error(`Symbol not found: ${symbolId}`);
  }
  const edge: Edge = {
    source: assetId,
    target: symbolId,
    kind: 'describes',
    provenance: 'heuristic',
    confidence: 'EXTRACTED', // human-declared — the strongest tier
  };
  queries.insertEdge(edge);
}

/**
 * Remove a `describes` edge. Returns true if it existed. Silent on unknown ids
 * — useful for cleanup scripts that don't want to re-check membership.
 */
export function unlinkAsset(queries: QueryBuilder, assetId: string, symbolId: string): boolean {
  return queries.deleteDescribesEdge(assetId, symbolId);
}

export interface ListAssetsOptions {
  /** MIME prefix filter (e.g. `'text/'`). */
  contentType?: string;
  /** Only assets linked to this symbol. */
  linkedTo?: string;
}

export function listAssets(queries: QueryBuilder, opts: ListAssetsOptions = {}): Asset[] {
  const ids = opts.linkedTo
    ? queries.listAssetIdsLinkedTo(opts.linkedTo)
    : queries.listAssetIds(opts.contentType);
  const out: Asset[] = [];
  for (const id of ids) {
    const assetRow = queries.getAssetRow(id);
    const node = queries.getNodeById(id);
    if (!assetRow || !node) continue;
    out.push(toAsset(node, assetRow));
  }
  return out;
}

/** Full extracted text of an asset (already capped at add time). Null if the
 * asset has no text layer (binary/unsupported type). */
export function getAssetContent(queries: QueryBuilder, id: string): Asset | null {
  const assetRow = queries.getAssetRow(id);
  const node = queries.getNodeById(id);
  if (!assetRow || !node) return null;
  return toAsset(node, assetRow);
}

/** Symbol ids an asset is attached to. */
export function getAssetLinks(queries: QueryBuilder, id: string): string[] {
  return queries.listSymbolIdsForAsset(id);
}

/** Resolve a source-path (relative to project root) to the asset id. */
export function resolveAssetIdByPath(_queries: QueryBuilder, projectRoot: string, sourcePath: string): string {
  const abs = path.isAbsolute(sourcePath) ? sourcePath : path.resolve(projectRoot, sourcePath);
  return assetId(relPath(projectRoot, abs));
}
