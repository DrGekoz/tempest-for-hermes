import { useSettings, updateSetting } from "../../store/appSettings";
import { setPreciseAgentStatus } from "../../store/agentHooks";
import { setTelemetryEnabled } from "../../lib/telemetry";

export function SecuritySection() {
  const s = useSettings();
  const togglePreciseStatus = () => {
    const next = !s.preciseAgentStatus;
    updateSetting("preciseAgentStatus", next);
    void setPreciseAgentStatus(next);
  };
  return (
    <div className="sp-section">
      <div className="sp-section-heading">Security</div>

      <div className="sp-rows">
        <div className="sp-toggle-row" onClick={() => updateSetting("autoApprove", !s.autoApprove)}>
          <div className="sp-toggle-text">
            <span className="sp-toggle-label">Auto-approve agent tool calls</span>
            <span className="sp-toggle-desc">
              Pass each agent's skip-permissions flag at spawn so it never stops to ask
              for confirmation. Supported agents: Claude Code, Gemini CLI, Codex CLI,
              Antigravity. Applies to sessions started after this is enabled.
            </span>
          </div>
          <button
            className={`sp-toggle${s.autoApprove ? " sp-toggle--on" : ""}`}
            onClick={(e) => { e.stopPropagation(); updateSetting("autoApprove", !s.autoApprove); }}
            role="switch"
            aria-checked={s.autoApprove}
          >
            <span className="sp-toggle-thumb" />
          </button>
        </div>

        <div className="sp-toggle-row" onClick={() => updateSetting("isolateAgents", !s.isolateAgents)}>
          <div className="sp-toggle-text">
            <span className="sp-toggle-label">Isolate agent sessions</span>
            <span className="sp-toggle-desc">
              Wrap every new agent in a Hephaestus sandbox. On Windows, each agent
              session runs inside a Job Object so its entire process tree is confined
              and killed cleanly when the session closes. Network isolation arrives
              with the Linux and macOS releases. Applies to sessions started after
              this is enabled.
            </span>
          </div>
          <button
            className={`sp-toggle${s.isolateAgents ? " sp-toggle--on" : ""}`}
            onClick={(e) => { e.stopPropagation(); updateSetting("isolateAgents", !s.isolateAgents); }}
            role="switch"
            aria-checked={s.isolateAgents}
          >
            <span className="sp-toggle-thumb" />
          </button>
        </div>

        <div className="sp-toggle-row" onClick={togglePreciseStatus}>
          <div className="sp-toggle-text">
            <span className="sp-toggle-label">Precise agent status (hooks)</span>
            <span className="sp-toggle-desc">
              Install a managed lifecycle hook into supported agents' own configs so
              working / waiting-for-you / done is driven by real events instead of
              scraping terminal output. Preserves your existing hooks. Off removes the
              managed hooks and falls back to the heuristic. Supported: Claude Code,
              Gemini, Cursor, Copilot, Antigravity, Codex, Hermes, Opencode.
            </span>
          </div>
          <button
            className={`sp-toggle${s.preciseAgentStatus ? " sp-toggle--on" : ""}`}
            onClick={(e) => { e.stopPropagation(); togglePreciseStatus(); }}
            role="switch"
            aria-checked={s.preciseAgentStatus}
          >
            <span className="sp-toggle-thumb" />
          </button>
        </div>

        <div className="sp-toggle-row" onClick={() => updateSetting("desktopNotifications", !s.desktopNotifications)}>
          <div className="sp-toggle-text">
            <span className="sp-toggle-label">Desktop notifications</span>
            <span className="sp-toggle-desc">
              Send an OS notification when an agent finishes or asks for permission
              while the Tempest window is unfocused. Suppressed while Tempest has focus.
            </span>
          </div>
          <button
            className={`sp-toggle${s.desktopNotifications ? " sp-toggle--on" : ""}`}
            onClick={(e) => { e.stopPropagation(); updateSetting("desktopNotifications", !s.desktopNotifications); }}
            role="switch"
            aria-checked={s.desktopNotifications}
          >
            <span className="sp-toggle-thumb" />
          </button>
        </div>

        <div className="sp-toggle-row" onClick={() => setTelemetryEnabled(!s.telemetryEnabled)}>
          <div className="sp-toggle-text">
            <span className="sp-toggle-label">Share anonymous usage data</span>
            <span className="sp-toggle-desc">
              Sends anonymous usage counts and error signals to help improve Tempest.
              No code, prompts, file contents, or repo names are ever collected. Off by
              default; nothing is loaded or sent until you turn this on.
            </span>
          </div>
          <button
            className={`sp-toggle${s.telemetryEnabled ? " sp-toggle--on" : ""}`}
            onClick={(e) => { e.stopPropagation(); setTelemetryEnabled(!s.telemetryEnabled); }}
            role="switch"
            aria-checked={s.telemetryEnabled}
          >
            <span className="sp-toggle-thumb" />
          </button>
        </div>
      </div>
    </div>
  );
}
