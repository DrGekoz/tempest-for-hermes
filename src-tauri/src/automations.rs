//! Eve sidecar — lifecycle helpers for the Automations engine.
//! Phase 2: CRUD commands, project generation, build/start/stop lifecycle.

use std::path::PathBuf;
use serde::{Serialize, Deserialize};

/// Returns the Eve CLI entry script path.
/// Dev:     src-tauri/resources/eve/node_modules/.bin/eve
/// Release: <exe>/resources/eve/node_modules/.bin/eve
///
/// npm (v7+) creates the no-extension `eve` shim on all platforms alongside
/// `eve.cmd` / `eve.ps1`. Calling `node <path>` works because Node strips
/// the shebang line before parsing.
pub fn eve_bin(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = {
        #[cfg(debug_assertions)]
        {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join("eve")
        }
        #[cfg(not(debug_assertions))]
        {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            exe.parent()
                .ok_or("no exe dir")?
                .join("resources")
                .join("eve")
        }
    };
    Ok(base.join("node_modules").join(".bin").join("eve"))
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Automation {
    pub id: String,
    #[serde(rename = "workspaceId")]
    pub workspace_id: Option<String>,
    pub name: String,
    pub slug: String,
    pub path: String,
    pub graph: String,
    #[serde(rename = "sandboxMode")]
    pub sandbox_mode: String,
    pub enabled: bool,
    #[serde(rename = "builtAt")]
    pub built_at: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Serialize, Deserialize)]
pub struct ProcessInfo {
    pub port: u16,
    pub pid: u32,
}

/// Find a free port by binding a TcpListener on 0.0.0.0:0, reading the
/// assigned port, and dropping the listener.
fn find_free_port() -> Result<u16, String> {
    use std::net::TcpListener;
    let listener = TcpListener::bind("0.0.0.0:0")
        .map_err(|e| format!("Failed to bind port: {e}"))?;
    let port = listener.local_addr()
        .map_err(|e| format!("Failed to get port: {e}"))?
        .port();
    drop(listener);
    Ok(port)
}

/// Graph JSON schema — mirrors src/components/Automations/builder/graph.ts.
/// The visual builder is the source of truth; we deserialize and materialize
/// Eve project files. Untagged enum matches serde's `#[serde(tag = "kind")]`
/// pattern on the TS side (a `kind` discriminator + `data` payload).
mod graph {
    use serde::Deserialize;

    #[derive(Deserialize, Default)]
    #[serde(default)]
    pub struct Graph {
        pub nodes: Vec<Node>,
        #[allow(dead_code)]
        pub edges: Vec<Edge>,
    }

    #[derive(Deserialize)]
    pub struct Node {
        pub kind: String,
        pub data: serde_json::Value,
    }

    #[derive(Deserialize)]
    #[allow(dead_code)]
    pub struct Edge {
        pub source: String,
        pub target: String,
        pub kind: String,
    }
}

fn slugify(s: &str) -> String {
    let out: String = s
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let collapsed: String = out.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    if collapsed.is_empty() { "item".into() } else { collapsed }
}

fn field_str<'a>(v: &'a serde_json::Value, key: &str) -> &'a str {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("")
}

fn field_str_or<'a>(v: &'a serde_json::Value, key: &str, default: &'a str) -> &'a str {
    let s = field_str(v, key);
    if s.is_empty() { default } else { s }
}

fn sandbox_ts_for(mode: &str) -> &'static str {
    match mode {
        "docker" => r#"import { defineSandbox } from "eve/sandbox";
import { docker } from "eve/sandbox/docker";

export default defineSandbox({
  backend: docker(),
});
"#,
        "none" => r#"import { defineSandbox } from "eve/sandbox";
import { justbash } from "eve/sandbox/justbash";

export default defineSandbox({
  backend: justbash(),
});
"#,
        _ => {
            if cfg!(windows) {
                r#"import { defineSandbox } from "eve/sandbox";
import { docker } from "eve/sandbox/docker";

export default defineSandbox({
  backend: docker(),
});
"#
            } else {
                r#"import { defineSandbox } from "eve/sandbox";
import { microsandbox } from "eve/sandbox/microsandbox";

export default defineSandbox({
  backend: microsandbox(),
});
"#
            }
        }
    }
}

fn write_agent_ts(dir: &std::path::Path, data: &serde_json::Value) -> Result<(), String> {
    let model = field_str_or(data, "model", "anthropic/claude-sonnet-5");
    let reasoning = field_str(data, "reasoning");
    let max_in = data.get("maxInputTokens").and_then(|v| v.as_u64());
    let max_out = data.get("maxOutputTokens").and_then(|v| v.as_u64());

    let mut fields: Vec<String> = vec![format!("  model: {:?}", model)];
    if !reasoning.is_empty() {
        fields.push(format!("  reasoning: {:?}", reasoning));
    }
    if max_in.is_some() || max_out.is_some() {
        let mut limits = Vec::new();
        if let Some(v) = max_in { limits.push(format!("    maxInputTokensPerSession: {}", v)); }
        if let Some(v) = max_out { limits.push(format!("    maxOutputTokensPerSession: {}", v)); }
        fields.push(format!("  limits: {{\n{},\n  }}", limits.join(",\n")));
    }

    let ts = format!(
        "import {{ defineAgent }} from \"eve\";\n\nexport default defineAgent({{\n{},\n}});\n",
        fields.join(",\n")
    );
    std::fs::write(dir.join("agent.ts"), ts).map_err(|e| e.to_string())
}

// ── New tool shape (P1–P3): request builder → generated fetch() body ────────
// Mirrors src/components/Automations/builder/graph.ts. The visual builder is
// the only authoring surface; this writer compiles it to plain TS the agent
// runtime executes.

#[derive(Deserialize, Default, Clone)]
#[serde(default)]
pub struct KV {
    pub key: String,
    pub value: String,
    pub enabled: bool,
}

#[derive(Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HttpAuth {
    None,
    Bearer { token: String },
    Basic { user: String, pass: String },
    #[serde(rename_all = "camelCase")]
    ApiKey {
        #[serde(rename = "in")]
        in_: String,       // "header" | "query"
        name: String,
        value: String,
    },
}
impl Default for HttpAuth { fn default() -> Self { HttpAuth::None } }

#[derive(Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HttpBody {
    None,
    Json { fields: Vec<KV> },
    Form { fields: Vec<KV> },
    Raw { #[serde(rename = "contentType")] content_type: String, text: String },
}
impl Default for HttpBody { fn default() -> Self { HttpBody::None } }

#[derive(Deserialize, Default, Clone)]
#[serde(default)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    #[serde(rename = "queryParams")]
    pub query_params: Vec<KV>,
    pub headers: Vec<KV>,
    pub auth: HttpAuth,
    pub body: HttpBody,
}

#[derive(Deserialize, Default, Clone)]
#[serde(default)]
pub struct ToolInputField {
    pub name: String,
    #[serde(rename = "type")]
    pub type_: String,       // "string" | "number" | "boolean" | "enum"
    pub required: bool,
    #[serde(rename = "enumValues")]
    pub enum_values: Option<Vec<String>>,
    pub description: Option<String>,
}

#[derive(Deserialize, Default, Clone)]
#[serde(default)]
pub struct ToolInputSchema {
    pub fields: Vec<ToolInputField>,
}

#[derive(Deserialize, Default, Clone)]
#[serde(default)]
pub struct ResponseMap {
    pub kind: String,             // "raw" | "pick"
    pub pick: Option<String>,
}

fn zod_line(f: &ToolInputField) -> String {
    let base = match f.type_.as_str() {
        "number" => "z.number()".to_string(),
        "boolean" => "z.boolean()".to_string(),
        "enum" => {
            let vs = f.enum_values.clone().unwrap_or_default();
            if vs.is_empty() {
                "z.string()".to_string()
            } else {
                let inner: Vec<String> = vs.iter().map(|v| format!("{:?}", v)).collect();
                format!("z.enum([{}])", inner.join(", "))
            }
        }
        _ => "z.string()".to_string(),
    };
    let with_desc = match &f.description {
        Some(d) if !d.is_empty() => format!("{base}.describe({:?})", d),
        _ => base,
    };
    if f.required { with_desc } else { format!("{with_desc}.optional()") }
}

