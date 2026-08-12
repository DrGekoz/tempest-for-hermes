import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Plus, Trash2, FileText } from "lucide-react";

interface AssetRow {
  id: string;
  name: string;
  sourcePath: string;
  contentType: string;
  linkedSymbols: string[];
  updatedAt: number;
}

async function atlasCall<T>(projectPath: string, tool: string, args: Record<string, unknown> = {}): Promise<T> {
  const raw = await invoke<string>("atlas_mcp_call", {
    projectPath,
    toolName: tool,
    argsJson: JSON.stringify(args),
  });
  const result = JSON.parse(raw) as { content?: Array<{ text: string }>; isError?: boolean };
  return JSON.parse(result.content?.[0]?.text ?? "null") as T;
}

export function AssetsPanel({ projectPath }: { projectPath: string | null }) {
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!projectPath) return;
    setLoading(true);
    setError("");
    try {
      const data = await atlasCall<AssetRow[]>(projectPath, "atlas_assets", { format: "json" });
      setAssets(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function addDocs() {
    if (!projectPath) return;
    const picked = await open({ multiple: true });
    if (!picked) return;
    const list = Array.isArray(picked) ? picked : [picked];
    setError("");
    for (const p of list) {
      try {
        await atlasCall(projectPath, "atlas_asset_add", { path: p });
      } catch (e) {
        setError(String(e));
        break;
      }
    }
    await refresh();
  }

  async function remove(id: string) {
    if (!projectPath) return;
    try {
      await atlasCall(projectPath, "atlas_asset_remove", { id });
      setAssets((prev) => prev.filter((a) => a.id !== id));
    } catch (e) {
      setError(String(e));
    }
  }

  if (!projectPath) {
    return (
      <div className="kb-assets-panel">
        <div className="kb-assets-empty-state">
          <span className="kb-empty-title">No project selected</span>
          <span className="kb-empty-desc">Select an indexed project to manage its documents.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="kb-assets-panel">
      <div className="kb-assets-header">
        <span className="kb-assets-title">Attached Documents</span>
        <button className="kb-assets-add-btn" onClick={addDocs}>
          <Plus size={12} />Add
        </button>
      </div>

      {error && <div className="kb-assets-error">{error}</div>}

      {loading ? (
        <div className="kb-assets-loading">Loading…</div>
      ) : assets.length === 0 ? (
        <div className="kb-assets-empty-state">
          <FileText size={32} className="kb-assets-empty-icon" />
          <span className="kb-empty-title">No documents attached</span>
          <span className="kb-empty-desc">
            Add markdown notes, text files, or PDFs to index them in the knowledge graph.
          </span>
        </div>
      ) : (
        <div className="kb-assets-list">
          {assets.map((a) => (
            <div key={a.id} className="kb-asset-row">
              <FileText size={14} className="kb-asset-icon" />
              <div className="kb-asset-info">
                <span className="kb-asset-name">{a.name}</span>
                <span className="kb-asset-meta">
                  <span className="kb-asset-type">{a.contentType.split("/")[1] ?? a.contentType}</span>
                  {a.linkedSymbols.length > 0 && (
                    <span className="kb-asset-links">{a.linkedSymbols.length} linked</span>
                  )}
                </span>
              </div>
              <button className="kb-asset-remove" onClick={() => remove(a.id)} title="Remove document">
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
