import { useSyncExternalStore } from "react";
import { PROVIDER_MODELS, MODEL_CONTEXT, DEFAULT_CONTEXT, type ChatModel } from "./chatModels.ts";

// Remote config — a data-only patch channel that lives OUTSIDE the app-version
// updater. The models list and their context sizes are bundled as a floor
// (`chatModels.ts`); this fetches an override at startup so a new model can ship
// by editing `config/models.json` and pushing, without cutting a release.
//
// Strictly DISPLAY DATA: model ids, labels, context numbers. Nothing here grants
// privilege, so it needs no signature — the validator below is the tripwire. The
// moment this channel would carry anything that influences behaviour (endpoints,
// allowlists, commands) it must move to signed delivery, like the updater pubkey.

export interface ModelManifest {
  providers: Record<string, ChatModel[]>;
  context: Record<string, number>;
}

const MANIFEST_URL =
  "https://cdn.jsdelivr.net/gh/tempestai-dev/tempest@main/config/models.json";
const CACHE_KEY = "tempest-model-manifest";

/// The bundled tables are the floor. A manifest can only add or replace whole
/// providers, never remove one — so an empty or partial fetch can't blank the UI.
const BUNDLED: ModelManifest = { providers: PROVIDER_MODELS, context: MODEL_CONTEXT };

/// Validate untrusted JSON into a manifest patch. Anything malformed is dropped
/// rather than coerced; unknown keys are ignored. Same defensive stance as
/// `parseTempestConfig` — a bad manifest degrades to "no patch", never a throw.
export function validate(raw: unknown): Partial<ModelManifest> {
  if (typeof raw !== "object" || raw === null) return {};
  const doc = raw as Record<string, unknown>;
  const out: Partial<ModelManifest> = {};

  if (typeof doc.providers === "object" && doc.providers !== null) {
    const providers: Record<string, ChatModel[]> = {};
    for (const [key, v] of Object.entries(doc.providers as Record<string, unknown>)) {
      if (!Array.isArray(v)) continue;
      const models = v
        .filter((m): m is ChatModel =>
          typeof m === "object" && m !== null &&
          typeof (m as ChatModel).id === "string" &&
          typeof (m as ChatModel).label === "string")
        .map((m) => ({ id: m.id, label: m.label }));
      if (models.length) providers[key] = models;
    }
    if (Object.keys(providers).length) out.providers = providers;
  }

  if (typeof doc.context === "object" && doc.context !== null) {
    const context: Record<string, number> = {};
    for (const [key, v] of Object.entries(doc.context as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) context[key] = Math.floor(v);
    }
    if (Object.keys(context).length) out.context = context;
  }

  return out;
}

/// Provider-level replace: a provider the patch names wins whole, one it omits
/// keeps its bundled list. Context entries merge by id. Predictable and total —
/// to add a model you supply that provider's full array.
export function merge(base: ModelManifest, patch: Partial<ModelManifest>): ModelManifest {
  return {
    providers: { ...base.providers, ...(patch.providers ?? {}) },
    context: { ...base.context, ...(patch.context ?? {}) },
  };
}

function readCache(): Partial<ModelManifest> {
  try {
    return validate(JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null"));
  } catch {
    return {};
  }
}

// Resolution order: bundled floor, patched by last-good cache. A live fetch
// overwrites both. So: new installs get bundled, returning users get last-fetched
// even offline, and anyone online gets the latest.
let _manifest: ModelManifest = merge(BUNDLED, readCache());
const _listeners = new Set<() => void>();

export function useModelManifest(): ModelManifest {
  return useSyncExternalStore(
    (cb) => { _listeners.add(cb); return () => _listeners.delete(cb); },
    () => _manifest,
  );
}

export function contextSizeFor(manifest: ModelManifest, modelId: string): number {
  return manifest.context[modelId] ?? DEFAULT_CONTEXT;
}

/// Fetch the manifest once at startup. Silent on any failure — the user did not
/// ask for this, and the bundled/cached floor already works.
export async function startModelManifestFetch(): Promise<void> {
  try {
    const res = await fetch(MANIFEST_URL, { cache: "no-cache" });
    if (!res.ok) return;
    const raw = await res.json();
    const patch = validate(raw);
    if (!patch.providers && !patch.context) return;
    localStorage.setItem(CACHE_KEY, JSON.stringify(raw));
    _manifest = merge(BUNDLED, patch);
    _listeners.forEach((l) => l());
  } catch (e) {
    console.error("[remoteConfig] model manifest fetch failed:", e);
  }
}