fn zod_schema(schema: &ToolInputSchema) -> String {
    if schema.fields.is_empty() {
        return "z.object({})".to_string();
    }
    let mut lines = Vec::with_capacity(schema.fields.len());
    for f in &schema.fields {
        // Non-identifier names get JSON-quoted so `2foo` etc. don't break the object literal.
        let key = if f.name.chars().next().map_or(false, |c| c.is_ascii_alphabetic() || c == '_')
            && f.name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            f.name.clone()
        } else {
            format!("{:?}", f.name)
        };
        lines.push(format!("    {}: {},", key, zod_line(f)));
    }
    format!("z.object({{\n{}\n  }})", lines.join("\n"))
}

// Emit a TS runtime helper that expands `{{input.<name>}}` inside a string
// against an `input` object. Shared by URL, headers, param values, body fields.
const CHIP_HELPER: &str = r#"const __sub = (s, input) =>
      typeof s === "string"
        ? s.replace(/\{\{\s*input\.([A-Za-z0-9_]+)\s*\}\}/g, (_, k) => String(input?.[k] ?? ""))
        : s;"#;

// Emit a TS helper that navigates a JSONPath-ish string ("data.items[0].name").
const PICK_HELPER: &str = r#"const __pick = (obj, path) => {
      if (!path) return obj;
      const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
      let cur = obj;
      for (const p of parts) {
        if (cur == null) return undefined;
        cur = cur[p];
      }
      return cur;
    };"#;

fn json_body_ts(rows: &[KV]) -> String {
    let mut out = String::from("{\n");
    for r in rows.iter().filter(|r| r.enabled && !r.key.is_empty()) {
        // Values are always chip-substituted strings; the model can put JSON-literal
        // scalars in via chips too (e.g. `{{input.count}}` → coerced by JSON.stringify).
        out.push_str(&format!("      {:?}: __sub({:?}, input),\n", r.key, r.value));
    }
    out.push_str("    }");
    out
}

fn write_tool(dir: &std::path::Path, data: &serde_json::Value) -> Result<(), String> {
    let name = slugify(field_str_or(data, "name", "tool"));
    let description = field_str_or(data, "description", "A tool.");

    let request: HttpRequest = data.get("request")
        .cloned()
        .map(|v| serde_json::from_value(v).unwrap_or_default())
        .unwrap_or_default();
    let input: ToolInputSchema = data.get("input")
        .cloned()
        .map(|v| serde_json::from_value(v).unwrap_or_default())
        .unwrap_or_default();
    let response: ResponseMap = data.get("response")
        .cloned()
        .map(|v| serde_json::from_value(v).unwrap_or_default())
        .unwrap_or_default();

    let method = if request.method.is_empty() { "GET".to_string() } else { request.method.clone() };
    let url_lit = format!("{:?}", request.url);
    let schema = zod_schema(&input);

    // Auth: append to headers or query as needed, using the same chip substitution.
    let (auth_header_pairs, auth_query_pairs): (Vec<(String, String)>, Vec<(String, String)>) = match &request.auth {
        HttpAuth::None => (vec![], vec![]),
        HttpAuth::Bearer { token } => (vec![("Authorization".into(), format!("Bearer {}", token))], vec![]),
        HttpAuth::Basic { user, pass } => {
            // Basic auth needs runtime encoding — emit as a header-computing snippet
            // rather than raw base64 at compile time (chips inside user/pass work).
            (vec![("Authorization".into(), format!("__basic:{}:{}", user, pass))], vec![])
        }
        HttpAuth::ApiKey { in_, name, value } => {
            if in_ == "query" { (vec![], vec![(name.clone(), value.clone())]) }
            else { (vec![(name.clone(), value.clone())], vec![]) }
        }
    };

    // Combined header rows: user-declared + auth-injected.
    let mut header_rows: Vec<KV> = request.headers.iter()
        .filter(|r| r.enabled && !r.key.is_empty())
        .cloned()
        .collect();
    for (k, v) in &auth_header_pairs {
        // Basic auth marker → runtime btoa; other headers substituted normally.
        header_rows.push(KV { key: k.clone(), value: v.clone(), enabled: true });
    }
    let mut query_rows: Vec<KV> = request.query_params.iter()
        .filter(|r| r.enabled && !r.key.is_empty())
        .cloned()
        .collect();
    for (k, v) in &auth_query_pairs {
        query_rows.push(KV { key: k.clone(), value: v.clone(), enabled: true });
    }

    let headers_ts = if header_rows.is_empty() {
        "{}".to_string()
    } else {
        let mut s = String::from("{\n");
        for r in &header_rows {
            if r.value.starts_with("__basic:") {
                // Runtime btoa so chips inside user/pass still work.
                let rest = &r.value["__basic:".len()..];
                let split = rest.find(':').unwrap_or(rest.len());
                let user = &rest[..split];
                let pass = if split < rest.len() { &rest[split+1..] } else { "" };
                s.push_str(&format!(
                    "      {:?}: \"Basic \" + btoa(__sub({:?}, input) + \":\" + __sub({:?}, input)),\n",
                    r.key, user, pass
                ));
            } else {
                s.push_str(&format!("      {:?}: __sub({:?}, input),\n", r.key, r.value));
            }
        }
        s.push_str("    }");
        s
    };

    let query_ts = if query_rows.is_empty() {
        String::new()
    } else {
        let mut s = String::from("    const __qs = new URLSearchParams();\n");
        for r in &query_rows {
            s.push_str(&format!("    __qs.append({:?}, __sub({:?}, input));\n", r.key, r.value));
        }
        s
    };

    // Body serialization by kind.
    let (body_prep, body_expr, content_type_header): (String, String, Option<String>) = match &request.body {
        HttpBody::None => (String::new(), "undefined".into(), None),
        HttpBody::Json { fields } => {
            let obj = json_body_ts(fields);
            let prep = format!("    const __body = JSON.stringify({});\n", obj);
            (prep, "__body".into(), Some("application/json".into()))
        }
        HttpBody::Form { fields } => {
            let mut s = String::from("    const __form = new URLSearchParams();\n");
            for r in fields.iter().filter(|r| r.enabled && !r.key.is_empty()) {
                s.push_str(&format!("    __form.append({:?}, __sub({:?}, input));\n", r.key, r.value));
            }
            (s, "__form.toString()".into(), Some("application/x-www-form-urlencoded".into()))
        }
        HttpBody::Raw { content_type, text } => {
            let prep = format!("    const __body = __sub({:?}, input);\n", text);
            (prep, "__body".into(), Some(content_type.clone()))
        }
    };

    // Response return: raw text (try JSON parse) or picked field.
    let return_ts = if response.kind == "pick" {
        let path = response.pick.clone().unwrap_or_default();
        format!(
            r#"    const __text = await res.text();
    let __data;
    try {{ __data = JSON.parse(__text); }} catch {{ __data = __text; }}
    return __pick(__data, {:?});"#,
            path
        )
    } else {
        r#"    const __text = await res.text();
    try { return JSON.parse(__text); } catch { return __text; }"#.to_string()
    };

    // Only inject the content-type when the user didn't already set one.
    let ct_line = match content_type_header {
        Some(ct) => format!("    if (!__headers[\"Content-Type\"] && !__headers[\"content-type\"]) __headers[\"Content-Type\"] = {:?};\n", ct),
        None => String::new(),
    };
    let final_url = if query_rows.is_empty() {
        "__url".into()
    } else {
        "__url + (__url.includes(\"?\") ? \"&\" : \"?\") + __qs.toString()".to_string()
    };
    let body_bearing = matches!(method.as_str(), "POST" | "PUT" | "PATCH" | "DELETE");

    let ts = format!(
        r#"import {{ defineTool }} from "eve/tools";
import {{ z }} from "zod";

// Auto-generated from the visual builder. Do not edit by hand — your changes
// will be overwritten on the next build.

export default defineTool({{
  description: {desc:?},
  inputSchema: {schema},
  async execute(input) {{
    {chip_helper}
    {pick_helper}
    const __url = __sub({url_lit}, input);
    const __headers = {headers_ts};
{query_ts}{ct_line}{body_prep}    const res = await fetch({final_url}, {{
      method: {method_lit},
      headers: __headers,
      body: {body_bearing_ts},
    }});
{return_ts}
  }},
}});
"#,
        desc = description,
        schema = schema,
        chip_helper = CHIP_HELPER,
        pick_helper = if response.kind == "pick" { PICK_HELPER } else { "" },
        url_lit = url_lit,
        headers_ts = headers_ts,
        query_ts = query_ts,
        ct_line = ct_line,
        body_prep = body_prep,
        final_url = final_url,
        method_lit = format!("{:?}", method),
        body_bearing_ts = if body_bearing { body_expr.as_str() } else { "undefined" },
        return_ts = return_ts,
    );
    std::fs::write(dir.join(format!("{name}.ts")), ts).map_err(|e| e.to_string())
}


