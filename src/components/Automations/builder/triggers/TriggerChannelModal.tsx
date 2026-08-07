import type { TriggerChannelData, KV } from "../graph";
import { Plus, Trash2 } from "lucide-react";

// P8: one modal serves all six channel trigger kinds. The schema-per-kind
// mapping stays here so the Rust writer's schema is echoed 1:1 in the UI —
// two places, but each is tiny. If a kind grows an odd option (OAuth flow,
// per-channel signature schemes), split it into its own modal then.

type Kind =
  | "trigger-linear" | "trigger-discord" | "trigger-telegram"
  | "trigger-teams"  | "trigger-photon"  | "trigger-poll";

interface FieldDef {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;    // secret fields default to a `{{secrets.<slug>}}` chip
  suggestedSecret?: string;
}

const SCHEMAS: Record<Kind, FieldDef[]> = {
  "trigger-linear": [
    { key: "apiKey",         label: "Linear API key", secret: true, suggestedSecret: "LINEAR_API_KEY" },
    { key: "webhookSecret",  label: "Webhook secret (optional)", secret: true, suggestedSecret: "LINEAR_WEBHOOK_SECRET" },
  ],
  "trigger-discord": [
    { key: "botToken",  label: "Bot token", secret: true, suggestedSecret: "DISCORD_BOT_TOKEN" },
    { key: "publicKey", label: "Public key (verifies interactions)", placeholder: "hex string" },
  ],
  "trigger-telegram": [
    { key: "botToken", label: "Bot token", secret: true, suggestedSecret: "TELEGRAM_BOT_TOKEN" },
  ],
  "trigger-teams": [
    { key: "appId",       label: "App ID" },
    { key: "appPassword", label: "App password", secret: true, suggestedSecret: "TEAMS_APP_PASSWORD" },
  ],
  "trigger-photon": [
    { key: "apiKey", label: "Photon API key", secret: true, suggestedSecret: "PHOTON_API_KEY" },
  ],
  "trigger-poll": [
    { key: "url",             label: "Endpoint URL", placeholder: "https://api.example.com/status" },
    { key: "intervalMinutes", label: "Poll every (minutes)", placeholder: "15" },
    { key: "onlyOnChange",    label: "Only fire when response changed (true/false)", placeholder: "true" },
  ],
};

interface Props {
  kind: Kind;
  data: TriggerChannelData;
  onChange: (d: TriggerChannelData) => void;
}

export function TriggerChannelModal({ kind, data, onChange }: Props) {
  const schema = SCHEMAS[kind];
  const getField = (key: string): string =>
    data.fields.find(f => f.key === key)?.value ?? "";

  const setField = (key: string, value: string) => {
    const existing = data.fields.findIndex(f => f.key === key);
    let next: KV[];
    if (existing >= 0) {
      next = data.fields.map((f, i) => i === existing ? { ...f, value } : f);
    } else {
      next = [...data.fields, { key, value, enabled: true }];
    }
    onChange({ ...data, fields: next });
  };

  const addSecret = (slug: string) => {
    if (!slug) return;
    if (data.secrets.some(s => s.slug === slug)) return;
    onChange({ ...data, secrets: [...data.secrets, { slug, value: "" }] });
  };
  const setSecret = (i: number, patch: Partial<{ slug: string; value: string }>) => {
    const next = [...data.secrets]; next[i] = { ...next[i], ...patch };
    onChange({ ...data, secrets: next });
  };
  const rmSecret = (i: number) =>
    onChange({ ...data, secrets: data.secrets.filter((_, j) => j !== i) });

  return (
    <>
      <label className="am-field">
        <span>What should the agent do when this fires?</span>
        <textarea
          className="am-textarea"
          value={data.prompt}
          onChange={e => onChange({ ...data, prompt: e.target.value })}
          rows={3}
          placeholder="Read the incoming message and reply politely."
        />
      </label>
      <div className="am-req-section">
        <div className="am-req-section-head">Channel config</div>
        {schema.map(f => (
          <label key={f.key} className="am-field">
            <span>{f.label}</span>
            <div className="am-row am-row--tight">
              <input
                className="am-input am-mono am-field--grow"
                value={getField(f.key)}
                onChange={e => setField(f.key, e.target.value)}
                placeholder={
                  f.placeholder ??
                  (f.secret ? `{{secrets.${f.suggestedSecret ?? "SECRET_NAME"}}}` : "")
                }
              />
              {f.secret && f.suggestedSecret && (
                <button
                  type="button"
                  className="am-step-add-btn"
                  onClick={() => {
                    setField(f.key, `{{secrets.${f.suggestedSecret!}}}`);
                    addSecret(f.suggestedSecret!);
                  }}
                  title="Insert a secret reference and add it to the secret bag"
                >Use secret</button>
              )}
            </div>
          </label>
        ))}
      </div>
      <div className="am-req-section">
        <div className="am-req-section-head">Secrets (written to .env at build)</div>
        {data.secrets.length === 0 && (
          <div className="am-hint">No secrets yet. Click "Use secret" above to add one.</div>
        )}
        {data.secrets.map((s, i) => (
          <div key={i} className="am-row am-row--tight">
            <input
              className="am-input am-mono am-input--fit"
              value={s.slug}
              onChange={e => setSecret(i, { slug: e.target.value })}
              placeholder="SECRET_NAME"
            />
            <input
              className="am-input am-mono am-field--grow"
              type="password"
              value={s.value}
              onChange={e => setSecret(i, { value: e.target.value })}
              placeholder="paste value once"
            />
            <button type="button" className="am-step-del" onClick={() => rmSecret(i)}>
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        <button type="button" className="am-step-add-btn"
          onClick={() => addSecret(`SECRET_${data.secrets.length + 1}`)}>
          <Plus size={11} /> Add secret
        </button>
      </div>
    </>
  );
}
