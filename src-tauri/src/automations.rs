use std::path::PathBuf;
use serde::{Serialize, Deserialize};
use tauri::Emitter;

fn home_dir_cwd() -> String {
    #[cfg(windows)]
    let key = "USERPROFILE";
    #[cfg(not(windows))]
    let key = "HOME";
    std::env::var(key).unwrap_or_else(|_| ".".into())
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Automation {
    pub id: String,
    #[serde(rename = "projectId")]
    pub project_id: Option<String>,
    pub name: String,
    pub agent: String,
    pub schedule: String,
    pub prompt: String,
    pub model: Option<String>,
    pub enabled: bool,
    #[serde(rename = "nextRunAt")]
    pub next_run_at: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AutomationRun {
    pub id: String,
    #[serde(rename = "automationId")]
    pub automation_id: String,
    pub status: String,
    #[serde(rename = "triggeredBy")]
    pub triggered_by: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct PromptVersion {
    pub id: String,
    #[serde(rename = "automationId")]
    pub automation_id: String,
    pub prompt: String,
    pub source: String,
    #[serde(rename = "bucketAt")]
    pub bucket_at: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Deserialize)]
pub struct CreateAutomationReq {
    #[serde(rename = "projectId")]
    pub project_id: Option<String>,
    pub name: String,
    pub agent: Option<String>,
    pub schedule: Option<String>,
    pub prompt: Option<String>,
    pub model: Option<String>,
    #[serde(rename = "nextRunAt")]
    pub next_run_at: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateAutomationReq {
    pub name: Option<String>,
    pub agent: Option<String>,
    pub schedule: Option<String>,
    pub prompt: Option<String>,
    pub model: Option<String>,
    pub enabled: Option<bool>,
    #[serde(rename = "nextRunAt")]
    pub next_run_at: Option<String>,
}

#[derive(Deserialize)]
pub struct UpsertRunReq {
    pub id: String,
    #[serde(rename = "automationId")]
    pub automation_id: String,
    pub status: String,
    #[serde(rename = "triggeredBy")]
    pub triggered_by: Option<String>,
}

#[derive(Deserialize)]
pub struct SavePromptVersionReq {
    #[serde(rename = "automationId")]
    pub automation_id: String,
    pub prompt: String,
    pub source: Option<String>,
    #[serde(rename = "bucketAt")]
    pub bucket_at: String,
}

fn map_row(r: &rusqlite::Row) -> rusqlite::Result<Automation> {
    Ok(Automation {
        id:           r.get(0)?,
        project_id:   r.get(1)?,
        name:         r.get(2)?,
        agent:        r.get(3)?,
        schedule:     r.get(4)?,
        prompt:       r.get(5)?,
        model:        r.get(6)?,
        enabled:      r.get::<_, i64>(7)? != 0,
        next_run_at:  r.get(8)?,
        created_at:   r.get(9)?,
        updated_at:   r.get(10)?,
    })
}

#[tauri::command(async)]
pub fn list_automations(
    state: tauri::State<'_, super::DbState>,
    project_id: Option<String>,
) -> Result<Vec<Automation>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    // A None project_id means the caller wants GLOBAL automations only (no project
    // scope). Previously this returned every row, which made project-scoped
    // automations bleed into the Global tab.
    let (sql, pid_filter): (&str, Option<String>) = match project_id {
        Some(pid) => (
            "SELECT id, project_id, name, agent, schedule, prompt, model, enabled, next_run_at, created_at, updated_at \
             FROM automations WHERE project_id = ?1 ORDER BY created_at",
            Some(pid),
        ),
        None => (
            "SELECT id, project_id, name, agent, schedule, prompt, model, enabled, next_run_at, created_at, updated_at \
             FROM automations WHERE project_id IS NULL ORDER BY created_at",
            None,
        ),
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows: Vec<Automation> = if let Some(pid) = pid_filter {
        stmt.query_map(rusqlite::params![pid], map_row)
    } else {
        stmt.query_map([], map_row)
    }
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command(async)]
pub fn get_automation(
    state: tauri::State<'_, super::DbState>,
    id: String,
) -> Result<Automation, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT id, project_id, name, agent, schedule, prompt, model, enabled, next_run_at, created_at, updated_at \
         FROM automations WHERE id = ?1",
        rusqlite::params![&id],
        map_row,
    )
    .map_err(|e| format!("Automation not found: {e}"))
}

#[tauri::command(async)]
pub fn create_automation(
    state: tauri::State<'_, super::DbState>,
    req: CreateAutomationReq,
) -> Result<Automation, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let agent = req.agent.unwrap_or_else(|| "claude-code".to_string());
    let schedule = req.schedule.unwrap_or_else(|| "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0".to_string());
    let prompt = req.prompt.unwrap_or_default();
    {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO automations (id, project_id, name, agent, schedule, prompt, model, next_run_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![&id, &req.project_id, &req.name, &agent, &schedule, &prompt, &req.model, &req.next_run_at],
        )
        .map_err(|e| e.to_string())?;
    }
    get_automation(state, id)
}