// ── P6/P7: flow compiler ────────────────────────────────────────────────────
// A `flow` node compiles to `agent/tools/<name>.ts` whose `execute()` body is
// the linear step-tree rendered as async TS. Every step reads/writes the same
// `__scope` object, which starts as `{ ...input }` and accumulates set-vars,
// call-results (via assignTo), and loop iteration variables. Chip resolution
// reuses the same `__sub` helper the plain-tool writer emits.
//
// Kept as strings-of-TS rather than a proper AST — the compiler is one file,
// and the generated code is disposable. If the grammar ever grows past what
// concatenation supports (nested closures, hygiene issues), promote to a real
// AST then. ponytail: string-concat compiler, upgrade to AST if grammar grows.

#[derive(Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FlowStep {
    #[serde(rename_all = "camelCase")]
    Call {
        #[allow(dead_code)] id: String,
        assign_to: String,
        request: HttpRequest,
    },
    #[serde(rename_all = "camelCase")]
    If {
        #[allow(dead_code)] id: String,
        condition: Condition,
        then: Vec<FlowStep>,
        #[serde(rename = "else")] else_: Vec<FlowStep>,
    },
    #[serde(rename_all = "camelCase")]
    Switch {
        #[allow(dead_code)] id: String,
        cases: Vec<SwitchCase>,
        default: Vec<FlowStep>,
    },
    #[serde(rename_all = "camelCase")]
    Set { #[allow(dead_code)] id: String, vars: Vec<SetVar> },
    #[serde(rename_all = "camelCase")]
    Return { #[allow(dead_code)] id: String, value: String },
    #[serde(rename_all = "camelCase")]
    Loop {
        #[allow(dead_code)] id: String,
        shape: String,               // "for-each" | "while"
        list_chip: String,
        item_var: String,
        condition: Condition,
        body: Vec<FlowStep>,
    },
    #[serde(rename_all = "camelCase")]
    Parallel {
        #[allow(dead_code)] id: String,
        mode: String,                 // "all" | "race"
        branches: Vec<Vec<FlowStep>>,
    },
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Condition {
    pub left: String,
    pub op: String,
    pub right: String,
}

#[derive(Deserialize, Clone)]
pub struct SetVar { pub name: String, pub value: String }

#[derive(Deserialize, Clone)]
pub struct SwitchCase {
    #[allow(dead_code)]
    pub label: String,
    pub condition: Condition,
    pub steps: Vec<FlowStep>,
}

fn ts_str_expr(s: &str) -> String {
    // Wrap the (chip-containing) string so runtime __sub resolves it.
    format!("__sub({:?}, __scope)", s)
}

fn compile_condition(c: &Condition) -> String {
    let l = ts_str_expr(&c.left);
    let r = ts_str_expr(&c.right);
    // Numeric ops coerce via Number(); the string ops stay as-is.
    match c.op.as_str() {
        "equals"        => format!("({l} === {r})"),
        "not-equals"    => format!("({l} !== {r})"),
        "contains"      => format!("({l}).includes({r})"),
        "not-contains"  => format!("!({l}).includes({r})"),
        "gt"            => format!("(Number({l}) > Number({r}))"),
        "gte"           => format!("(Number({l}) >= Number({r}))"),
        "lt"            => format!("(Number({l}) < Number({r}))"),
        "lte"           => format!("(Number({l}) <= Number({r}))"),
        "is-empty"      => format!("(({l}) == null || ({l}) === \"\")"),
        "is-not-empty"  => format!("!(({l}) == null || ({l}) === \"\")"),
        "matches"       => format!("new RegExp({r}).test({l})"),
        _               => "false".into(),
    }
}

fn compile_call(c: &HttpRequest, assign_to: &str, indent: &str) -> String {
    // Reuses the exact same runtime shape as write_tool — we hand-inline it
    // because the flow compiler doesn't invoke defineTool for each step.
    let mut out = String::new();
    let method = if c.method.is_empty() { "GET".to_string() } else { c.method.clone() };
    let body_bearing = matches!(method.as_str(), "POST" | "PUT" | "PATCH" | "DELETE");

    out.push_str(&format!("{indent}{{\n"));
    out.push_str(&format!("{indent}  const __url = __sub({:?}, __scope);\n", c.url));

    // Headers (with auth folded in)
    out.push_str(&format!("{indent}  const __headers = {{}};\n"));
    for h in c.headers.iter().filter(|h| h.enabled && !h.key.is_empty()) {
        out.push_str(&format!(
            "{indent}  __headers[{:?}] = __sub({:?}, __scope);\n",
            h.key, h.value
        ));
    }
    match &c.auth {
        HttpAuth::None => {}
        HttpAuth::Bearer { token } => {
            out.push_str(&format!(
                "{indent}  __headers[\"Authorization\"] = \"Bearer \" + __sub({:?}, __scope);\n",
                token
            ));
        }
        HttpAuth::Basic { user, pass } => {
            out.push_str(&format!(
                "{indent}  __headers[\"Authorization\"] = \"Basic \" + btoa(__sub({:?}, __scope) + \":\" + __sub({:?}, __scope));\n",
                user, pass
            ));
        }
        HttpAuth::ApiKey { in_, name, value } if in_ == "header" => {
            out.push_str(&format!(
                "{indent}  __headers[{:?}] = __sub({:?}, __scope);\n",
                name, value
            ));
        }
        _ => {}
    }

    // Query
    let mut has_qs = !c.query_params.iter().all(|q| q.key.is_empty() || !q.enabled);
    if let HttpAuth::ApiKey { in_, .. } = &c.auth { if in_ == "query" { has_qs = true; } }
    if has_qs {
        out.push_str(&format!("{indent}  const __qs = new URLSearchParams();\n"));
        for q in c.query_params.iter().filter(|q| q.enabled && !q.key.is_empty()) {
            out.push_str(&format!(
                "{indent}  __qs.append({:?}, __sub({:?}, __scope));\n",
                q.key, q.value
            ));
        }
        if let HttpAuth::ApiKey { in_, name, value } = &c.auth {
            if in_ == "query" {
                out.push_str(&format!(
                    "{indent}  __qs.append({:?}, __sub({:?}, __scope));\n",
                    name, value
                ));
            }
        }
    }

    // Body
    match &c.body {
        HttpBody::None => {}
        HttpBody::Json { fields } => {
            out.push_str(&format!("{indent}  const __body_obj = {{}};\n"));
            for f in fields.iter().filter(|f| f.enabled && !f.key.is_empty()) {
                out.push_str(&format!(
                    "{indent}  __body_obj[{:?}] = __sub({:?}, __scope);\n",
                    f.key, f.value
                ));
            }
            out.push_str(&format!("{indent}  const __body = JSON.stringify(__body_obj);\n"));
            out.push_str(&format!("{indent}  if (!__headers[\"Content-Type\"]) __headers[\"Content-Type\"] = \"application/json\";\n"));
        }
        HttpBody::Form { fields } => {
            out.push_str(&format!("{indent}  const __form = new URLSearchParams();\n"));
            for f in fields.iter().filter(|f| f.enabled && !f.key.is_empty()) {
                out.push_str(&format!(
                    "{indent}  __form.append({:?}, __sub({:?}, __scope));\n",
                    f.key, f.value
                ));
            }
            out.push_str(&format!("{indent}  const __body = __form.toString();\n"));
            out.push_str(&format!("{indent}  if (!__headers[\"Content-Type\"]) __headers[\"Content-Type\"] = \"application/x-www-form-urlencoded\";\n"));
        }
        HttpBody::Raw { content_type, text } => {
            out.push_str(&format!("{indent}  const __body = __sub({:?}, __scope);\n", text));
            out.push_str(&format!(
                "{indent}  if (!__headers[\"Content-Type\"]) __headers[\"Content-Type\"] = {:?};\n",
                content_type
            ));
        }
    }

    let final_url = if has_qs {
        "__url + (__url.includes(\"?\") ? \"&\" : \"?\") + __qs.toString()".to_string()
    } else {
        "__url".to_string()
    };
    let body_expr = match (&c.body, body_bearing) {
        (HttpBody::None, _) | (_, false) => "undefined".to_string(),
        _ => "__body".to_string(),
    };

    out.push_str(&format!(
        "{indent}  const __res = await fetch({}, {{ method: {:?}, headers: __headers, body: {} }});\n",
        final_url, method, body_expr
    ));
    out.push_str(&format!("{indent}  const __text = await __res.text();\n"));
    out.push_str(&format!(
        "{indent}  let __data; try {{ __data = JSON.parse(__text); }} catch {{ __data = __text; }}\n"
    ));
    if !assign_to.is_empty() {
        out.push_str(&format!("{indent}  __scope[{:?}] = __data;\n", assign_to));
    }
    out.push_str(&format!("{indent}}}\n"));
    out
}

fn compile_step(step: &FlowStep, indent: &str) -> String {
    let inner = format!("{indent}  ");
    match step {
        FlowStep::Call { assign_to, request, .. } => compile_call(request, assign_to, indent),
        FlowStep::If { condition, then, else_, .. } => {
            let mut out = format!("{indent}if ({}) {{\n", compile_condition(condition));
            for s in then { out.push_str(&compile_step(s, &inner)); }
            out.push_str(&format!("{indent}}}"));
            if !else_.is_empty() {
                out.push_str(" else {\n");
                for s in else_ { out.push_str(&compile_step(s, &inner)); }
                out.push_str(&format!("{indent}}}"));
            }
            out.push('\n');
            out
        }
        FlowStep::Switch { cases, default, .. } => {
            // Chained if/else if/else in declared order.
            let mut out = String::new();
            let mut first = true;
            for c in cases {
                let head = if first { "if" } else { "else if" };
                out.push_str(&format!("{indent}{head} ({}) {{\n", compile_condition(&c.condition)));
                for s in &c.steps { out.push_str(&compile_step(s, &inner)); }
                out.push_str(&format!("{indent}}}"));
                first = false;
            }
            if !default.is_empty() {
                if !first { out.push_str(" else {\n"); }
                else { out.push_str(&format!("{indent}{{\n")); }
                for s in default { out.push_str(&compile_step(s, &inner)); }
                out.push_str(&format!("{indent}}}"));
            }
            out.push('\n');
            out
        }
        FlowStep::Set { vars, .. } => {
            let mut out = String::new();
            for v in vars {
                out.push_str(&format!(
                    "{indent}__scope[{:?}] = __sub({:?}, __scope);\n",
                    v.name, v.value
                ));
            }
            out
        }
        FlowStep::Return { value, .. } => {
            format!("{indent}return __sub({:?}, __scope);\n", value)
        }
        FlowStep::Loop { shape, list_chip, item_var, condition, body, .. } => {
            let mut out = String::new();
            if shape == "for-each" {
                // Chip may resolve to a JSON string; try JSON.parse then fall back
                // to a comma-split for the naive case.
                out.push_str(&format!(
                    "{indent}{{\n{indent}  const __raw = __sub({:?}, __scope);\n",
                    list_chip
                ));
                out.push_str(&format!("{indent}  let __arr;\n"));
                out.push_str(&format!(
                    "{indent}  try {{ __arr = typeof __raw === \"string\" ? JSON.parse(__raw) : __raw; }} catch {{ __arr = String(__raw).split(\",\"); }}\n"
                ));
                out.push_str(&format!(
                    "{indent}  for (const __item of (Array.isArray(__arr) ? __arr : [])) {{\n"
                ));
                out.push_str(&format!("{indent}    __scope[{:?}] = __item;\n", item_var));
                for s in body { out.push_str(&compile_step(s, &format!("{indent}    "))); }
                out.push_str(&format!("{indent}  }}\n{indent}}}\n"));
            } else {
                // while
                out.push_str(&format!("{indent}while ({}) {{\n", compile_condition(condition)));
                for s in body { out.push_str(&compile_step(s, &inner)); }
                out.push_str(&format!("{indent}}}\n"));
            }
            out
        }
        FlowStep::Parallel { mode, branches, .. } => {
            // Each branch becomes an async IIFE against a scope clone; results are
            // collected and (for `all`) merged back into scope keys `branchN`.
            let joiner = if mode == "race" { "Promise.race" } else { "Promise.all" };
            let mut out = format!("{indent}{{\n{indent}  const __branches = [\n");
            for b in branches {
                out.push_str(&format!("{indent}    (async () => {{\n"));
                out.push_str(&format!("{indent}      const __scope_branch = {{ ...__scope }};\n"));
                // Redirect nested steps to write to the branch scope by swapping identifiers.
                // Simpler: re-emit as literal `__scope` and rely on outer var — but we want
                // isolation, so shadow the name with a `const __scope = __scope_branch`.
                out.push_str(&format!("{indent}      const __scope = __scope_branch;\n"));
                for s in b { out.push_str(&compile_step(s, &format!("{indent}      "))); }
                out.push_str(&format!("{indent}      return __scope;\n"));
                out.push_str(&format!("{indent}    }})(),\n"));
            }
            out.push_str(&format!("{indent}  ];\n"));
            out.push_str(&format!("{indent}  const __out = await {joiner}(__branches);\n"));
            // Merge each branch's scope into the parent as `branchN`.
            if mode != "race" {
                out.push_str(&format!("{indent}  __out.forEach((s, i) => {{ __scope[\"branch\" + i] = s; }});\n"));
            } else {
                out.push_str(&format!("{indent}  __scope[\"raceWinner\"] = __out;\n"));
            }
            out.push_str(&format!("{indent}}}\n"));
            out
        }
    }
}

fn write_flow(dir: &std::path::Path, data: &serde_json::Value) -> Result<(), String> {
    let name = slugify(field_str_or(data, "name", "flow"));
    let description = field_str_or(data, "description", "A visual flow.");
    let input: ToolInputSchema = data.get("input")
        .cloned()
        .map(|v| serde_json::from_value(v).unwrap_or_default())
        .unwrap_or_default();
    let steps: Vec<FlowStep> = data.get("steps")
        .cloned()
        .map(|v| serde_json::from_value(v).unwrap_or_default())
        .unwrap_or_default();

    let schema = zod_schema(&input);

    let mut body = String::new();
    for s in &steps { body.push_str(&compile_step(s, "    ")); }

    let ts = format!(
        r#"import {{ defineTool }} from "eve/tools";
import {{ z }} from "zod";

// Auto-generated from the visual flow builder. Do not edit by hand — your
// changes will be overwritten on the next build.

export default defineTool({{
  description: {desc:?},
  inputSchema: {schema},
  async execute(input) {{
    {chip_helper}
    const __scope = {{ ...input }};
{body}
  }},
}});
"#,
        desc = description,
        schema = schema,
        chip_helper = CHIP_HELPER,
        body = body,
    );
    std::fs::write(dir.join(format!("{name}.ts")), ts).map_err(|e| e.to_string())
}

fn write_skill(dir: &std::path::Path, data: &serde_json::Value) -> Result<(), String> {
    let name = slugify(field_str_or(data, "name", "skill"));
    let md = field_str_or(data, "markdown", "# Skill\n");
    std::fs::write(dir.join(format!("{name}.md")), md).map_err(|e| e.to_string())
}

fn write_connection(dir: &std::path::Path, data: &serde_json::Value) -> Result<(), String> {
    let name = slugify(field_str_or(data, "name", "connection"));
    let kind = field_str_or(data, "kind", "mcp");
    let url = field_str_or(data, "url", "");
    let ts = if kind == "openapi" {
        format!(
            r#"import {{ defineConnection }} from "eve/connections";

export default defineConnection({{
  type: "openapi",
  url: {url:?},
}});
"#,
            url = url
        )
    } else {
        format!(
            r#"import {{ defineConnection }} from "eve/connections";

export default defineConnection({{
  type: "mcp",
  url: {url:?},
}});
"#,
            url = url
        )
    };
    std::fs::write(dir.join(format!("{name}.ts")), ts).map_err(|e| e.to_string())
}

fn write_subagent(root: &std::path::Path, data: &serde_json::Value) -> Result<(), String> {
    let name = slugify(field_str_or(data, "name", "subagent"));
    let dir = root.join(&name);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let model = field_str_or(data, "model", "anthropic/claude-sonnet-5");
    let description = field_str_or(data, "description", "A specialist child agent.");
    let agent_ts = format!(
        "import {{ defineAgent }} from \"eve\";\n\nexport default defineAgent({{\n  model: {model:?},\n  description: {desc:?},\n}});\n",
        model = model, desc = description
    );
    std::fs::write(dir.join("agent.ts"), agent_ts).map_err(|e| e.to_string())?;

    let instructions = field_str_or(data, "instructions", "# Subagent\n");
    std::fs::write(dir.join("instructions.md"), instructions).map_err(|e| e.to_string())
}

fn write_schedule(dir: &std::path::Path, data: &serde_json::Value, index: usize) -> Result<(), String> {
    let cron = field_str_or(data, "cron", "0 * * * *");
    let prompt = field_str_or(data, "prompt", "Run the scheduled task.");
    let name = format!("schedule-{index}");
    let md = format!("---\ncron: \"{cron}\"\n---\n\n{prompt}\n");
    std::fs::write(dir.join(format!("{name}.md")), md).map_err(|e| e.to_string())
}

// ── P8: trigger-channel writer ──────────────────────────────────────────────
// Every trigger-channel node shares one payload shape (`fields`, `secrets`,
// `prompt`). We branch on the node kind to pick the right eve channel file
// name and its option layout. Secret refs (`{{secrets.<slug>}}`) get rewritten
// to `process.env.<slug>` and their raw values are dumped into a project-local
// `.env` — the graph JSON never carries plaintext secrets in the compiled TS.
//
// P5 (webhook/slack/github) is deferred; when we come back, the same helper
// covers them — each just needs its own branch below.

#[derive(Deserialize, Default, Clone)]
#[serde(default)]
pub struct ChannelSecret { pub slug: String, pub value: String }

#[derive(Deserialize, Default, Clone)]
#[serde(default)]
pub struct TriggerChannelData {
    pub fields: Vec<KV>,
    pub secrets: Vec<ChannelSecret>,
    #[allow(dead_code)]
    pub prompt: String,
}

// Chip form for env references: `{{secrets.<slug>}}` → `process.env.<slug>`.
// Anything else passes through as a plain string literal.
fn ts_config_value(v: &str) -> String {
    let trimmed = v.trim();
    if let Some(inner) = trimmed.strip_prefix("{{").and_then(|s| s.strip_suffix("}}")) {
        let inner = inner.trim();
        if let Some(slug) = inner.strip_prefix("secrets.") {
            let slug = slug.trim();
            // Uppercase env vars are the JS convention; keep the slug case-preserved
            // so users can match it exactly in the .env — no surprises.
            return format!("process.env[{:?}] ?? \"\"", slug);
        }
    }
    format!("{:?}", v)
}

fn lookup_field<'a>(fields: &'a [KV], key: &str) -> Option<&'a str> {
    fields.iter().find(|f| f.key == key).map(|f| f.value.as_str())
}

