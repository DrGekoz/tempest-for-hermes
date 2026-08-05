import { useState } from "react";
import { ReactFlow, Background, Controls, MiniMap } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ChevronLeft, Workflow } from "lucide-react";
import { getOpenProjects } from "../../store/openProjects";
import { useTheme } from "../../themes/ThemeContext";
import { AutomationsList } from "./AutomationsList";
import "./AutomationsPage.css";

export function AutomationsPage() {
  const projects = getOpenProjects();
  const [projectId, setProjectId] = useState<string | null>(projects[0]?.id ?? null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState("");
  const { theme } = useTheme();

  const project = projects.find(p => p.id === projectId) ?? projects[0] ?? null;

  if (!project) {
    return (
      <div className="am-root">
        <div className="am-no-projects">
          <Workflow size={28} className="am-no-projects-icon" />
          <p className="am-no-projects-text">Open a project to use Automations.</p>
        </div>
      </div>
    );
  }

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
        <div style={{ flex: 1, minHeight: 0 }}>
          <ReactFlow nodes={[]} edges={[]} proOptions={{ hideAttribution: true }} colorMode={theme.type}>
            <Background id="am-bg" bgColor="var(--tempest-bg-editor)" color="var(--tempest-border-subtle)" gap={28} size={2.5} />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>
      </div>
    );
  }

  return (
    <AutomationsList
      projects={projects}
      project={project}
      onSelectProject={setProjectId}
      onOpen={(id, name) => { setSelectedId(id); setSelectedName(name); }}
    />
  );
}