#[tauri::command(async)]
pub fn update_automation(
    state: tauri::State<'_, super::DbState>,
    id: String,
    req: UpdateAutomationReq,
) -> Result<Automation, String> {
    {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        if let Some(v) = &req.name {
            conn.execute(
                "UPDATE automations SET name = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?2",
                rusqlite::params![v, &id],
            ).map_err(|e| e.to_string())?;
        }
        if let Some(v) = &req.agent {
            conn.execute(
                "UPDATE automations SET agent = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?2",
                rusqlite::params![v, &id],
            ).map_err(|e| e.to_string())?;
        }
        if let Some(v) = &req.schedule {
            conn.execute(
                "UPDATE automations SET schedule = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?2",
                rusqlite::params![v, &id],
            ).map_err(|e| e.to_string())?;
        }
        if let Some(v) = &req.prompt {
            conn.execute(
                "UPDATE automations SET prompt = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?2",
                rusqlite::params![v, &id],
            ).map_err(|e| e.to_string())?;
        }
        if let Some(v) = &req.model {
            // Empty string clears the override (fall back to agent CLI default).
            let val: Option<&str> = if v.is_empty() { None } else { Some(v.as_str()) };
            conn.execute(
                "UPDATE automations SET model = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?2",
                rusqlite::params![val, &id],
            ).map_err(|e| e.to_string())?;
        }
        if let Some(v) = req.enabled {
            conn.execute(
                "UPDATE automations SET enabled = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?2",
                rusqlite::params![if v { 1i64 } else { 0i64 }, &id],
            ).map_err(|e| e.to_string())?;
        }
        // next_run_at: Some(Some(v)) = set to v, Some(None) = clear, None = no-op
        if req.next_run_at.is_some() || req.schedule.is_some() {
            // Only update next_run_at if the field was explicitly sent
            // (req fields are Option so None means "not in payload")
            // We handle this by always updating next_run_at when it appears in the struct.
            // Since Deserialize gives None for absent fields, we can't distinguish
            // "null in JSON" from "absent from JSON" without a custom deserializer.
            // Treat any Some (including Some(None)) as explicit.
            conn.execute(
                "UPDATE automations SET next_run_at = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?2",
                rusqlite::params![&req.next_run_at, &id],
            ).map_err(|e| e.to_string())?;
        }
    }
    get_automation(state, id)
}

