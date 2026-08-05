import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface ModelProgress {
  status: string;      // 'initiate' | 'download' | 'progress' | 'done' | 'ready' | ...
  file?: string;
  progress?: number;   // 0–100 for the current file
  loaded?: number;
  total?: number;
}

/**
 * Download + warm the semantic embedding model, reporting hub progress. Resolves
 * once the model is on disk in Tempest's app-data cache; rejects on failure
 * (offline / no Node / disk). Cached after the first run, so re-invoking is a
 * fast no-op — safe to call whenever the user opts in.
 */
export async function downloadAtlasModel(onProgress?: (p: ModelProgress) => void): Promise<void> {
  const unlisten = await listen<ModelProgress>("atlas:model-download", (e) => onProgress?.(e.payload));
  try {
    await invoke("download_atlas_model");
  } finally {
    unlisten();
  }
}
