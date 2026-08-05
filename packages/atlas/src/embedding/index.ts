/**
 * Semantic retrieval orchestration — the glue between the local embedding model
 * (`./embedder`) and the graph DB (`QueryBuilder`).
 *
 * Two entry points:
 *  - `computeVectorSeeds` — query time: embed the query, brute-force cosine over
 *    stored node vectors, return top-K as entry-point `SearchResult`s.
 *  - `syncEmbeddings`      — index time: drain the "needs embedding" work set in
 *    small batches, in the background, never blocking.
 *
 * Both degrade to a no-op (empty result / silent return) when no model is
 * available, so Atlas stays exactly today's FTS-only tool with no model present.
 */
import type { QueryBuilder } from '../db/queries';
import type { SearchResult } from '../types';
import {
  EMBEDDING_MODEL, EMBEDDABLE_KINDS, embed, embedOne, embedText,
  embedTextHash, cosine, decodeVec, encodeVec,
} from './embedder';

/**
 * Top-K semantically nearest nodes to `query`, as entry-point seeds.
 * Returns `[]` when there are no embeddings or the model can't load — the caller
 * then runs FTS-only. Brute-force cosine is <100 ms at a few-thousand nodes;
 * `sqlite-vec` ANN is the upgrade path when N ≫ 10^5.
 *
 * ponytail: O(N) scan + full sort per query. Fine at this N; swap in sqlite-vec
 * when node counts reach six figures.
 */
export async function computeVectorSeeds(
  queries: QueryBuilder,
  query: string,
  k: number
): Promise<SearchResult[]> {
  if (!queries.hasEmbeddings()) return [];
  try {
    const qv = await embedOne(query);
    const scored: Array<{ id: string; score: number }> = [];
    for (const row of queries.iterateEmbeddings()) {
      scored.push({ id: row.id, score: cosine(qv, decodeVec(row.embedding)) });
    }
    scored.sort((a, b) => b.score - a.score);

    const seeds: SearchResult[] = [];
    for (const s of scored) {
      const node = queries.getNodeById(s.id);
      if (node) seeds.push({ node, score: s.score });
      if (seeds.length >= k) break;
    }
    return seeds;
  } catch {
    // Model unavailable (offline / not installed) → FTS-only.
    return [];
  }
}

// Guard against two overlapping drains on the same graph (e.g. rapid syncs).
const inFlight = new WeakSet<QueryBuilder>();

export interface SyncEmbeddingsOptions {
  /** Nodes per embed batch. Small on purpose — big batches swap-froze the machine. */
  batchSize?: number;
  /** Abort cooperatively (checked between batches). */
  signal?: AbortSignal;
  /** Progress callback: (embeddedSoFar, totalAtStart). */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Embed every node that still needs it for the active model, in small batches
 * with an inter-batch yield so the process stays responsive. Idempotent and
 * crash-safe: the work set is a DB query, so a killed run just resumes the delta.
 *
 * Silently no-ops if the model can't load. Never throws to its caller.
 */
export async function syncEmbeddings(
  queries: QueryBuilder,
  options: SyncEmbeddingsOptions = {}
): Promise<void> {
  if (inFlight.has(queries)) return;
  const batchSize = options.batchSize ?? 8;

  inFlight.add(queries);
  try {
    const total = queries.countNodesNeedingEmbedding(EMBEDDING_MODEL, EMBEDDABLE_KINDS);
    if (total === 0) return;

    let done = 0;
    // Re-query each iteration rather than paginating: every upsert removes a row
    // from the work set, so the same `LIMIT` window always returns fresh rows.
    for (;;) {
      if (options.signal?.aborted) return;
      const rows = queries.getNodesNeedingEmbedding(EMBEDDING_MODEL, EMBEDDABLE_KINDS, batchSize);
      if (rows.length === 0) break;

      const texts = rows.map((r) =>
        embedText({ name: r.name, qualifiedName: r.qualified_name, signature: r.signature, docstring: r.docstring })
      );
      const vecs = await embed(texts); // throws → caught below → silent stop
      const now = Date.now();
      rows.forEach((row, i) => {
        const vec = vecs[i];
        const text = texts[i];
        if (!vec || text === undefined) return;
        queries.upsertEmbedding(row.id, EMBEDDING_MODEL, embedTextHash(text), encodeVec(vec), now);
      });
      done += rows.length;
      options.onProgress?.(done, total);
      await new Promise((r) => setTimeout(r, 50)); // idle-biased: hand the CPU back
    }
  } catch {
    // Model unavailable or transient failure — leave the remaining work set for
    // a later run. FTS keeps serving in the meantime.
  } finally {
    inFlight.delete(queries);
  }
}

/**
 * Whether semantic retrieval is disabled. Opt-in: OFF unless Tempest explicitly
 * turns it on. Tempest passes `--semantic` to `server-entry`, which sets
 * `ATLAS_SEMANTIC=1` (inherited by the detached daemon and query workers). With
 * no consent the model is never loaded or downloaded and Atlas stays FTS-only.
 */
export function semanticDisabled(): boolean {
  const v = (process.env.ATLAS_SEMANTIC ?? '').trim().toLowerCase();
  return !(v === '1' || v === 'on' || v === 'true' || v === 'yes' || v === 'enabled');
}

export { prefetchModel } from './embedder';
export type { ModelProgress } from './embedder';