#[tauri::command(async)]
pub fn delete_automation(
    state: tauri::State<'_, super::DbState>,
    id: String,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM automations WHERE id = ?1", rusqlite::params![&id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(async)]
pub fn list_automation_runs(
    state: tauri::State<'_, super::DbState>,
    automation_id: String,
) -> Result<Vec<AutomationRun>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id, automation_id, status, triggered_by, created_at \
         FROM automation_runs WHERE automation_id = ?1 ORDER BY created_at DESC LIMIT 50",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(rusqlite::params![&automation_id], |r| {
        Ok(AutomationRun {
            id:            r.get(0)?,
            automation_id: r.get(1)?,
            status:        r.get(2)?,
            triggered_by:  r.get(3)?,
            created_at:    r.get(4)?,
        })
    })
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command(async)]
pub fn upsert_automation_run(
    state: tauri::State<'_, super::DbState>,
    req: UpsertRunReq,
) -> Result<AutomationRun, String> {
    let triggered_by = req.triggered_by.unwrap_or_else(|| "manual".to_string());
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO automation_runs (id, automation_id, status, triggered_by) \
         VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, \
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        rusqlite::params![&req.id, &req.automation_id, &req.status, &triggered_by],
    ).map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT id, automation_id, status, triggered_by, created_at FROM automation_runs WHERE id = ?1",
        rusqlite::params![&req.id],
        |r| Ok(AutomationRun {
            id:            r.get(0)?,
            automation_id: r.get(1)?,
            status:        r.get(2)?,
            triggered_by:  r.get(3)?,
            created_at:    r.get(4)?,
        }),
    ).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn list_prompt_versions(
    state: tauri::State<'_, super::DbState>,
    automation_id: String,
) -> Result<Vec<PromptVersion>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id, automation_id, prompt, source, bucket_at, created_at \
         FROM automation_prompt_versions WHERE automation_id = ?1 \
         ORDER BY bucket_at DESC LIMIT 20",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(rusqlite::params![&automation_id], |r| {
        Ok(PromptVersion {
            id:            r.get(0)?,
            automation_id: r.get(1)?,
            prompt:        r.get(2)?,
            source:        r.get(3)?,
            bucket_at:     r.get(4)?,
            created_at:    r.get(5)?,
        })
    })
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command(async)]
pub fn save_prompt_version(
    state: tauri::State<'_, super::DbState>,
    req: SavePromptVersionReq,
) -> Result<(), String> {
    let id = uuid::Uuid::new_v4().to_string();
    let source = req.source.unwrap_or_else(|| "edit".to_string());
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO automation_prompt_versions (id, automation_id, prompt, source, bucket_at) \
         VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT(automation_id, bucket_at) DO UPDATE SET \
           prompt = excluded.prompt, source = excluded.source",
        rusqlite::params![&id, &req.automation_id, &req.prompt, &source, &req.bucket_at],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// Fire an agent CLI as a detached background subprocess for an automation run.
/// No PTY, no session/tab — automations are jobs, not interactive workspaces.
///
/// Args are quoted with single quotes for pwsh / sh (matches create_pty_session)
/// and joined into a shell -c string. stdin/stdout/stderr are closed so the
/// child neither reads nor spams the parent. A watcher thread emits
/// `automation:done` when the child exits so the frontend can flip the run
/// status to success/failed.
///
/// An empty cwd falls back to the user's home dir — used by global-scope
/// automations that aren't tied to any project.
#[tauri::command(async)]
pub fn run_automation_command(
    app: tauri::AppHandle,
    run_id: String,
    cwd: String,
    program: String,
    args: Vec<String>,
) -> Result<(), String> {
    let cwd = if cwd.trim().is_empty() { home_dir_cwd() } else { cwd };

    let mut parts: Vec<String> = vec![program];
    for arg in &args {
        if arg.is_empty() || arg.contains(' ') || arg.contains('\'') || arg.contains('\n') {
            // Single-quote-escape for pwsh / POSIX sh. Matches create_pty_session.
            parts.push(format!("'{}'", arg.replace('\'', "'''")));
        } else {
            parts.push(arg.clone());
        }
    }
    let invocation = parts.join(" ");

    #[cfg(windows)]
    let spawn_result = std::process::Command::new("powershell")
        .args(["-NoLogo", "-NoProfile", "-Command", &invocation])
        .current_dir(&cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    #[cfg(not(windows))]
    let spawn_result = std::process::Command::new("sh")
        .args(["-c", &invocation])
        .current_dir(&cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();

    let mut child = spawn_result.map_err(|e| e.to_string())?;

    std::thread::spawn(move || {
        let ok = child.wait().map(|s| s.success()).unwrap_or(false);
        let _ = app.emit("automation:done", serde_json::json!({
            "runId": run_id,
            "ok": ok,
        }));
    });

    Ok(())
}

pub fn start_scheduler(app: tauri::AppHandle, db_path: PathBuf) {
    std::thread::spawn(move || {
        // Open a dedicated connection so we never contend with the shared DbState mutex.
        let conn = match rusqlite::Connection::open(&db_path) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[automations] scheduler failed to open db: {e}");
                return;
            }
        };
        loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
            let due_ids: Vec<String> = {
                let mut stmt = match conn.prepare(
                    "SELECT id FROM automations WHERE enabled = 1 \
                     AND next_run_at IS NOT NULL \
                     AND next_run_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')"
                ) {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                let x = match stmt.query_map([], |r| r.get(0)) {
                    Ok(rows) => rows.flatten().collect(),
                    Err(_) => continue,
                }; x
            };
            for id in due_ids {
                let _ = app.emit("automation:dispatch", &id);
            }
        }
    });
}
