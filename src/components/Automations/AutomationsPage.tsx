import { useState } from "react";
import { getOpenProjects } from "../../store/openProjects";
import { AutomationsList } from "./AutomationsList";
import { AutomationDetailPage } from "./AutomationDetailPage";
import type { Automation } from "../../store/automations";
import "./AutomationsPage.css";

export function AutomationsPage() {
  const projects = getOpenProjects();
  const [scope, setScope] = useState<string | null>(null);
  const [detail, setDetail] = useState<Automation | null>(null);

  if (detail) {
    return (
      <AutomationDetailPage
        automation={detail}
        onBack={() => setDetail(null)}
        onUpdate={(updated) => setDetail(updated)}
      />
    );
  }

  return (
    <AutomationsList
      projects={projects}
      scope={scope}
      onSelectScope={setScope}
      onOpen={(a) => setDetail(a)}
    />
  );
}
