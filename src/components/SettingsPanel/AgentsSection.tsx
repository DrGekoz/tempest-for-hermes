import { useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { useAgents } from "../../lib/agentRegistry";
import { getAgentConfig, setAgentConfig } from "../../lib/runtimeState";
import {
  parseArgs, argsToText, parseEnv, envToText,
} from "../../lib/agentConfig";

// Settings → Agents. Per-agent-type launch defaults, applied globally to every
// session of that type. See src/lib/agentConfig.ts for the model and precedence.
export function AgentsSection() {
  const agents = useAgents();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="sp-section">
      <div className="sp-section-heading">Agents</div>
      <p className="sp-section-desc">
        Defaults applied every time you launch an agent of this type, in every project.
        Flags are appended to the command, environment variables are injected into the
        session, and the working subdirectory is entered relative to the worktree.
        A project's <code>tempest.yml</code> overrides these per repository.
      </p>

      <div className="sp-agents-list">
        {agents.map((a) => (
          <AgentRow
            key={a.id}
            id={a.id}
            name={a.name}
            iconSrc={a.iconSrc}
            mono={a.mono}
            open={expandedId === a.id}
            onToggle={() => setExpandedId(expandedId === a.id ? null : a.id)}
          />
        ))}
      </div>
    </div>
  );
}

function AgentRow({
  id, name, iconSrc, mono, open, onToggle,
}: {
  id: string; name: string; iconSrc: string; mono?: boolean;
  open: boolean; onToggle: () => void;
}) {
  const cfg = getAgentConfig(id);
  const [argsText, setArgsText] = useState(() => argsToText(cfg.args));
  const [envText, setEnvText]   = useState(() => envToText(cfg.env));
  const [subdir, setSubdir]     = useState(() => cfg.subdir);
  const [envWarnings, setEnvWarnings] = useState<string[]>([]);

  // Coarse writes on blur, not per keystroke — the textareas are free text, so
  // committing on every character would churn the runtime blob to disk.
  function commit() {
    const { env, warnings } = parseEnv(envText);
    setEnvWarnings(warnings);
    setAgentConfig(id, { args: parseArgs(argsText), env, subdir: subdir.trim() });
  }

  const configured = cfg.args.length > 0 || Object.keys(cfg.env).length > 0 || !!cfg.subdir;

  return (
    <div className={`sp-agent-row${open ? " sp-agent-row--open" : ""}`}>
      <button className="sp-agent-head" onClick={onToggle}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {iconSrc && (
          <img
            src={iconSrc}
            alt=""
            width={16}
            height={16}
            className={mono ? "sp-agent-logo-invert" : ""}
            style={{ objectFit: "contain", flexShrink: 0 }}
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
          />
        )}
        <span className="sp-agent-name">{name}</span>
        {configured && !open && <span className="sp-agent-badge">configured</span>}
      </button>

      {open && (
        <div className="sp-agent-body">
          <label className="sp-agent-label">
            Flags <span className="sp-agent-hint">one per line</span>
          </label>
          <textarea
            className="sp-agent-textarea"
            rows={3}
            value={argsText}
            placeholder={"--verbose\n--permission-mode=plan"}
            spellCheck={false}
            onChange={(e) => setArgsText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.stopPropagation()}
          />

          <label className="sp-agent-label">
            Environment <span className="sp-agent-hint">KEY=VALUE per line</span>
          </label>
          <textarea
            className="sp-agent-textarea"
            rows={3}
            value={envText}
            placeholder={"ANTHROPIC_BASE_URL=https://gateway.corp.internal"}
            spellCheck={false}
            onChange={(e) => setEnvText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.stopPropagation()}
          />
          {envWarnings.map((w, i) => (
            <p key={i} className="sp-agent-warn">{w}</p>
          ))}

          <label className="sp-agent-label">
            Working subdirectory <span className="sp-agent-hint">relative to the worktree</span>
          </label>
          <input
            className="sp-agent-input"
            value={subdir}
            placeholder="packages/api"
            spellCheck={false}
            onChange={(e) => setSubdir(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
