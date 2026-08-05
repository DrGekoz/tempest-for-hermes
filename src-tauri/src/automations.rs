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

/// Generate Eve project files from the graph JSON (visual builder source of truth).
/// Writes agent.ts, instructions.md, tools/*.ts, channels/*.ts, schedules/*.ts, sandbox.ts.
/// Called before `eve build`.
fn generate_eve_project(
    path: &std::path::Path,
    _graph: &str,
    sandbox_mode: &str,
) -> Result<(), String> {
    // Create agent/ directory
    let agent_dir = path.join("agent");
    std::fs::create_dir_all(&agent_dir).map_err(|e| e.to_string())?;

    // Minimal agent.ts: use default model
    let agent_ts = r#"import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-5",
});
"#;
    std::fs::write(agent_dir.join("agent.ts"), agent_ts)
        .map_err(|e| e.to_string())?;

    // Minimal instructions.md
    let instructions_md = "# Agent\n\nAn automated Eve agent.\n";
    std::fs::write(agent_dir.join("instructions.md"), instructions_md)
        .map_err(|e| e.to_string())?;

    // Sandbox config based on platform
    let sandbox_ts = match sandbox_mode {
        "docker" => {
            r#"import { defineSandbox } from "eve/sandbox";
import { docker } from "eve/sandbox/docker";
import { justbash } from "eve/sandbox/justbash";

export default defineSandbox({
  backend: docker(),
});
"#
        }
        "none" => {
            r#"import { defineSandbox } from "eve/sandbox";
import { justbash } from "eve/sandbox/justbash";

export default defineSandbox({
  backend: justbash(),
});
"#
        }
        _ => {
            // "auto" — platform-specific
            if cfg!(windows) {
                r#"import { defineSandbox } from "eve/sandbox";
import { docker } from "eve/sandbox/docker";
import { justbash } from "eve/sandbox/justbash";

export default defineSandbox({
  backend: docker(),
});
"#
            } else {
                r#"import { defineSandbox } from "eve/sandbox";
import { microsandbox } from "eve/sandbox/microsandbox";
import { docker } from "eve/sandbox/docker";

export default defineSandbox({
  backend: microsandbox(),
});
"#
            }
        }
    };
    std::fs::write(agent_dir.join("sandbox.ts"), sandbox_ts)
        .map_err(|e| e.to_string())?;

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
