import { invoke } from "@tauri-apps/api/core";

// BYOK API keys live in the OS credential manager via the `secrets::*` Tauri
// commands. Migrated off `localStorage` (CodeQL js/clear-text-storage-of-sensitive-data).

const LEGACY_PREFIX = "tempest-byok-key-";

export function byokId(providerId: string): string {
  return `byok/${providerId}`;
}

export async function getSecret(id: string): Promise<string> {
  const v = await invoke<string | null>("secret_get", { id });
  if (v != null) return v;
  // One-shot migration: promote any pre-existing localStorage key into the
  // keychain, then wipe the plaintext copy. Only runs until the legacy slot is
  // empty.
  const legacyKey = id.startsWith("byok/") ? LEGACY_PREFIX + id.slice(5) : null;
  if (legacyKey) {
    const legacy = localStorage.getItem(legacyKey);
    if (legacy) {
      await invoke("secret_set", { id, value: legacy });
      localStorage.removeItem(legacyKey);
      return legacy;
    }
  }
  return "";
}

export async function setSecret(id: string, value: string): Promise<void> {
  await invoke("secret_set", { id, value });
}

export async function deleteSecret(id: string): Promise<void> {
  await invoke("secret_delete", { id });
  const legacyKey = id.startsWith("byok/") ? LEGACY_PREFIX + id.slice(5) : null;
  if (legacyKey) localStorage.removeItem(legacyKey);
}