fn write_trigger_channel(
    channels_dir: &std::path::Path,
    kind: &str,
    data: &serde_json::Value,
    index: usize,
) -> Result<Vec<(String, String)>, String> {
    let td: TriggerChannelData = serde_json::from_value(data.clone()).unwrap_or_default();
    // Collect (slug, value) pairs so the caller can write one merged .env.
    let env_pairs: Vec<(String, String)> = td.secrets.iter()
        .filter(|s| !s.slug.is_empty())
        .map(|s| (s.slug.clone(), s.value.clone()))
        .collect();

    let filename = format!("{}-{index}.ts", kind.trim_start_matches("trigger-"));
    let path = channels_dir.join(&filename);

    let ts = match kind {
        "trigger-linear" => {
            let api_key = lookup_field(&td.fields, "apiKey").unwrap_or("{{secrets.LINEAR_API_KEY}}");
            let webhook_secret = lookup_field(&td.fields, "webhookSecret").unwrap_or("");
            let mut extra = String::new();
            if !webhook_secret.is_empty() {
                extra.push_str(&format!("  webhookSecret: {},\n", ts_config_value(webhook_secret)));
            }
            format!(
                r#"import {{ linearChannel }} from "eve/channels/linear";

export default linearChannel({{
  apiKey: {api},
{extra}}});
"#,
                api = ts_config_value(api_key),
                extra = extra,
            )
        }
        "trigger-discord" => {
            let token = lookup_field(&td.fields, "botToken").unwrap_or("{{secrets.DISCORD_BOT_TOKEN}}");
            let public_key = lookup_field(&td.fields, "publicKey").unwrap_or("");
            let mut extra = String::new();
            if !public_key.is_empty() {
                extra.push_str(&format!("  publicKey: {},\n", ts_config_value(public_key)));
            }
            format!(
                r#"import {{ discordChannel }} from "eve/channels/discord";

export default discordChannel({{
  botToken: {token},
{extra}}});
"#,
                token = ts_config_value(token),
                extra = extra,
            )
        }
        "trigger-telegram" => {
            let token = lookup_field(&td.fields, "botToken").unwrap_or("{{secrets.TELEGRAM_BOT_TOKEN}}");
            format!(
                r#"import {{ telegramChannel }} from "eve/channels/telegram";

export default telegramChannel({{
  botToken: {token},
}});
"#,
                token = ts_config_value(token),
            )
        }
        "trigger-teams" => {
            let app_id = lookup_field(&td.fields, "appId").unwrap_or("");
            let app_password = lookup_field(&td.fields, "appPassword").unwrap_or("{{secrets.TEAMS_APP_PASSWORD}}");
            format!(
                r#"import {{ teamsChannel }} from "eve/channels/teams";

export default teamsChannel({{
  appId: {app_id},
  appPassword: {pwd},
}});
"#,
                app_id = ts_config_value(app_id),
                pwd = ts_config_value(app_password),
            )
        }
        "trigger-photon" => {
            let api_key = lookup_field(&td.fields, "apiKey").unwrap_or("{{secrets.PHOTON_API_KEY}}");
            format!(
                r#"import {{ photonChannel }} from "eve/channels/photon";

export default photonChannel({{
  apiKey: {key},
}});
"#,
                key = ts_config_value(api_key),
            )
        }
        "trigger-poll" => {
            // Tiny custom channel + a schedule that hits `/poll`. The schedule
            // fires the internal route; the route calls `send(...)` with the
            // fetched payload only when it changes.
            let url = lookup_field(&td.fields, "url").unwrap_or("");
            let interval_min = lookup_field(&td.fields, "intervalMinutes").unwrap_or("15");
            let only_on_change = lookup_field(&td.fields, "onlyOnChange").unwrap_or("true");
            format!(
                r#"import {{ defineChannel, POST }} from "eve/channels";

// Auto-generated HTTP-poll trigger. The paired `schedules/poll-{index}.md`
// pings this route every {interval} minutes; the route fetches the endpoint
// and forwards the (changed) body as a user message.

let __lastBody: string | null = null;

export default defineChannel({{
  routes: [
    POST("/tick", async (_req, {{ send }}) => {{
      const res = await fetch({url_lit});
      const body = await res.text();
      if ({only_on_change} && body === __lastBody) return new Response("no-change");
      __lastBody = body;
      await send(body, {{ auth: null, continuationToken: "poll" }});
      return new Response("ok");
    }}),
  ],
}});
"#,
                url_lit = ts_config_value(url),
                interval = interval_min,
                only_on_change = if only_on_change == "false" { "false" } else { "true" },
                index = index,
            )
        }
        _ => {
            // Unknown trigger kind — skip silently. Adding a new channel is a
            // matter of adding one branch here.
            return Ok(env_pairs);
        }
    };

    std::fs::write(&path, ts).map_err(|e| e.to_string())?;
    Ok(env_pairs)
}


