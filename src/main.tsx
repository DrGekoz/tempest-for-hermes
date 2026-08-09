import ReactDOM from "react-dom/client";
import "./fonts.css";
import App from "./App";
import { ThemeProvider } from "./themes/ThemeContext";
import { loadAppState } from "./lib/runtimeState";
import { refreshAgentRegistry } from "./lib/agentRegistry";
import { loadSessions } from "./store/sessions";
import { loadProjects } from "./store/openProjects";
import { loadRecents } from "./store/recents";
import { loadTabs } from "./store/tabs";

// StrictMode intentionally removed — it double-invokes effects which causes
// PTY sessions to spawn twice on mount.
(async () => {
  document.addEventListener("contextmenu", (e) => e.preventDefault());
  // Hydrate every in-memory mirror from SQLite before the first render. All of
  // these are independent.
  await Promise.all([
    loadAppState(), loadSessions(), loadProjects(), loadRecents(), loadTabs(),
  ]);
  // AGENT_CONFIGS was built at module load with an empty runtime state; now
  // that customAgents is hydrated, rebuild so user-added entries appear.
  refreshAgentRegistry();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <ThemeProvider>
      <App />
    </ThemeProvider>,
  );
})();
