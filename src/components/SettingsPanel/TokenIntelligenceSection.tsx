import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check } from "lucide-react";
import { useSettings, updateSetting } from "../../store/appSettings";
import { downloadAtlasModel } from "../../lib/atlasModel";
import gooseSrc from "../../assets/agent-icons/goose.svg";
import codexSrc from "../../assets/agent-icons/codex.svg";

type GlobalAgent = {
  id: "goose" | "codex";
  name: string;
  desc: string;
  icon: string;
  mono: boolean;
  checkCmd: string;
  writeCmd: string;
};

const GLOBAL_AGENTS: GlobalAgent[] = [
  {
    id: "goose",
    name: "Goose",
    desc: "Writes Atlas MCP to ~/.config/goose/profiles.yaml",
    icon: gooseSrc,
    mono: true,
    checkCmd: "check_goose_atlas_config",
    writeCmd: "write_goose_atlas_config",
  },
  {
    id: "codex",
    name: "Codex CLI",
    desc: "Writes Atlas MCP to ~/.codex/config.toml",
    icon: codexSrc,
    mono: true,
    checkCmd: "check_codex_atlas_config",
    writeCmd: "write_codex_atlas_config",
  },
];

function GlobalAgentRow({ agent, semantic }: { agent: GlobalAgent; semantic: boolean }) {
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    invoke<boolean>(agent.checkCmd).then(setConfigured).catch(() => {});
  }, [agent.checkCmd]);

  async function install() {
    setLoading(true);
    try {
      await invoke(agent.writeCmd, { semantic });
      setConfigured(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="sp-global-agent-row">
      <img
        src={agent.icon}
        className={`sp-global-agent-icon${agent.mono ? " agent-icon--mono" : ""}`}
        alt={agent.name}
      />
      <div className="sp-toggle-text">
        <span className="sp-toggle-label">{agent.name}</span>
        <span className="sp-toggle-desc">{agent.desc}</span>
      </div>
      {configured ? (
        <span className="sp-global-agent-configured">
          <Check size={12} />
          Configured
        </span>
      ) : (
        <button
          className="sp-global-agent-install"
          onClick={install}
          disabled={loading}
        >
          {loading ? "Writing…" : "Install"}
        </button>
      )}
    </div>
  );
}

// Semantic search toggle: enabling triggers the one-time model download with an
// inline progress bar; disabling is instant (the cached model stays on disk).
function SemanticToggle({ enabled }: { enabled: boolean }) {
  const [phase, setPhase] = useState<"idle" | "downloading" | "error">("idle");
  const [pct, setPct] = useState(0);

  async function toggle() {
    if (phase === "downloading") return;
    if (enabled) { updateSetting("atlasSemantic", false); return; }
    setPhase("downloading"); setPct(0);
    try {
      await downloadAtlasModel((p) => { if (typeof p.progress === "number") setPct(Math.round(p.progress)); });
      updateSetting("atlasSemantic", true);
      setPhase("idle");
    } catch {
      setPhase("error");
      updateSetting("atlasSemantic", false);
    }
  }

  return (
    <div className="sp-toggle-row sp-toggle-row--indent" onClick={toggle} style={{ flexDirection: "column", alignItems: "stretch", gap: "8px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <div className="sp-toggle-text">
          <span className="sp-toggle-label">Semantic code search</span>
          <span className="sp-toggle-desc">
            {phase === "error"
              ? "Download failed — click to retry."
              : "Downloads a ~25 MB model (once) for retrieval by meaning. Runs offline after."}
          </span>
        </div>
        <button
          className={`sp-toggle${enabled ? " sp-toggle--on" : ""}`}
          onClick={(e) => { e.stopPropagation(); toggle(); }}
          role="switch"
          aria-checked={enabled}
          disabled={phase === "downloading"}
        >
          <span className="sp-toggle-thumb" />
        </button>
      </div>
      {phase === "downloading" && (
        <div style={{ height: "4px", borderRadius: "2px", background: "var(--tempest-border-default)", overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${pct}%`, background: "var(--tempest-accent, #6366f1)", transition: "width 0.2s" }} />
        </div>
      )}
    </div>
  );
}

export function TokenIntelligenceSection() {
  const s = useSettings();
  return (
    <div className="sp-section">
      <div className="sp-section-heading">Token Intelligence</div>
      <p className="sp-section-desc">
        Atlas indexes your codebase locally and gives AI agents a pre-built semantic
        code graph — reducing repeated file reads and cutting token usage. No data
        leaves your machine.
      </p>

      <div className="sp-rows">
        <div className="sp-toggle-row" onClick={() => updateSetting("atlasEnabled", !s.atlasEnabled)}>
          <div className="sp-toggle-text">
            <span className="sp-toggle-label">Enable Token Intelligence</span>
            <span className="sp-toggle-desc">Off by default — entirely your choice.</span>
          </div>
          <button
            className={`sp-toggle${s.atlasEnabled ? " sp-toggle--on" : ""}`}
            onClick={(e) => { e.stopPropagation(); updateSetting("atlasEnabled", !s.atlasEnabled); }}
            role="switch"
            aria-checked={s.atlasEnabled}
          >
            <span className="sp-toggle-thumb" />
          </button>
        </div>

        {s.atlasEnabled && (
          <div className="sp-toggle-row sp-toggle-row--indent" onClick={() => updateSetting("atlasAutoIndex", !s.atlasAutoIndex)}>
            <div className="sp-toggle-text">
              <span className="sp-toggle-label">Auto-index new projects</span>
              <span className="sp-toggle-desc">Skip the prompt and index every project automatically.</span>
            </div>
            <button
              className={`sp-toggle${s.atlasAutoIndex ? " sp-toggle--on" : ""}`}
              onClick={(e) => { e.stopPropagation(); updateSetting("atlasAutoIndex", !s.atlasAutoIndex); }}
              role="switch"
              aria-checked={s.atlasAutoIndex}
            >
              <span className="sp-toggle-thumb" />
            </button>
          </div>
        )}

        {s.atlasEnabled && <SemanticToggle enabled={s.atlasSemantic} />}
      </div>

      {s.atlasEnabled && (
        <>
          <div className="sp-section-subheading">Global Agents</div>
          <p className="sp-section-desc">
            These agents read a global config file at startup. Install Atlas once and every project gets it automatically.
          </p>
          <div className="sp-rows">
            {GLOBAL_AGENTS.map((agent) => (
              <GlobalAgentRow key={agent.id} agent={agent} semantic={s.atlasSemantic} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