/// Generate Eve project files from the graph JSON (visual builder source of truth).
/// Called before `eve build`. Empty/malformed graph falls back to a minimal
/// runnable agent so Build never breaks on a fresh automation.
fn generate_eve_project(
    path: &std::path::Path,
    graph_json: &str,
    sandbox_mode: &str,
) -> Result<(), String> {
    let g: graph::Graph = serde_json::from_str(graph_json).unwrap_or_default();

    let agent_dir = path.join("agent");
    std::fs::create_dir_all(&agent_dir).map_err(|e| e.to_string())?;

    // Agent + instructions come from the (single) agent node, or defaults.
    let agent_node = g.nodes.iter().find(|n| n.kind == "agent");
    let agent_data = agent_node.map(|n| &n.data);

    if let Some(data) = agent_data {
        write_agent_ts(&agent_dir, data)?;
        let instructions = field_str_or(data, "instructions", "# Agent\n\nAn automated Eve agent.\n");
        std::fs::write(agent_dir.join("instructions.md"), instructions)
            .map_err(|e| e.to_string())?;
    } else {
        write_agent_ts(&agent_dir, &serde_json::json!({}))?;
        std::fs::write(agent_dir.join("instructions.md"), "# Agent\n\nAn automated Eve agent.\n")
            .map_err(|e| e.to_string())?;
    }

    // Sandbox: agent's stored preference wins over the DB column.
    let effective_sandbox = agent_data
        .and_then(|d| d.get("sandbox"))
        .and_then(|v| v.as_str())
        .unwrap_or(sandbox_mode);
    std::fs::write(agent_dir.join("sandbox.ts"), sandbox_ts_for(effective_sandbox))
        .map_err(|e| e.to_string())?;

    // Group sub-nodes into their Eve slot directories.
    let mut tools = Vec::new();
    let mut flows = Vec::new();
    let mut skills = Vec::new();
    let mut connections = Vec::new();
    let mut subagents = Vec::new();
    let mut schedules = Vec::new();
    // Trigger channels: (kind, data). Compiled into agent/channels/<slug>.ts.
    let mut trigger_channels: Vec<(&str, &serde_json::Value)> = Vec::new();
    for n in &g.nodes {
        match n.kind.as_str() {
            "tool" => tools.push(&n.data),
            "flow" => flows.push(&n.data),
            "skill" => skills.push(&n.data),
            "connection" => connections.push(&n.data),
            "subagent" => subagents.push(&n.data),
            "trigger-schedule" => schedules.push(&n.data),
            k if k.starts_with("trigger-") && k != "trigger-manual" && k != "trigger-schedule" => {
                trigger_channels.push((k, &n.data));
            }
            _ => {}
        }
    }

    fn ensure(dir: std::path::PathBuf, empty: bool) -> Result<std::path::PathBuf, String> {
        if empty { return Ok(dir); }
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(dir)
    }

    let tools_dir = ensure(agent_dir.join("tools"), tools.is_empty() && flows.is_empty())?;
    for d in &tools { write_tool(&tools_dir, d)?; }
    // Flow nodes compile into the same `tools/` directory as generated tool files.
    for d in &flows { write_flow(&tools_dir, d)?; }

    let skills_dir = ensure(agent_dir.join("skills"), skills.is_empty())?;
    for d in &skills { write_skill(&skills_dir, d)?; }

    let conns_dir = ensure(agent_dir.join("connections"), connections.is_empty())?;
    for d in &connections { write_connection(&conns_dir, d)?; }

    let subs_dir = ensure(agent_dir.join("subagents"), subagents.is_empty())?;
    for d in &subagents { write_subagent(&subs_dir, d)?; }

    let sched_dir = ensure(agent_dir.join("schedules"), schedules.is_empty())?;
    for (i, d) in schedules.iter().enumerate() { write_schedule(&sched_dir, d, i)?; }

    // Always write the eve channel with CORS enabled so the Tempest webview can
    // reach the running agent on http://localhost:{port} without preflight rejection.
    let channels_dir = agent_dir.join("channels");
    std::fs::create_dir_all(&channels_dir).map_err(|e| e.to_string())?;
    let eve_channel = r#"import { eveChannel } from "eve/channels/eve";
import { localDev } from "eve/channels/auth";

export default eveChannel({
  auth: [localDev()],
  cors: true,
});
"#;
    std::fs::write(channels_dir.join("eve.ts"), eve_channel).map_err(|e| e.to_string())?;

    // P8: write one channel file per trigger-channel node and collect all
    // per-node secret bags into a single project-local .env.
    let mut all_env: Vec<(String, String)> = Vec::new();
    for (i, (kind, data)) in trigger_channels.iter().enumerate() {
        let pairs = write_trigger_channel(&channels_dir, kind, data, i)?;
        all_env.extend(pairs);
        // For `trigger-poll`, pair the channel with a schedule that pokes it.
        if *kind == "trigger-poll" {
            let interval_min = data.get("fields")
                .and_then(|v| v.as_array())
                .and_then(|arr| arr.iter().find(|kv| kv.get("key").and_then(|k| k.as_str()) == Some("intervalMinutes")))
                .and_then(|kv| kv.get("value").and_then(|v| v.as_str()))
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or(15)
                .max(1);
            let cron = format!("*/{} * * * *", interval_min);
            let sched_dir = agent_dir.join("schedules");
            std::fs::create_dir_all(&sched_dir).map_err(|e| e.to_string())?;
            let md = format!(
                "---\ncron: \"{cron}\"\n---\n\nFire the paired HTTP-poll channel by POSTing to `/tick` on channel `poll-{i}`.\n"
            );
            std::fs::write(sched_dir.join(format!("poll-{i}.md")), md).map_err(|e| e.to_string())?;
        }
    }

    // Merge collected secrets into `.env` at the project root — dedupe by slug
    // (later wins). Written every build; users edit values in the modal.
    if !all_env.is_empty() {
        let mut deduped: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();
        for (k, v) in all_env { deduped.insert(k, v); }
        let env_body: String = deduped.iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(path.join(".env"), format!("{env_body}\n"))
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command(async)]
pub fn list_automations(
    state: tauri::State<'_, super::DbState>,
    workspace_id: Option<String>,
) -> Result<Vec<Automation>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    // workspace_id: None → global (unbound) automations.
    let (sql, ws): (&str, Option<String>) = match workspace_id {
        Some(id) => (
            "SELECT id, workspace_id, name, slug, path, graph, sandbox_mode, enabled, built_at, created_at, updated_at \
             FROM automations WHERE workspace_id = ?1 ORDER BY created_at",
            Some(id),
        ),
        None => (
            "SELECT id, workspace_id, name, slug, path, graph, sandbox_mode, enabled, built_at, created_at, updated_at \
             FROM automations WHERE workspace_id IS NULL ORDER BY created_at",
            None,
        ),
    };
    conn.prepare(sql)
        .and_then(|mut stmt| {
            let mapper = |r: &rusqlite::Row| Ok(Automation {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                name: r.get(2)?,
                slug: r.get(3)?,
                path: r.get(4)?,
                graph: r.get(5)?,
                sandbox_mode: r.get(6)?,
                enabled: r.get(7)?,
                built_at: r.get(8)?,
                created_at: r.get(9)?,
                updated_at: r.get(10)?,
            });
            let rows: Result<Vec<Automation>, _> = match &ws {
                Some(id) => stmt.query_map(rusqlite::params![id], mapper)?.collect(),
                None => stmt.query_map([], mapper)?.collect(),
            };
            rows
        })
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn get_automation(
    state: tauri::State<'_, super::DbState>,
    id: String,
) -> Result<Automation, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT id, workspace_id, name, slug, path, graph, sandbox_mode, enabled, built_at, created_at, updated_at \
         FROM automations WHERE id = ?1",
        rusqlite::params![&id],
        |r| {
            Ok(Automation {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                name: r.get(2)?,
                slug: r.get(3)?,
                path: r.get(4)?,
                graph: r.get(5)?,
                sandbox_mode: r.get(6)?,
                enabled: r.get(7)?,
                built_at: r.get(8)?,
                created_at: r.get(9)?,
                updated_at: r.get(10)?,
            })
        }
    )
        .map_err(|e| format!("Automation not found: {e}"))
}

