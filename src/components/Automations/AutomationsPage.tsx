import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronLeft } from "lucide-react";
import { getOpenProjects } from "../../store/openProjects";
import { AutomationsList } from "./AutomationsList";
import { AutomationBuilder } from "./builder/AutomationBuilder";
import "./AutomationsPage.css";

interface Automation {
  id: string;
  name: string;
  graph: string;
  builtAt: string | null;
}

export function AutomationsPage() {
  const projects = getOpenProjects();
  // scope: null = Global (unbound automations), otherwise project id.
  const [scope, setScope] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState("");
  const [selected, setSelected] = useState<Automation | null>(null);

  useEffect(() => {
    if (!selectedId) { setSelected(null); return; }
    invoke<Automation>("get_automation", { id: selectedId })
      .then(setSelected)
      .catch(() => setSelected(null));
  }, [selectedId]);

  if (selectedId) {
    return (
      <div className="am-root">
        <div className="am-builder-topbar">
          <button className="am-back-btn" onClick={() => setSelectedId(null)}>
            <ChevronLeft size={14} />
            Automations
          </button>
          <span className="am-builder-sep">/</span>
          <span className="am-builder-name">{selectedName}</span>
        </div>
        {selected && (
          <AutomationBuilder
            automationId={selected.id}
            initialGraph={selected.graph}
            builtAt={selected.builtAt}
            onBuiltAtChange={v => setSelected(prev => prev ? { ...prev, builtAt: v } : prev)}
          />
        )}
      </div>
    );
  }

  return (
    <AutomationsList
      projects={projects}
      scope={scope}
      onSelectScope={setScope}
      onOpen={(id, name) => { setSelectedId(id); setSelectedName(name); }}
    />
  );
}
