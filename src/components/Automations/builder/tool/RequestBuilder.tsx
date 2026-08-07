import type {
  HttpRequest, HttpMethod, HttpAuth, HttpBody, ToolInputField,
} from "../graph";
import { KVRows } from "./KVRows";
import { ValueChipsInput } from "./ValueChipsInput";

interface Props {
  request: HttpRequest;
  onChange: (r: HttpRequest) => void;
  fields: ToolInputField[];
}

const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const AUTH_KINDS: { id: HttpAuth["kind"]; label: string }[] = [
  { id: "none", label: "None" },
  { id: "bearer", label: "Bearer token" },
  { id: "basic", label: "Basic (user/pass)" },
  { id: "apiKey", label: "API key" },
];
const BODY_KINDS: { id: HttpBody["kind"]; label: string }[] = [
  { id: "none", label: "None" },
  { id: "json", label: "JSON" },
  { id: "form", label: "Form" },
  { id: "raw", label: "Raw" },
];

export function RequestBuilder({ request, onChange, fields }: Props) {
  const set = <K extends keyof HttpRequest>(k: K, v: HttpRequest[K]) =>
    onChange({ ...request, [k]: v });

  const setAuth = (a: HttpAuth) => set("auth", a);
  const setBody = (b: HttpBody) => set("body", b);

  const switchAuth = (kind: HttpAuth["kind"]) => {
    if (kind === "none") setAuth({ kind: "none" });
    else if (kind === "bearer") setAuth({ kind: "bearer", token: "" });
    else if (kind === "basic") setAuth({ kind: "basic", user: "", pass: "" });
    else setAuth({ kind: "apiKey", in: "header", name: "", value: "" });
  };
  const switchBody = (kind: HttpBody["kind"]) => {
    if (kind === "none") setBody({ kind: "none" });
    else if (kind === "raw") setBody({ kind: "raw", contentType: "text/plain", text: "" });
    else setBody({ kind, fields: [] });
  };

  return (
    <div className="am-req">
      <div className="am-row">
        <label className="am-field am-field--fixed">
          <span>Method</span>
          <select
            className="am-input"
            value={request.method}
            onChange={e => set("method", e.target.value as HttpMethod)}
          >
            {METHODS.map(m => <option key={m}>{m}</option>)}
          </select>
        </label>
        <label className="am-field am-field--grow">
          <span>URL</span>
          <ValueChipsInput
            value={request.url}
            onChange={v => set("url", v)}
            fields={fields}
            placeholder="https://api.example.com/v1/things/{{input.id}}"
            mono
          />
        </label>
      </div>

      <div className="am-req-section">
        <div className="am-req-section-head">Query parameters</div>
        <KVRows
          rows={request.queryParams}
          onChange={rows => set("queryParams", rows)}
          fields={fields}
          keyPlaceholder="param"
          valuePlaceholder="value"
          addLabel="Add parameter"
        />
      </div>

      <div className="am-req-section">
        <div className="am-req-section-head">Headers</div>
        <KVRows
          rows={request.headers}
          onChange={rows => set("headers", rows)}
          fields={fields}
          keyPlaceholder="Header-Name"
          valuePlaceholder="value"
          addLabel="Add header"
        />
      </div>

      <div className="am-req-section">
        <div className="am-req-section-head">Auth</div>
        <select
          className="am-input"
          value={request.auth.kind}
          onChange={e => switchAuth(e.target.value as HttpAuth["kind"])}
        >
          {AUTH_KINDS.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
        {request.auth.kind === "bearer" && (
          <label className="am-field">
            <span>Token</span>
            <ValueChipsInput
              value={request.auth.token}
              onChange={v => setAuth({ kind: "bearer", token: v })}
              fields={fields}
              placeholder="{{input.apiKey}} or a literal"
              mono
            />
          </label>
        )}
        {request.auth.kind === "basic" && (
          <div className="am-row">
            <label className="am-field am-field--grow">
              <span>User</span>
              <ValueChipsInput
                value={request.auth.user}
                onChange={v => setAuth({ ...request.auth as { kind: "basic"; user: string; pass: string }, user: v })}
                fields={fields}
                mono
              />
            </label>
            <label className="am-field am-field--grow">
              <span>Password</span>
              <ValueChipsInput
                value={request.auth.pass}
                onChange={v => setAuth({ ...request.auth as { kind: "basic"; user: string; pass: string }, pass: v })}
                fields={fields}
                mono
              />
            </label>
          </div>
        )}
        {request.auth.kind === "apiKey" && (
          <>
            <div className="am-row">
              <label className="am-field am-field--fixed">
                <span>Send in</span>
                <select
                  className="am-input"
                  value={request.auth.in}
                  onChange={e => {
                    const a = request.auth as Extract<HttpAuth, { kind: "apiKey" }>;
                    setAuth({ ...a, in: e.target.value as "header" | "query" });
                  }}
                >
                  <option value="header">Header</option>
                  <option value="query">Query string</option>
                </select>
              </label>
              <label className="am-field am-field--grow">
                <span>Name</span>
                <input
                  className="am-input am-mono"
                  value={request.auth.name}
                  onChange={e => {
                    const a = request.auth as Extract<HttpAuth, { kind: "apiKey" }>;
                    setAuth({ ...a, name: e.target.value });
                  }}
                  placeholder="X-Api-Key or api_key"
                />
              </label>
            </div>
            <label className="am-field">
              <span>Value</span>
              <ValueChipsInput
                value={request.auth.value}
                onChange={v => {
                  const a = request.auth as Extract<HttpAuth, { kind: "apiKey" }>;
                  setAuth({ ...a, value: v });
                }}
                fields={fields}
                mono
              />
            </label>
          </>
        )}
      </div>

      <div className="am-req-section">
        <div className="am-req-section-head">Body</div>
        <select
          className="am-input"
          value={request.body.kind}
          onChange={e => switchBody(e.target.value as HttpBody["kind"])}
          disabled={request.method === "GET"}
          title={request.method === "GET" ? "GET requests carry no body" : ""}
        >
          {BODY_KINDS.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}
        </select>
        {request.method !== "GET" && request.body.kind === "json" && (
          <KVRows
            rows={request.body.fields}
            onChange={rows => setBody({ kind: "json", fields: rows })}
            fields={fields}
            keyPlaceholder="field"
            valuePlaceholder="value (chips allowed)"
            addLabel="Add JSON field"
          />
        )}
        {request.method !== "GET" && request.body.kind === "form" && (
          <KVRows
            rows={request.body.fields}
            onChange={rows => setBody({ kind: "form", fields: rows })}
            fields={fields}
            keyPlaceholder="field"
            valuePlaceholder="value"
            addLabel="Add form field"
          />
        )}
        {request.method !== "GET" && request.body.kind === "raw" && (
          <>
            <label className="am-field">
              <span>Content-Type</span>
              <input
                className="am-input am-mono"
                value={request.body.contentType}
                onChange={e => setBody({
                  kind: "raw",
                  contentType: e.target.value,
                  text: (request.body as Extract<HttpBody, { kind: "raw" }>).text,
                })}
                placeholder="application/xml"
              />
            </label>
            <label className="am-field">
              <span>Body text</span>
              <ValueChipsInput
                value={request.body.text}
                onChange={v => setBody({
                  kind: "raw",
                  contentType: (request.body as Extract<HttpBody, { kind: "raw" }>).contentType,
                  text: v,
                })}
                fields={fields}
                multiline
                rows={5}
                mono
              />
            </label>
          </>
        )}
      </div>
    </div>
  );
}
