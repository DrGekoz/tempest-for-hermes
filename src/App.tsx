import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WorkspaceView } from "./components/WorkspaceView";
import Onboarding from "./components/onboarding/Onboarding";
import { getRuntimeState, setRuntimeState } from "./lib/runtimeState";
import { checkAgentAvailability } from "./store/agentAvailability";
import { startRemoteAgentsFetch } from "./lib/remoteAgents";
import "./App.css";

// Dev-only: set VITE_FORCE_ONBOARDING=true in .env.local to always land on onboarding. Prod builds ignore it (DEV-gated).
const FORCE_ONBOARDING =
  import.meta.env.DEV && import.meta.env.VITE_FORCE_ONBOARDING === "true";

export default function App() {
  const [zenProject, setZenProject] = useState<{ name: string; path: string } | null>(null);
  const [ready, setReady] = useState(false);
  const [onboardingDone, setOnboardingDone] = useState(
    () => !FORCE_ONBOARDING && getRuntimeState().onboardingComplete
  );

  useEffect(() => {
    checkAgentAvailability();
    void startRemoteAgentsFetch(); // verified remote agents manifest, else bundled
    const label = getCurrentWindow().label;
    if (label.startsWith("zen-")) {
      invoke<[string, string] | null>("get_zen_config", { label })
        .then((result) => {
          if (result) setZenProject({ path: result[0], name: result[1] });
          setReady(true);
        })
        .catch(() => setReady(true));
    } else {
      setReady(true);
    }
  }, []);

  function completeOnboarding() {
    setRuntimeState({ onboardingComplete: true });
    setOnboardingDone(true);
  }

  if (!ready) return null;

  // Zen windows skip onboarding entirely
  if (zenProject) return <WorkspaceView zen name={zenProject.name} path={zenProject.path} />;

  if (!onboardingDone) return <Onboarding onComplete={completeOnboarding} />;

  return <WorkspaceView />;
}
