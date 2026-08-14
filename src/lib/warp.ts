import { invoke } from "@tauri-apps/api/core";
import type { ChatStreamEvent } from "./chat";
import { WARP_PROVIDER_ENV } from "./chatModels";
import { byokId, getSecret } from "./secrets";

// Experimental Warp (warpllm) chat backend. Non-streaming: one Tauri round-trip,
// then we emit the reply as a single token + finish so ChatNode renders it via
// the same event pipeline as Claude Code and BYOK. Cancel just drops the reply
// on arrival — warpllm has no in-flight abort yet.

export interface StreamWarpOptions {
  model: string;              // warpllm routing string, e.g. "openai/gpt-5-nano"
  messages: { role: "user" | "assistant"; content: string }[];
  system?: string;
  onEvent: (event: ChatStreamEvent) => void;
}

interface WarpChatResult {
  content: string;
  input_tokens: number;
  output_tokens: number;
}

function providerPrefix(modelId: string): string {
  return modelId.split("/")[0] ?? "";
}

async function pickApiKey(modelId: string): Promise<{ name?: string; key?: string }> {
  const envName = WARP_PROVIDER_ENV[providerPrefix(modelId)];
  if (!envName) return {};
  // Reuse the same BYOK slot the AI-SDK chat path uses for that provider (openai
  // for openrouter's underlying key too — user only has one; they can override
  // by exporting the env var before launching Tempest).
  const providerBykSlot = providerPrefix(modelId) === "openrouter" ? "openrouter" : providerPrefix(modelId);
  const key = await getSecret(byokId(providerBykSlot));
  return { name: envName, key };
}

export function streamWarp(options: StreamWarpOptions): { cancel: () => void } {
  const { model, messages, system, onEvent } = options;
  let cancelled = false;

  (async () => {
    try {
      const { name, key } = await pickApiKey(model);
      const res = await invoke<WarpChatResult>("warp_chat", {
        args: {
          model,
          messages,
          system: system ?? null,
          api_key_env: name ?? null,
          api_key: key ?? null,
        },
      });
      if (cancelled) return;
      if (res.content) onEvent({ type: "token", delta: res.content });
      onEvent({
        type: "finish",
        inputTokens: res.input_tokens ?? 0,
        outputTokens: res.output_tokens ?? 0,
      });
    } catch (err) {
      if (cancelled) return;
      onEvent({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  })();

  return { cancel: () => { cancelled = true; } };
}
