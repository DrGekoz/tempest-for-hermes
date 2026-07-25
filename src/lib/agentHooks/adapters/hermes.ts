// Hermes hook adapter.
//
// Hermes loads Python plugins from ~/.hermes/plugins/<name>/ and enables them via
// a `plugins.enabled` list in ~/.hermes/config.yaml. We install a managed plugin
// (plugin.yaml manifest + __init__.py) that registers Hermes' lifecycle hooks and
// POSTs each to Tempest's server, then enable it in the YAML config. Mirrors
// Orca's Hermes service. pre_approval_request is a real "needs you" signal →
// coversWaiting = true.

import { parse, stringify } from "yaml";
import type { AdapterInstall, HookAdapter, HookPaths, HookState, JsonObject } from "../types";
import { joinNative } from "../paths.ts";

const PLUGIN_NAME = "tempest-status";
const MARKER = "Managed by Tempest. Do not edit; changes may be overwritten.";

const HERMES_EVENTS = [
  "on_session_start",
  "pre_llm_call",
  "post_llm_call",
  "pre_tool_call",
  "post_tool_call",
  "pre_approval_request",
  "post_approval_response",
  "on_session_end",
  "on_session_finalize",
  "on_session_reset",
] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strArr(v: unknown): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return null;
  return v as string[];
}

function pluginManifest(): string {
  return [
    `# ${MARKER}`,
    `name: ${PLUGIN_NAME}`,
    "version: 1.0.0",
    'description: "Reports Hermes lifecycle events to Tempest."',
    'author: "Tempest"',
    "kind: standalone",
    "provides_hooks:",
    ...HERMES_EVENTS.map((e) => `  - ${e}`),
    "",
  ].join("\n");
}

// The Python plugin: sources the endpoint file for the current port/token, reads
// the Tempest session id from env, and POSTs each lifecycle event (with its name)
// to /hook/hermes. Best-effort — any failure is swallowed so status can't break a turn.
function pluginInit(endpointEnv: string): string {
  return `# ${MARKER}
from __future__ import annotations
import json, os, urllib.error, urllib.request

EVENTS = ${JSON.stringify([...HERMES_EVENTS])}
ENDPOINT = ${JSON.stringify(endpointEnv)}
SELECTED = {
    "pre_llm_call": ("user_message", "model"),
    "post_llm_call": ("assistant_response", "model"),
    "pre_tool_call": ("tool_name", "args"),
    "post_tool_call": ("tool_name", "args"),
    "pre_approval_request": ("command", "description"),
    "post_approval_response": ("command", "choice"),
}
MAX_STR = 8192


def _cap(v):
    s = v if isinstance(v, str) else repr(v)
    return s if len(s) <= MAX_STR else s[:MAX_STR] + "...[truncated]"


def _coords():
    port = os.environ.get("TEMPEST_HOOK_PORT", "")
    token = os.environ.get("TEMPEST_HOOK_TOKEN", "")
    try:
        with open(ENDPOINT, "r", encoding="utf-8") as f:
            for raw in f:
                line = raw.strip()
                if line.startswith("set "):
                    line = line[4:]
                k, sep, val = line.partition("=")
                if sep and k == "TEMPEST_HOOK_PORT":
                    port = val.rstrip("\\r")
                elif sep and k == "TEMPEST_HOOK_TOKEN":
                    token = val.rstrip("\\r")
    except OSError:
        pass
    return port, token


def _post(payload):
    port, token = _coords()
    session = os.environ.get("TEMPEST_SESSION", "")
    if not port or not token or not session:
        return
    data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    req = urllib.request.Request(
        "http://127.0.0.1:" + port + "/hook/hermes",
        data=data, method="POST",
        headers={"Content-Type": "application/json",
                 "X-Tempest-Token": token, "X-Tempest-Session": session})
    try:
        with urllib.request.urlopen(req, timeout=0.75):
            pass
    except (OSError, urllib.error.URLError):
        return


def _payload(event_name, kwargs):
    p = {"hook_event_name": event_name}
    for key in SELECTED.get(event_name, ()):
        if key in kwargs:
            p[key] = _cap(kwargs[key])
    return p


def _make(event_name):
    def _hook(**kwargs):
        _post(_payload(event_name, kwargs))
    return _hook


def register(ctx):
    for event_name in EVENTS:
        ctx.register_hook(event_name, _make(event_name))
`;
}

export const hermesAdapter: HookAdapter = {
  id: "hermes",
  coversWaiting: true,

  plan(paths: HookPaths): AdapterInstall {
    const pluginDir = joinNative(paths.windows, paths.home, ".hermes", "plugins", PLUGIN_NAME);
    const configPath = joinNative(paths.windows, paths.home, ".hermes", "config.yaml");

    return {
      // The plugin files live under the Hermes home, not the shared hooks dir —
      // ScriptFile.path is an absolute path, so that's fine.
      scripts: [
        { path: joinNative(paths.windows, pluginDir, "plugin.yaml"), content: pluginManifest(), executable: false },
        { path: joinNative(paths.windows, pluginDir, "__init__.py"), content: pluginInit(paths.endpointEnv), executable: false },
      ],
      configs: [
        {
          path: configPath,
          apply: (raw) => enableInYaml(raw),
          remove: (raw) => disableInYaml(raw),
        },
      ],
    };
  },

  parse(body: unknown): HookState | null {
    if (!body || typeof body !== "object") return null;
    const event = (body as Record<string, unknown>).hook_event_name;
    if (event === "pre_approval_request") return "waiting";
    if (event === "post_llm_call" || event === "on_session_end" || event === "on_session_finalize" || event === "on_session_reset") {
      return "done";
    }
    if (
      event === "on_session_start" ||
      event === "pre_llm_call" ||
      event === "pre_tool_call" ||
      event === "post_tool_call" ||
      event === "post_approval_response"
    ) {
      return "working";
    }
    return null;
  },
};

function parseYaml(raw: string | null): JsonObject | null {
  if (raw === null || raw.trim() === "") return {};
  try {
    const p = parse(raw);
    if (p === null || p === undefined) return {};
    return isRecord(p) ? (p as JsonObject) : null;
  } catch {
    return null;
  }
}

function enableInYaml(raw: string | null): string | null {
  const config = parseYaml(raw);
  if (config === null) return null;
  const plugins = isRecord(config.plugins) ? { ...config.plugins } : {};
  const enabled = strArr(plugins.enabled) ?? [];
  plugins.enabled = Array.from(new Set([...enabled, PLUGIN_NAME])).sort();
  const disabled = strArr(plugins.disabled);
  plugins.disabled = disabled === null ? [] : disabled.filter((n) => n !== PLUGIN_NAME);
  return stringify({ ...config, plugins }, { lineWidth: 0 });
}

function disableInYaml(raw: string | null): string | null {
  if (raw === null || raw.trim() === "") return null;
  const config = parseYaml(raw);
  if (config === null || !isRecord(config.plugins)) return null;
  const enabled = strArr(config.plugins.enabled);
  if (enabled === null || !enabled.includes(PLUGIN_NAME)) return null;
  const plugins = { ...config.plugins, enabled: enabled.filter((n) => n !== PLUGIN_NAME) };
  return stringify({ ...config, plugins }, { lineWidth: 0 });
}
