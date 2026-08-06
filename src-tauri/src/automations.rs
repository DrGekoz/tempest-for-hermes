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
    pub workspace_id: String,
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

fn write_tool(dir: &std::path::Path, data: &serde_json::Value) -> Result<(), String> {
    let name = slugify(field_str_or(data, "name", "tool"));
    let description = field_str_or(data, "description", "A tool.");
    let preset = field_str_or(data, "preset", "custom");

    let body = if preset == "http" {
        let method = field_str_or(data, "httpMethod", "GET");
        let url = field_str_or(data, "httpUrl", "");
        format!(
            r#"import {{ defineTool }} from "eve/tools";
import {{ z }} from "zod";

export default defineTool({{
  description: {desc:?},
  inputSchema: z.object({{
    body: z.string().optional(),
  }}),
  async execute(input) {{
    const res = await fetch({url:?}, {{
      method: {method:?},
      body: {method_is_body_bearing} ? input.body : undefined,
    }});
    const text = await res.text();
    return {{ status: res.status, body: text }};
  }},
}});
"#,
            desc = description,
            url = url,
            method = method,
            method_is_body_bearing = matches!(method, "POST" | "PUT" | "PATCH")
        )
    } else {
        let input_schema = field_str_or(data, "customInputSchema", "z.object({})");
        let execute = field_str_or(data, "customExecute", "return {};");
        format!(
            r#"import {{ defineTool }} from "eve/tools";
import {{ z }} from "zod";

export default defineTool({{
  description: {desc:?},
  inputSchema: {schema},
  async execute(input, ctx) {{
{body}
  }},
}});
"#,
            desc = description,
            schema = input_schema,
            body = indent(execute, 4),
        )
    };
    std::fs::write(dir.join(format!("{name}.ts")), body).map_err(|e| e.to_string())
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

fn indent(s: &str, spaces: usize) -> String {
    let pad = " ".repeat(spaces);
    s.lines().map(|l| format!("{pad}{l}")).collect::<Vec<_>>().join("\n")
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
    let mut skills = Vec::new();
    let mut connections = Vec::new();
    let mut subagents = Vec::new();
    let mut schedules = Vec::new();
    for n in &g.nodes {
        match n.kind.as_str() {
            "tool" => tools.push(&n.data),
            "skill" => skills.push(&n.data),
            "connection" => connections.push(&n.data),
            "subagent" => subagents.push(&n.data),
            "trigger-schedule" => schedules.push(&n.data),
            _ => {}
        }
    }

    fn ensure(dir: std::path::PathBuf, empty: bool) -> Result<std::path::PathBuf, String> {
        if empty { return Ok(dir); }
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(dir)
    }

    let tools_dir = ensure(agent_dir.join("tools"), tools.is_empty())?;
    for d in &tools { write_tool(&tools_dir, d)?; }

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

    Ok(())
}

#[tauri::command(async)]
pub fn list_automations(
    state: tauri::State<'_, super::DbState>,
    workspace_id: String,
) -> Result<Vec<Automation>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.prepare(
        "SELECT id, workspace_id, name, slug, path, graph, sandbox_mode, enabled, built_at, created_at, updated_at \
         FROM automations WHERE workspace_id = ?1 ORDER BY created_at"
    )
        .and_then(|mut stmt| {
            stmt.query_map(rusqlite::params![&workspace_id], |r| {
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
            })?
            .collect::<Result<Vec<_>, _>>()
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
    workspace_id: String,
    name: String,
    graph: Option<String>,
) -> Result<Automation, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let slug = name.to_lowercase().replace(' ', "-");
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
