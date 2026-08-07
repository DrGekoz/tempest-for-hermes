import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Search } from "lucide-react";
import { CDN, CHAT_PROVIDERS, type ChatModel } from "../../../lib/chatModels";
import { useModelManifest } from "../../../lib/remoteConfig";

interface Props {
  value: string;                       // gateway id, e.g. "anthropic/claude-sonnet-5"
  onChange: (id: string) => void;
  placeholder?: string;
}

// Same visual design as ChatNode's picker (sidebar of provider icons + right
// panel with search + model list), scoped to a single gateway-id output.
export function ModelPicker({ value, onChange, placeholder = "anthropic/claude-sonnet-5" }: Props) {
  const manifest = useModelManifest();
  const btnRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [search, setSearch] = useState("");

  // Parse "provider/model" back to (provider, model). Fall back to Anthropic.
  const { activeProvider, activeModelId } = useMemo(() => {
    const slash = value.indexOf("/");
    if (slash > 0) {
      return { activeProvider: value.slice(0, slash), activeModelId: value.slice(slash + 1) };
    }
    return { activeProvider: "anthropic", activeModelId: value };
  }, [value]);

  const [pickerProvider, setPickerProvider] = useState(activeProvider);
  useEffect(() => { setPickerProvider(activeProvider); }, [activeProvider]);

  const providerMeta = CHAT_PROVIDERS.find(p => p.id === pickerProvider) ?? CHAT_PROVIDERS[0];
  const activeProviderMeta = CHAT_PROVIDERS.find(p => p.id === activeProvider) ?? CHAT_PROVIDERS[0];
  const activeModel = (manifest.providers[activeProvider] ?? []).find(m => m.id === activeModelId);

  const rawModels = manifest.providers[pickerProvider] ?? [];
  const filtered = search.trim()
    ? rawModels.filter(m => m.label.toLowerCase().includes(search.toLowerCase()) || m.id.toLowerCase().includes(search.toLowerCase()))
    : rawModels;

  function openPicker() {
    if (!btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    // Prefer below; flip above if it would clip the viewport bottom.
    const height = 300;
    const gap = 6;
    const below = r.bottom + gap;
    const top = below + height > window.innerHeight ? Math.max(8, r.top - height - gap) : below;
    setPos({ top, left: r.left });
    setOpen(true);
    setSearch("");
    setTimeout(() => searchRef.current?.focus(), 0);
  }

  function select(m: ChatModel) {
    onChange(`${pickerProvider}/${m.id}`);
    setOpen(false);
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="chat-bar-mode"
        onClick={(e) => { e.stopPropagation(); openPicker(); }}
      >
        <img
          src={CDN + activeProviderMeta.icon}
          alt={activeProviderMeta.label}
          width={14}
          height={14}
          className={activeProviderMeta.invert ? "chat-logo-invert" : ""}
          style={{ objectFit: "contain", flexShrink: 0 }}
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
        />
        {activeModel?.label ?? (value || placeholder)}
        <ChevronDown size={11} style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
      </button>

      {open && createPortal(
        <>
          <div className="chat-drop-overlay" onClick={() => setOpen(false)} />
          <div className="chat-picker" style={{ top: pos.top, left: pos.left }}>
            <div className="chat-picker-sidebar">
              {CHAT_PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  className={`chat-picker-prov${pickerProvider === p.id ? " chat-picker-prov--active" : ""}`}
                  onClick={() => { setPickerProvider(p.id); setSearch(""); searchRef.current?.focus(); }}
                  title={p.label}
                >
                  <img
                    src={CDN + p.icon}
                    alt={p.label}
                    width={16}
                    height={16}
                    className={p.invert ? "chat-logo-invert" : ""}
                    style={{ objectFit: "contain" }}
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                  />
                </button>
              ))}
            </div>
            <div className="chat-picker-panel">
              <div className="chat-picker-prov-name">{providerMeta.label}</div>
              <div className="chat-picker-search-wrap">
                <div className="chat-picker-search-box">
                  <Search size={11} className="chat-picker-search-ico" />
                  <input
                    ref={searchRef}
                    className="chat-picker-search-inp"
                    placeholder="Search models…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
              </div>
              <div className="chat-picker-list">
                {filtered.length === 0 ? (
                  <div className="chat-picker-empty">No models found</div>
                ) : filtered.map((m) => {
                  const isActive = activeProvider === pickerProvider && activeModelId === m.id;
                  return (
                    <button
                      key={m.id}
                      className={`chat-picker-item${isActive ? " chat-picker-item--active" : ""}`}
                      onClick={() => select(m)}
                    >
                      <div className="chat-picker-item-logo">
                        <img
                          src={CDN + providerMeta.icon}
                          alt={providerMeta.label}
                          width={18}
                          height={18}
                          className={providerMeta.invert ? "chat-logo-invert" : ""}
                          style={{ objectFit: "contain" }}
                          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                        />
                      </div>
                      <div className="chat-picker-item-text">
                        <span className="chat-picker-item-name">{m.label}</span>
                        <span className="chat-picker-item-desc">{pickerProvider}/{m.id}</span>
                      </div>
                      {isActive && <div className="chat-picker-item-dot" />}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
