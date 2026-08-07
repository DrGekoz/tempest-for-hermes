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
  // Node stderr is emitted as atlas:log; keep the last few lines so we can attach
  // them to the error message when the download fails (otherwise the UI just
  // says "failed" with zero clue whether node was missing, model fetch stalled,
  // disk perms, etc.).
  const errLines: string[] = [];
  const unlistenErr = await listen<{ line: string }>("atlas:log", (e) => {
    if (e.payload?.line) {
      errLines.push(e.payload.line);
      if (errLines.length > 20) errLines.shift();
    }
  });
  try {
    await invoke("download_atlas_model");
  } catch (e) {
    const tail = errLines.length ? `\n${errLines.join("\n")}` : "";
    throw new Error(`${e}${tail}`);
  } finally {
    unlisten();
    unlistenErr();
  }
}
