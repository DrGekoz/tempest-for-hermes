import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAgentAvailability } from "../store/agentAvailability";
import { Bot, TerminalSquare, MessageSquare, Globe, ChevronRight, Download } from "lucide-react";
import { useAgents, getAgent, getIconDataUrl, remoteIconUrl, type AgentConfig } from "../lib/agentRegistry";
import "./NewSessionMenu.css";

// The agent type and list live in the registry now (bundled ⊕ verified remote
// manifest). Re-exported here so existing importers keep working unchanged.
export { AGENT_CONFIGS } from "../lib/agentRegistry";
export type { AgentConfig } from "../lib/agentRegistry";

export function AgentIcon({ hint, size, className }: { hint?: string; size: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const config = getAgent(hint ?? "");
  // Prefer a cached (downloaded) icon, then a bundled asset, then the repo URL;
  // anything else — or a load error — falls back to the Bot glyph.
  const src = config && !failed
    ? (getIconDataUrl(config.id) ?? (config.iconSrc || remoteIconUrl(config.icon)))
    : undefined;
  if (!config || !src) return <Bot size={size} className={className} />;
  const monoClass = config.mono ? "agent-icon--mono" : undefined;
  const combinedClass = [className, monoClass].filter(Boolean).join(" ") || undefined;
  return (
    <img
      src={src}
      width={size}
      height={size}
      className={combinedClass}
      style={{ objectFit: "contain", display: "block", flexShrink: 0 }}
      alt={config.name}
      onError={() => setFailed(true)}
    />
  );
}

export type NewSessionPlacement = "right" | "below";

interface Props {
  open: boolean;
  anchorRect: DOMRect | null;
  placement?: NewSessionPlacement;
  onClose: () => void;
  onNewTerminal: () => void;
  onAgentSession: (agent: AgentConfig) => void;
  onChat?: () => void;
  onLivePreview?: () => void;
}

export function NewSessionMenu({
  open,
  anchorRect,
  placement = "below",
  onClose,
  onNewTerminal,
  onAgentSession,
  onChat,
  onLivePreview,
}: Props) {
  const [agentHovered, setAgentHovered] = useState(false);
  const [subRect, setSubRect] = useState<DOMRect | null>(null);
  const available = useAgentAvailability();
  const agents = useAgents();

  useEffect(() => {
    if (!open) { setAgentHovered(false); return; }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !anchorRect) return null;

  // Keep the menu inside the viewport: clamp horizontally, and anchor to the
  // anchor's opposite edge when there isn't room on the preferred side.
  const GAP = 8;
  const MENU_W = 248;
  const SUB_W = 228;
  const rawLeft = placement === "right" ? anchorRect.right + 4 : anchorRect.left;
  const left = Math.max(GAP, Math.min(rawLeft, window.innerWidth - MENU_W - GAP));
  const downTop = placement === "right" ? anchorRect.top : anchorRect.bottom + 2;
  const upBottom = placement === "right" ? anchorRect.bottom : anchorRect.top - 2;
  const spaceBelow = window.innerHeight - downTop - GAP;
  const spaceAbove = upBottom - GAP;
  const pos =
    spaceBelow < 220 && spaceAbove > spaceBelow
      ? { bottom: window.innerHeight - upBottom, left }
      : { top: downTop, left };

  // The agent list is long enough to run off-screen, so cap it to the space
  // available from where it opens and let it scroll. Flips up / to the left
  // when the other side has more room.
  const subTop = subRect ? subRect.top - 4 : 0;
  const subBelow = window.innerHeight - subTop - GAP;
  const subAbove = (subRect ? subRect.bottom + 4 : window.innerHeight) - GAP;
  const subUp = subBelow < 200 && subAbove > subBelow;
  const subLeft = left + MENU_W + 4 + SUB_W > window.innerWidth - GAP;
  const subStyle = {
    ...(subUp ? { top: "auto", bottom: -4, maxHeight: subAbove } : { maxHeight: subBelow }),
    ...(subLeft ? { left: "auto", right: "calc(100% + 4px)" } : {}),
  };

  return createPortal(
    <div className="nsm-overlay" onClick={onClose}>
      <div className="nsm" style={pos} onClick={(e) => e.stopPropagation()}>

        <button
          className="nsm-item"
          onClick={() => { onClose(); onNewTerminal(); }}
        >
          <TerminalSquare size={14} className="nsm-item-icon" />
          <div className="nsm-item-text">
            <span className="nsm-item-label">New Terminal</span>
            <span className="nsm-item-desc">Open a bare terminal in this workspace</span>
          </div>
        </button>

        <div
          className="nsm-item nsm-item--sub"
          onMouseEnter={(e) => { setSubRect(e.currentTarget.getBoundingClientRect()); setAgentHovered(true); }}
          onMouseLeave={() => setAgentHovered(false)}
        >
          <Bot size={14} className="nsm-item-icon" />
          <div className="nsm-item-text">
            <span className="nsm-item-label">Agent Session</span>
            <span className="nsm-item-desc">Run a CLI coding agent</span>
          </div>
          <ChevronRight size={12} className="nsm-item-chevron" />
          {agentHovered && (
            <div className="nsm-submenu" style={subStyle}>
              {agents.map((a) => {
                const isAvailable = available[a.hint] !== false; // true until confirmed absent
                return (
                  <div key={a.id} className={`nsm-subitem${isAvailable ? "" : " nsm-subitem--unavailable"}`}>
                    <button
                      className="nsm-subitem-main"
                      disabled={!isAvailable}
                      onClick={() => { if (isAvailable) { onClose(); onAgentSession(a); } }}
                    >
                      <AgentIcon hint={a.hint} size={14} className="nsm-subitem-icon" />
                      <span className="nsm-subitem-name">{a.name}</span>
                      <span className="nsm-subitem-hint">{a.hint}</span>
                    </button>
                    {!isAvailable && a.downloadUrl && (
                      <button
                        className="nsm-subitem-dl"
                        title="Download"
                        onClick={(e) => { e.stopPropagation(); openUrl(a.downloadUrl!).catch(() => {}); }}
                      >
                        <Download size={11} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <button
          className={`nsm-item${!onChat ? " nsm-item--disabled" : ""}`}
          disabled={!onChat}
          onClick={() => { onChat?.(); onClose(); }}
        >
          <MessageSquare size={14} className="nsm-item-icon" />
          <div className="nsm-item-text">
            <span className="nsm-item-label">Chat</span>
            <span className="nsm-item-desc">AI engineering companion</span>
          </div>
        </button>

        <button
          className={`nsm-item${!onLivePreview ? " nsm-item--disabled" : ""}`}
          disabled={!onLivePreview}
          onClick={() => onLivePreview?.()}
        >
          <Globe size={14} className="nsm-item-icon" />
          <div className="nsm-item-text">
            <span className="nsm-item-label">Live Preview</span>
            <span className="nsm-item-desc">Embedded browser for your dev server</span>
          </div>
        </button>

      </div>
    </div>,
    document.body
  );
}