#[tauri::command(async)]
pub fn create_automation(
    state: tauri::State<'_, super::DbState>,
    workspace_id: Option<String>,
    name: String,
    graph: Option<String>,
) -> Result<Automation, String> {
    let id = uuid::Uuid::new_v4().to_string();
    // Append a short id suffix so identical names never collide on the unique index,
    // and the on-disk path stays a filesystem-safe unique directory name.
    let slug = format!("{}-{}", slugify(&name), &id[..6]);
    let graph = graph.unwrap_or_else(|| "{}".to_string());
    let path = format!(".tempest/automations/{}", slug);

    {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO automations (id, workspace_id, name, slug, path, graph, sandbox_mode, enabled) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![&id, &workspace_id, &name, &slug, &path, &graph, "auto", 1],
        )
            .map_err(|e| e.to_string())?;
    }

    get_automation(state, id)
}

#[derive(serde::Deserialize)]
pub struct UpdateAutomationRequest {
    pub name: Option<String>,
    pub graph: Option<String>,
    #[serde(rename = "sandboxMode")]
    pub sandbox_mode: Option<String>,
    pub enabled: Option<bool>,
}

#[tauri::command(async)]
pub fn update_automation(
    state: tauri::State<'_, super::DbState>,
    id: String,
    req: UpdateAutomationRequest,
) -> Result<Automation, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;

    if let Some(name) = &req.name {
        conn.execute(
            "UPDATE automations SET name = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?2",
            rusqlite::params![name, &id],
        )
            .map_err(|e| e.to_string())?;
    }
    if let Some(graph) = &req.graph {
        conn.execute(
            "UPDATE automations SET graph = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?2",
            rusqlite::params![graph, &id],
        )
            .map_err(|e| e.to_string())?;
    }
    if let Some(sandbox_mode) = &req.sandbox_mode {
        conn.execute(
            "UPDATE automations SET sandbox_mode = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?2",
            rusqlite::params![sandbox_mode, &id],
        )
            .map_err(|e| e.to_string())?;
    }
    if let Some(enabled) = req.enabled {
        conn.execute(
            "UPDATE automations SET enabled = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?2",
            rusqlite::params![if enabled { 1 } else { 0 }, &id],
        )
            .map_err(|e| e.to_string())?;
    }

    drop(conn);
    get_automation(state, id)
}

