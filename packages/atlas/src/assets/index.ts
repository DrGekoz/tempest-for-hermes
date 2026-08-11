/**
 * Asset nodes — human-attached knowledge (atlas-extension-plan Rung 3).
 *
 * An asset is a file the developer attaches to the graph (a markdown note, a
 * design doc, an ADR, a PDF). It lives as a `nodes` row with `kind: 'asset'` —
 * which gets it FTS indexing, embedding sync, and edges FK "for free" — plus a
 * row in the `assets` companion table for asset-only fields (content_type,
 * extracted_text, source_path). Long docs are additionally split into
 * `asset_chunks` (one embedding per passage) so a query hits the relevant
 * section instead of the doc's blurred mean. Attach an asset to a code symbol
 * with {@link linkAsset}; the link is a normal `describes` edge, so it flows
 * through the existing traversal.
 *
 * PDF text is extracted via `pdf-parse` when the optionalDependency is
 * installed; without it, PDFs are still tracked (as an asset row) but with
 * `extractedText = null`. Images stay null-embedding by design (multimodal is
 * a future step, per the plan).
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
  '.pdf': 'application/pdf',
};

/** Max characters kept in `docstring` — feeds FTS + the embed-text. MiniLM's
 * ~256-token window is well under this; the extra room helps FTS. */
const DOCSTRING_MAX_CHARS = 4000;

/** Max characters kept in `extracted_text` — the field `atlas_asset_content`
 * returns. Bounded so a stray huge log file can't blow up query results. */
const EXTRACTED_TEXT_MAX_CHARS = 200_000;

/** Chunk long docs into ~1500-char passages. ~375 tokens at 4 chars/token —
 * safely under MiniLM's 256-token *effective* window after truncation, and each
 * passage gets its own vector so a query hits the section instead of the doc's
 * blurred mean. Only triggers when the extracted text exceeds this: short docs
 * still ride the single-node embedding path.
 * ponytail: hard slices at char boundaries — no paragraph-aware splitter yet;
 * upgrade when a real long doc's chunk boundaries visibly split a section. */
const CHUNK_SIZE = 1500;

/**
 * Chunk `text` into fixed-size slices with a small overlap so a query term
 * straddling a boundary still hits at least one chunk. Empty input → [].
 */
function chunkText(text: string): string[] {
  if (!text) return [];
  if (text.length <= CHUNK_SIZE) return [];
  const overlap = 100;
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + CHUNK_SIZE));
    if (i + CHUNK_SIZE >= text.length) break;
    i += CHUNK_SIZE - overlap;
  }
  return chunks;
}

function assetId(sourcePath: string): string {
  return 'asset:' + createHash('sha1').update(sourcePath).digest('hex');
}

function detectContentType(absPath: string): string {
  const ext = path.extname(absPath).toLowerCase();
  return TEXT_EXTENSIONS[ext] ?? 'application/octet-stream';
}

/**
 * Read + text-extract the file, returning `null` for unsupported types or
 * failures. PDF handled via `pdf-parse` (optionalDependency) — lazy require so
 * a missing install just downgrades PDFs to null text, everything else keeps
 * working. Images stay null-embedding per the plan (multimodal is out of scope).
 */
async function extractText(absPath: string, contentType: string): Promise<string | null> {
  try {
    if (contentType.startsWith('text/') || contentType === 'application/json') {
      const raw = fs.readFileSync(absPath, 'utf-8');
      return raw.length > EXTRACTED_TEXT_MAX_CHARS ? raw.slice(0, EXTRACTED_TEXT_MAX_CHARS) : raw;
    }
    if (contentType === 'application/pdf') {
      let pdfParse: ((buf: Buffer) => Promise<{ text: string }>) | null = null;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string }>;
      } catch {
        return null; // optionalDependency not installed → treat like binary
      }
      const buf = fs.readFileSync(absPath);
      const out = await pdfParse(buf);
      const text = out.text ?? '';
      return text.length > EXTRACTED_TEXT_MAX_CHARS ? text.slice(0, EXTRACTED_TEXT_MAX_CHARS) : text;
    }
  } catch {
    // read/parse failure — treat as binary, still tracked
  }
  return null;
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
export async function addAsset(
  queries: QueryBuilder,
  projectRoot: string,
  sourcePathInput: string,
  opts: { name?: string } = {}
): Promise<Asset> {
  const absPath = path.isAbsolute(sourcePathInput)
    ? sourcePathInput
    : path.resolve(projectRoot, sourcePathInput);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Asset file not found: ${absPath}`);
  }
  const sourcePath = relPath(projectRoot, absPath);
  const id = assetId(sourcePath);
  const contentType = detectContentType(absPath);
  const extractedText = await extractText(absPath, contentType);
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

  // Chunk long documents so each passage gets its own vector. Short docs get
  // an empty chunk set (single-node embedding is fine). Idempotent — the
  // queries.replaceAssetChunks call clears the old set before inserting.
  const pieces = extractedText ? chunkText(extractedText) : [];
  const chunks = pieces.map((text, ord) => ({
    id: `chunk:${id.slice('asset:'.length)}:${ord}`,
    ord,
    text,
  }));
  queries.replaceAssetChunks(id, chunks);

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
