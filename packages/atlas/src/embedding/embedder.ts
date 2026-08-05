/**
 * Local embedding model — all-MiniLM-L6-v2 (384-dim, ~25 MB quantized, CPU).
 *
 * Runs via ONNX through `@xenova/transformers`. No API key, no Python, no GPU.
 * The heavy `@xenova/transformers` import is **dynamic and lazy** so it never
 * lands on Atlas's cold-start path: importing THIS module is free; the model is
 * only loaded on the first `embed()` call. If the package or model can't load
 * (offline, not installed), `embed` throws and callers fall back to FTS-only.
 *
 * MiniLM (unlike nomic) needs no task prefixes — the raw text is embedded.
 */
import { createHash } from 'node:crypto';

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIM = 384;

/**
 * Node kinds worth embedding — the retrievable symbols. Imports, variables,
 * constants, files, etc. carry no semantic entry-point value and are skipped
 * (matches the spike's set that produced the FINDINGS scoreboard).
 */
export const EMBEDDABLE_KINDS = [
  'function', 'method', 'class', 'interface', 'struct', 'enum',
  'type_alias', 'component', 'route',
] as const;

/** Model-download progress event, as reported by @xenova/transformers. */
export interface ModelProgress {
  status: string;      // 'initiate' | 'download' | 'progress' | 'done' | 'ready' | ...
  file?: string;
  progress?: number;   // 0–100 for the current file
  loaded?: number;
  total?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let extractorPromise: Promise<any> | null = null;

async function getExtractor(onProgress?: (p: ModelProgress) => void): Promise<unknown> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      // Dynamic import keeps onnxruntime-node off the cold-start path.
      const mod = await import('@xenova/transformers');
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const env = (mod as any).env;
        if (env) {
          // Route the one-time ~25 MB model download to Tempest's stable,
          // app-owned cache dir (passed via `server-entry --model-cache`, set
          // into ATLAS_MODEL_CACHE). Without this the model caches relative to
          // the process CWD — i.e. into whatever project is indexed first, and
          // re-downloads per project. Fetch once, share across every project.
          const cacheDir = process.env.ATLAS_MODEL_CACHE;
          if (cacheDir) env.cacheDir = cacheDir;
          env.allowRemoteModels = true; // permit the initial fetch; served from cache after
          // Cap threads — a large batch across every core spiked RAM into swap
          // and froze the machine during the spike (see IMPLEMENTATION.md §7).
          // Belt-and-suspenders alongside the small batch sizes callers use.
          env.backends?.onnx?.wasm && (env.backends.onnx.wasm.numThreads = 1);
        }
      } catch { /* env shape is best-effort */ }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (mod as any).pipeline('feature-extraction', EMBEDDING_MODEL, {
        quantized: true,
        ...(onProgress ? { progress_callback: onProgress } : {}),
      });
    })().catch((err) => {
      // Reset so a later call (e.g. after the model finishes downloading) can retry.
      extractorPromise = null;
      throw err;
    });
  }
  return extractorPromise;
}

/**
 * Pre-download and warm the embedding model, reporting hub download progress.
 * Tempest calls this (via `server-entry --download-model`) the moment the user
 * consents during onboarding, so the one-time fetch happens up front behind a
 * progress bar rather than lazily stalling the first index. Resolves when the
 * model is ready; throws if the download fails (offline / disk full).
 */
export async function prefetchModel(onProgress?: (p: ModelProgress) => void): Promise<void> {
  await getExtractor(onProgress);
}

/**
 * Embed a batch of texts → L2-normalized float32 vectors (so cosine == dot).
 * Throws if the model can't load; callers treat that as "no semantic model".
 */
export async function embed(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const extractor = (await getExtractor()) as any;
  const out = await extractor(texts, { pooling: 'mean', normalize: true });
  const [n, dim] = out.dims as [number, number];
  const vecs: Float32Array[] = [];
  for (let i = 0; i < n; i++) {
    vecs.push(Float32Array.from(out.data.slice(i * dim, (i + 1) * dim)));
  }
  return vecs;
}

/** Embed a single query string. */
export async function embedOne(text: string): Promise<Float32Array> {
  const [vec] = await embed([text]);
  if (!vec) throw new Error('embedding failed: empty result');
  return vec;
}

/**
 * The structural summary that gets embedded — name + qualified name + signature
 * + docstring, NOT the body. Enough to win semantic retrieval, fits MiniLM's
 * ~256-token window with no truncation, and (with the hash below) makes sync
 * cheap: a body-only edit doesn't change this string.
 */
export function embedText(node: {
  name?: string | null;
  qualifiedName?: string | null;
  signature?: string | null;
  docstring?: string | null;
}): string {
  return [node.name, node.qualifiedName, node.signature, node.docstring]
    .filter(Boolean)
    .join(' ')
    .slice(0, 2000);
}

/** Stable hash of the embed text — drives change-sync (re-embed iff it moved). */
export function embedTextHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Cosine similarity of two L2-normalized vectors (plain dot product). */
export function cosine(a: Float32Array, b: Float32Array): number {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) d += a[i]! * b[i]!;
  return d;
}

/** Decode a stored little-endian float32 BLOB back to a Float32Array. */
export function decodeVec(blob: Uint8Array): Float32Array {
  const u8 = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const buf = u8.slice(); // fresh, aligned ArrayBuffer (sqlite may hand back a view)
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** Encode a Float32Array to a Buffer for BLOB storage. */
export function encodeVec(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}