#[tauri::command(async)]
pub fn delete_automation(
    state: tauri::State<'_, super::DbState>,
    id: String,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM automations WHERE id = ?1",
        rusqlite::params![&id],
    )
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize)]
pub struct BuildResult {
    pub success: bool,
    pub output: String,
    #[serde(rename = "durationMs")]
    pub duration_ms: u128,
}

#[tauri::command(async)]
pub fn build_automation(
    state: tauri::State<'_, super::DbState>,
    app: tauri::AppHandle,
    id: String,
) -> Result<BuildResult, String> {
    let start = std::time::Instant::now();

    // Load automation
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let automation = conn.query_row(
        "SELECT id, workspace_id, name, slug, path, graph, sandbox_mode, enabled, built_at, created_at, updated_at \
         FROM automations WHERE id = ?1",
        rusqlite::params![&id],
        |r| {
            Ok(Automation {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                name: r.get(2)?,
                slug: r.get(3)?,
                path: r.get(4)?,
                graph: r.get(5)?,
                sandbox_mode: r.get(6)?,
                enabled: r.get(7)?,
                built_at: r.get(8)?,
                created_at: r.get(9)?,
                updated_at: r.get(10)?,
            })
        }
    )
        .map_err(|e| format!("Automation not found: {e}"))?;

    // Generate Eve project files
    let project_path = std::path::Path::new(&automation.path);
    std::fs::create_dir_all(&project_path).map_err(|e| e.to_string())?;
    generate_eve_project(project_path, &automation.graph, &automation.sandbox_mode)?;

    // Create package.json if absent
    let package_json_path = project_path.join("package.json");
    if !package_json_path.exists() {
        let pkg = serde_json::json!({
            "name": automation.slug,
            "type": "module"
        });
        std::fs::write(
            &package_json_path,
            serde_json::to_string_pretty(&pkg).map_err(|e| e.to_string())?
        )
            .map_err(|e| e.to_string())?;
    }

    // Run `node eve build`
    let eve = eve_bin(&app)?;
    let output = std::process::Command::new("node")
        .arg(&eve)
        .arg("build")
        .current_dir(project_path)
        .output()
        .map_err(|e| format!("Failed to spawn eve build: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let success = output.status.success();
    let combined_output = if stdout.is_empty() { stderr } else { stdout };

    // Update built_at on success
    if success {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        let _ = conn.execute(
            "UPDATE automations SET built_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1",
            rusqlite::params![&automation.id],
        );
    }

    Ok(BuildResult {
        success,
        output: combined_output,
        duration_ms: start.elapsed().as_millis(),
    })
}

#[tauri::command(async)]
pub fn start_automation(
    state: tauri::State<'_, super::DbState>,
    app: tauri::AppHandle,
    id: String,
) -> Result<ProcessInfo, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;

    // Check not already running
    let existing = conn.query_row(
        "SELECT COUNT(*) FROM automation_processes WHERE automation_id = ?1",
        rusqlite::params![&id],
        |r| r.get::<_, i64>(0)
    )
        .unwrap_or(0);
    if existing > 0 {
        return Err("Automation is already running".to_string());
    }

    let automation = conn.query_row(
        "SELECT id, workspace_id, name, slug, path, graph, sandbox_mode, enabled, built_at, created_at, updated_at \
         FROM automations WHERE id = ?1",
        rusqlite::params![&id],
        |r| {
            Ok(Automation {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                name: r.get(2)?,
                slug: r.get(3)?,
                path: r.get(4)?,
                graph: r.get(5)?,
                sandbox_mode: r.get(6)?,
                enabled: r.get(7)?,
                built_at: r.get(8)?,
                created_at: r.get(9)?,
                updated_at: r.get(10)?,
            })
        }
    )
        .map_err(|e| format!("Automation not found: {e}"))?;
    let port = find_free_port()?;
    let eve = eve_bin(&app)?;

    // Spawn `node eve start --port N --no-ui`
    let child = std::process::Command::new("node")
        .arg(&eve)
        .arg("start")
        .arg("--port")
        .arg(port.to_string())
        .arg("--no-ui")
        .current_dir(&automation.path)
        .spawn()
        .map_err(|e| format!("Failed to spawn eve start: {e}"))?;

    let pid = child.id();

    // Store in DB (conn is borrowed, can't be used here anyway)
    let proc_id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO automation_processes (id, automation_id, port, pid) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![&proc_id, &id, port as i32, pid as i32],
    )
        .map_err(|e| e.to_string())?;

    // Detach the child so it stays alive after this function returns
    drop(child);

    Ok(ProcessInfo { port, pid })
}

