import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { applyRemoteAgents, getIconDataUrl, setIconDataUrl, remoteIconUrl } from "./agentRegistry";
import { sanitizeManifestAgents, versionGte, type RemotePatch } from "./agentManifest";
import { checkAgentAvailability } from "../store/agentAvailability";

// Remote agents channel — a SIGNED patch that lets a new CLI agent ship by
// editing `config/agents.json` and pushing, without an OTA release, as long as
// it fits the generic "cli" adapter (a command + structured flags). Unlike the
// models list this carries executable description, so the manifest is verified
// against an embedded minisign key (Rust `verify_minisign`) before it is applied;
// on any failure the app keeps its bundled agent list.
//
// A genuinely new execution model (novel session parsing, multi-step handshake)
// still needs a bundled adapter and therefore a release — the manifest can only
// reference the adapters the signed app already ships.

const BASE = "https://cdn.jsdelivr.net/gh/tempestai-dev/tempest@main/config/";
const MANIFEST_URL = BASE + "agents.json";
const SIGNATURE_URL = BASE + "agents.json.minisig";

/// Download any remote icons not already cached, storing each as a data URL so it
/// survives offline starts. Best-effort: a failed icon just falls back to Bot.
async function prefetchIcons(agents: RemotePatch[]): Promise<void> {
  await Promise.all(
    agents
      // Download repo-hosted icons only; bundled-asset keys resolve locally.
      .map((a) => ({ a, url: remoteIconUrl(a.icon) }))
      .filter(({ a, url }) => url && !getIconDataUrl(a.id))
      .map(async ({ a, url }) => {
        try {
          const res = await fetch(url!, { cache: "force-cache" });
          if (!res.ok) return;
          const blob = await res.blob();
          // Cap absurd payloads — icons are a few KB; anything large is wrong.
          if (blob.size > 512 * 1024) return;
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result as string);
            r.onerror = () => reject(r.error);
            r.readAsDataURL(blob);
          });
          setIconDataUrl(a.id, dataUrl);
        } catch {
          // Leave uncached; AgentIcon renders the Bot fallback.
        }
      }),
  );
}

/// Fetch, verify, and apply the remote agents manifest once at startup. Silent on
/// any failure — the bundled list already works and the user did not ask for it.
export async function startRemoteAgentsFetch(): Promise<void> {
  try {
    const [mRes, sRes] = await Promise.all([
      fetch(MANIFEST_URL, { cache: "no-cache" }),
      fetch(SIGNATURE_URL, { cache: "no-cache" }),
    ]);
    if (!mRes.ok || !sRes.ok) return;

    const manifestText = await mRes.text();
    const signatureText = await sRes.text();

    // The manifest is executable description, so nothing is trusted until the
    // signature verifies against the embedded key.
    const verified = await invoke<boolean>("verify_minisign", {
      data: manifestText,
      signature: signatureText,
    });
    if (!verified) {
      console.warn("[remoteAgents] signature check failed — keeping bundled agents");
      return;
    }

    const doc = JSON.parse(manifestText);
    if (!doc || typeof doc !== "object" || !Array.isArray(doc.agents)) return;

    const appVersion = await getVersion();
    const eligible = doc.agents.filter(
      (a: unknown) =>
        !a ||
        typeof (a as Record<string, unknown>).minAppVersion !== "string" ||
        versionGte(appVersion, (a as Record<string, unknown>).minAppVersion as string),
    );

    const agents = sanitizeManifestAgents(eligible);
    applyRemoteAgents(agents);
    checkAgentAvailability(); // probe PATH for any newly added agents
    void prefetchIcons(agents);
  } catch (e) {
    console.error("[remoteAgents] fetch failed:", e);
  }
}