#[tauri::command(async)]
pub fn stop_automation(
    state: tauri::State<'_, super::DbState>,
    id: String,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;

    let proc_row = conn.query_row(
        "SELECT pid FROM automation_processes WHERE automation_id = ?1",
        rusqlite::params![&id],
        |r| r.get::<_, i32>(0)
    )
        .map_err(|_| "Process not running".to_string())?;

    let pid = proc_row as u32;
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(&["/PID", &pid.to_string(), "/F"])
            .output();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .arg("-9")
            .arg(pid.to_string())
            .output();
    }

    conn.execute(
        "DELETE FROM automation_processes WHERE automation_id = ?1",
        rusqlite::params![&id],
    )
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command(async)]
pub fn get_automation_process(
    state: tauri::State<'_, super::DbState>,
    id: String,
) -> Result<Option<ProcessInfo>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;

    let result = conn.query_row(
        "SELECT port, pid FROM automation_processes WHERE automation_id = ?1",
        rusqlite::params![&id],
        |r| Ok((r.get::<_, u16>(0)?, r.get::<_, u32>(1)?))
    );

    match result {
        Ok((port, pid)) => Ok(Some(ProcessInfo { port, pid })),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

// ── Try-it (P3) ─────────────────────────────────────────────────────────────
// Fires the tool's HTTP request with a sample input map so the builder's
// response tree can render. Runs synchronously via ureq — no CORS worry
// because the call goes out from the Tauri process, not the webview.

#[derive(Serialize)]
pub struct TryHttpResult {
    pub status: u16,
    pub headers: std::collections::HashMap<String, String>,
    pub body: String,
    pub ms: u128,
}

#[derive(Deserialize)]
pub struct TryHttpArgs {
    pub request: HttpRequest,
    #[serde(default)]
    pub sample: serde_json::Value,
}

fn sub_chips(s: &str, sample: &serde_json::Value) -> String {
    // Same grammar as the generated TS helper.
    let re_start = "{{";
    if !s.contains(re_start) { return s.to_string(); }
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'{' && bytes[i+1] == b'{' {
            if let Some(end) = s[i+2..].find("}}") {
                let inner = s[i+2..i+2+end].trim();
                if let Some(rest) = inner.strip_prefix("input.") {
                    let key = rest.trim();
                    let v = sample.get(key).cloned().unwrap_or(serde_json::Value::Null);
                    let text = match v {
                        serde_json::Value::String(s) => s,
                        serde_json::Value::Null => String::new(),
                        other => other.to_string(),
                    };
                    out.push_str(&text);
                    i += 2 + end + 2;
                    continue;
                }
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

#[tauri::command(async)]
pub fn try_http_request(args: TryHttpArgs) -> Result<TryHttpResult, String> {
    use base64::Engine;

    let start = std::time::Instant::now();
    let req = args.request;
    let sample = args.sample;

    // URL + query
    let mut url = sub_chips(&req.url, &sample);
    if url.is_empty() {
        return Err("URL is empty".to_string());
    }

    let mut query: Vec<(String, String)> = req.query_params.iter()
        .filter(|r| r.enabled && !r.key.is_empty())
        .map(|r| (r.key.clone(), sub_chips(&r.value, &sample)))
        .collect();

    // Auth
    let mut headers: Vec<(String, String)> = req.headers.iter()
        .filter(|r| r.enabled && !r.key.is_empty())
        .map(|r| (r.key.clone(), sub_chips(&r.value, &sample)))
        .collect();
    match &req.auth {
        HttpAuth::None => {}
        HttpAuth::Bearer { token } => {
            headers.push(("Authorization".into(), format!("Bearer {}", sub_chips(token, &sample))));
        }
        HttpAuth::Basic { user, pass } => {
            let raw = format!("{}:{}", sub_chips(user, &sample), sub_chips(pass, &sample));
            let enc = base64::engine::general_purpose::STANDARD.encode(raw.as_bytes());
            headers.push(("Authorization".into(), format!("Basic {}", enc)));
        }
        HttpAuth::ApiKey { in_, name, value } => {
            let v = sub_chips(value, &sample);
            if in_ == "query" {
                query.push((name.clone(), v));
            } else {
                headers.push((name.clone(), v));
            }
        }
    }

    // Body
    let (body_bytes, ct_default): (Option<Vec<u8>>, Option<&str>) = match &req.body {
        HttpBody::None => (None, None),
        HttpBody::Json { fields } => {
            let mut obj = serde_json::Map::new();
            for r in fields.iter().filter(|r| r.enabled && !r.key.is_empty()) {
                obj.insert(r.key.clone(), serde_json::Value::String(sub_chips(&r.value, &sample)));
            }
            let s = serde_json::Value::Object(obj).to_string();
            (Some(s.into_bytes()), Some("application/json"))
        }
        HttpBody::Form { fields } => {
            let mut parts = Vec::new();
            for r in fields.iter().filter(|r| r.enabled && !r.key.is_empty()) {
                parts.push(format!("{}={}",
                    urlencoding_encode(&r.key),
                    urlencoding_encode(&sub_chips(&r.value, &sample))));
            }
            (Some(parts.join("&").into_bytes()), Some("application/x-www-form-urlencoded"))
        }
        HttpBody::Raw { content_type, text } => {
            let body = sub_chips(text, &sample);
            (Some(body.into_bytes()), Some(if content_type.is_empty() { "text/plain" } else { content_type.as_str() }))
        }
    };

    // Append query string to URL manually so ureq's method-generic call is simple.
    if !query.is_empty() {
        let qs: String = query.iter()
            .map(|(k, v)| format!("{}={}", urlencoding_encode(k), urlencoding_encode(v)))
            .collect::<Vec<_>>().join("&");
        if url.contains('?') { url.push('&'); } else { url.push('?'); }
        url.push_str(&qs);
    }

    // Default content-type only if user didn't set one.
    let has_ct = headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("content-type"));
    if !has_ct {
        if let Some(ct) = ct_default {
            headers.push(("Content-Type".into(), ct.to_string()));
        }
    }

    let method = if req.method.is_empty() { "GET" } else { req.method.as_str() };
    let mut r = ureq::request(method, &url);
    for (k, v) in &headers { r = r.set(k, v); }

    let resp = if let Some(bytes) = body_bytes {
        r.send_bytes(&bytes)
    } else {
        r.call()
    };

    // ureq treats 4xx/5xx as errors — unwrap the response either way.
    let response = match resp {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(e) => return Err(format!("Request failed: {e}")),
    };

    let status = response.status();
    let mut out_headers = std::collections::HashMap::new();
    for name in response.headers_names() {
        if let Some(v) = response.header(&name) {
            out_headers.insert(name, v.to_string());
        }
    }
    let body = response.into_string()
        .unwrap_or_else(|e| format!("<failed to read body: {e}>"));

    Ok(TryHttpResult {
        status,
        headers: out_headers,
        body,
        ms: start.elapsed().as_millis(),
    })
}

#[cfg(test)]
mod flow_compiler_tests {
    // ponytail: one self-check that fails loudly if the step compiler
    // stops emitting the shapes downstream TS relies on.
    use super::*;
    use serde_json::json;

    fn compile(graph: serde_json::Value) -> String {
        // Skip pulling in tempfile — one throwaway UUID dir under the OS temp
        // root is enough for the self-check.
        let dir = std::env::temp_dir()
            .join(format!("tempest-flow-test-{}", uuid::Uuid::new_v4()));
        let d = dir.join("agent").join("tools");
        std::fs::create_dir_all(&d).unwrap();
        write_flow(&d, &graph).unwrap();
        let out = std::fs::read_to_string(d.join("t.ts")).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        out
    }

    #[test]
    fn compiles_if_call_return() {
        let ts = compile(json!({
            "name": "t",
            "description": "test",
            "input": { "fields": [{ "name": "city", "type": "string", "required": true }] },
            "steps": [
                { "id": "s1", "kind": "call", "assignTo": "weather",
                  "request": { "method": "GET", "url": "https://x.example/{{input.city}}",
                               "queryParams": [], "headers": [],
                               "auth": { "kind": "none" }, "body": { "kind": "none" } } },
                { "id": "s2", "kind": "if",
                  "condition": { "left": "{{input.weather}}", "op": "contains", "right": "rain" },
                  "then": [{ "id": "s3", "kind": "return", "value": "bring umbrella" }],
                  "else": [{ "id": "s4", "kind": "return", "value": "no umbrella" }] },
            ],
        }));
        assert!(ts.contains("defineTool"), "missing defineTool wrapper");
        assert!(ts.contains("__scope[\"weather\"]"), "assignTo not emitted: {ts}");
        assert!(ts.contains("if ("), "if step not emitted: {ts}");
        assert!(ts.contains("return __sub("), "return not routed through __sub: {ts}");
    }
}

// Minimal application/x-www-form-urlencoded encoder — avoids pulling in another
// dep. Encodes anything outside unreserved chars.
fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(*b, b'-' | b'_' | b'.' | b'~') {
            out.push(*b as char);
        } else if *b == b' ' {
            out.push('+');
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}
