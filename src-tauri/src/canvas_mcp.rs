//! Canvas MCP server — the "Tempest Bridge".
//!
//! An external CLI agent (Claude Code, Cursor, …) launched in a canvas worktree
//! gets no system prompt or JS tool from us, so it's blind to the canvas. This
//! makes the *Tempest binary itself* answer MCP over stdio: `write_canvas_mcp_config`
//! drops a `.mcp.json` into the agent's cwd pointing `command` at our own exe with
//! `--canvas-mcp --db <tempest.db> --project <id>`; the agent spawns us as an MCP
//! child and discovers two read-only tools — `canvas_map` and `read_canvas_node`.
//!
//! We reuse the already-present `rusqlite` (read-only, no daemon, no Node artifact).
//! `maybe_serve()` runs at the very top of `run()`, before Tauri/single-instance
//! init, so the sidecar instance never becomes a second window.
//!
//! Newline-delimited JSON-RPC 2.0 (MCP stdio transport). Hand-rolled — the surface
//! is tiny (initialize / tools/list / tools/call), a crate would be more code to wire.

use rusqlite::Connection;
use serde_json::{json, Value};
use std::io::{BufRead, Write};

const MAX_CONTENT: usize = 16_000;

/// If `--canvas-mcp` is on argv, run the stdio server to completion and return
/// `true` (caller should return/exit). Otherwise `false` — normal app launch.
pub fn maybe_serve() -> bool {
    let args: Vec<String> = std::env::args().collect();
    if !args.iter().any(|a| a == "--canvas-mcp") {
        return false;
    }
    let db = flag(&args, "--db").unwrap_or_default();
    let project = flag(&args, "--project").unwrap_or_default();

    match Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(conn) => {
            let _ = conn.busy_timeout(std::time::Duration::from_millis(3000));
            serve(&conn, &project);
        }
        // Can't open the DB → still speak MCP so the agent gets a clean error, not a
        // dead pipe. serve() with a throwaway in-memory conn returns empty results.
        Err(e) => {
            eprintln!("[canvas-mcp] open {db} failed: {e}");
            if let Ok(mem) = Connection::open_in_memory() {
                serve(&mem, &project);
            }
        }
    }
    true
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn serve(conn: &Connection, project: &str) {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = match line { Ok(l) => l, Err(_) => break };
        if line.trim().is_empty() { continue; }
        let req: Value = match serde_json::from_str(&line) { Ok(v) => v, Err(_) => continue };
        // Notifications (no `id`) get no response.
        let id = match req.get("id") { Some(id) if !id.is_null() => id.clone(), _ => continue };
        let method = req.get("method").and_then(Value::as_str).unwrap_or("");
        let resp = match dispatch(conn, project, method, req.get("params")) {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err((code, msg)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": msg } }),
        };
        if writeln!(out, "{resp}").is_err() { break; }
        let _ = out.flush();
    }
}

fn dispatch(conn: &Connection, project: &str, method: &str, params: Option<&Value>) -> Result<Value, (i64, String)> {
    match method {
        "initialize" => Ok(json!({
            "protocolVersion": "2024-11-05",
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "tempest-canvas", "version": env!("CARGO_PKG_VERSION") }
        })),
        "tools/list" => Ok(json!({ "tools": tool_specs() })),
        "tools/call" => {
            let name = params.and_then(|p| p.get("name")).and_then(Value::as_str).unwrap_or("");
            let args = params.and_then(|p| p.get("arguments"));
            let text = match name {
                "canvas_map" => tool_canvas_map(conn, project),
                "read_canvas_node" => {
                    let title = args.and_then(|a| a.get("title")).and_then(Value::as_str).unwrap_or("");
                    tool_read_node(conn, project, title)
                }
                other => return Err((-32602, format!("unknown tool: {other}"))),
            };
            Ok(json!({ "content": [ { "type": "text", "text": text } ] }))
        }
        _ => Err((-32601, format!("method not found: {method}"))),
    }
}

fn tool_specs() -> Value {
    json!([
        {
            "name": "canvas_map",
            "description": "The Tempest canvas you were launched from: every node (chat/text/agent/terminal) across this project's canvases, with a one-line gist and how nodes are wired. Ambient reference — call read_canvas_node for a node's full content.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "read_canvas_node",
            "description": "Full content of one canvas node by its title: a text note's whole body, or a chat node's transcript. Titles come from canvas_map.",
            "inputSchema": {
                "type": "object",
                "properties": { "title": { "type": "string", "description": "The node's title, as shown in canvas_map." } },
                "required": ["title"]
            }
        }
    ])
}

/// data.title, or the kind as a fallback label.
fn node_title(data: &Value, kind: &str) -> String {
    data.get("title").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(kind).to_string()
}

fn first_line(s: &str, max: usize) -> String {
    let line = s.trim().lines().next().unwrap_or("").trim();
    if line.chars().count() > max { format!("{}…", line.chars().take(max).collect::<String>()) } else { line.to_string() }
}

fn tool_canvas_map(conn: &Connection, project: &str) -> String {
    let threads: Vec<(String, String)> = conn
        .prepare("SELECT id, name FROM threads WHERE project_id=?1 ORDER BY sort_order")
        .and_then(|mut s| {
            s.query_map([project], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map(|rows| rows.filter_map(Result::ok).collect())
        })
        .unwrap_or_default();

    if threads.is_empty() { return "No canvas threads in this project yet.".into(); }

    let mut out = String::from("# Tempest canvas map\nAmbient reference — the canvas you were launched from. Titles + one-line gists, not full content. Call read_canvas_node(title) for a node's full body/transcript.\n");
    for (tid, tname) in &threads {
        out.push_str(&format!("\n## Thread: {tname}\n"));
        // Title-by-id for wiring lines below.
        let mut titles: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        if let Ok(mut st) = conn.prepare("SELECT id, kind, data FROM thread_nodes WHERE thread_id=?1") {
            let rows = st.query_map([tid], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?))
            });
            if let Ok(rows) = rows {
                for (nid, kind, data_str) in rows.filter_map(Result::ok) {
                    let data: Value = data_str.as_deref().and_then(|s| serde_json::from_str(s).ok()).unwrap_or(json!({}));
                    let title = node_title(&data, &kind);
                    titles.insert(nid, title.clone());
                    let gist = match kind.as_str() {
                        "text" => first_line(data.get("body").and_then(Value::as_str).unwrap_or(""), 100),
                        "chat" => {
                            let mut parts = vec![];
                            if let Some(n) = data.get("msgCount").and_then(Value::as_u64) { parts.push(format!("{n} msg{}", if n == 1 { "" } else { "s" })); }
                            if let Some(g) = data.get("gist").and_then(Value::as_str).filter(|s| !s.is_empty()) { parts.push(g.to_string()); }
                            parts.join(" · ")
                        }
                        _ => String::new(), // agent/terminal: live status isn't in the DB
                    };
                    out.push_str(&format!("- [{kind}] \"{title}\"{}\n", if gist.is_empty() { String::new() } else { format!(" — {gist}") }));
                }
            }
        }
        if let Ok(mut st) = conn.prepare("SELECT source, target FROM thread_edges WHERE thread_id=?1") {
            if let Ok(rows) = st.query_map([tid], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
                let edges: Vec<_> = rows.filter_map(Result::ok).collect();
                if !edges.is_empty() {
                    out.push_str("Wiring (source → target = target continues source):\n");
                    let name = |id: &str| titles.get(id).cloned().unwrap_or_else(|| id.to_string());
                    for (s, t) in edges { out.push_str(&format!("- \"{}\" → \"{}\"\n", name(&s), name(&t))); }
                }
            }
        }
    }
    out
}

fn tool_read_node(conn: &Connection, project: &str, title: &str) -> String {
    // All nodes in the project, then resolve title in Rust: exact (case-insensitive)
    // first, else first substring match — mirrors the BYOK read_canvas_node tool.
    let nodes: Vec<(String, String, Value)> = conn
        .prepare("SELECT n.id, n.kind, n.data FROM thread_nodes n JOIN threads t ON n.thread_id=t.id WHERE t.project_id=?1")
        .and_then(|mut s| {
            s.query_map([project], |r| {
                let data: Option<String> = r.get(2)?;
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, data.and_then(|d| serde_json::from_str(&d).ok()).unwrap_or(json!({}))))
            }).map(|rows| rows.filter_map(Result::ok).collect())
        })
        .unwrap_or_default();

    let want = title.trim().to_lowercase();
    let hit = nodes.iter().find(|(_, k, d)| node_title(d, k).to_lowercase() == want)
        .or_else(|| nodes.iter().find(|(_, k, d)| node_title(d, k).to_lowercase().contains(&want)));

    let Some((nid, kind, data)) = hit else {
        return format!("No canvas node titled \"{title}\". Call canvas_map to list node titles.");
    };

    let body = match kind.as_str() {
        "text" => data.get("body").and_then(Value::as_str).unwrap_or("").trim().to_string(),
        "chat" => transcript(conn, nid),
        _ => format!("[{kind} node — a running session; no readable content]"),
    };
    let body = if body.is_empty() { "(empty)".to_string() } else { body };
    if body.chars().count() > MAX_CONTENT {
        format!("{}\n\n[truncated at {MAX_CONTENT} chars]", body.chars().take(MAX_CONTENT).collect::<String>())
    } else { body }
}

/// Flatten a chat node's messages (seq order) to "role: text", text parts only.
fn transcript(conn: &Connection, node_id: &str) -> String {
    let mut st = match conn.prepare("SELECT role, parts FROM thread_messages WHERE node_id=?1 ORDER BY seq") {
        Ok(s) => s, Err(_) => return String::new(),
    };
    let rows = st.query_map([node_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)));
    let Ok(rows) = rows else { return String::new() };
    let mut out = String::new();
    for (role, parts_json) in rows.filter_map(Result::ok) {
        let parts: Value = serde_json::from_str(&parts_json).unwrap_or(json!([]));
        let text: String = parts.as_array().map(|a| {
            a.iter().filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|p| p.get("content").and_then(Value::as_str))
                .collect::<Vec<_>>().join("")
        }).unwrap_or_default();
        if !text.trim().is_empty() { out.push_str(&format!("{role}: {}\n\n", text.trim())); }
    }
    out.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE threads(id TEXT, project_id TEXT, name TEXT, sort_order INT);
             CREATE TABLE thread_nodes(id TEXT, thread_id TEXT, kind TEXT, data TEXT);
             CREATE TABLE thread_edges(thread_id TEXT, source TEXT, target TEXT);
             CREATE TABLE thread_messages(node_id TEXT, role TEXT, parts TEXT, seq INT);
             INSERT INTO threads VALUES('t1','p1','Design',0);
             INSERT INTO thread_nodes VALUES('n1','t1','text','{\"title\":\"Spec\",\"body\":\"Line one\\nLine two\"}');
             INSERT INTO thread_nodes VALUES('n2','t1','chat','{\"title\":\"Plan\",\"gist\":\"discuss auth\",\"msgCount\":2}');
             INSERT INTO thread_edges VALUES('t1','n1','n2');
             INSERT INTO thread_messages VALUES('n2','user','[{\"type\":\"text\",\"content\":\"hi\"}]',0);
             INSERT INTO thread_messages VALUES('n2','assistant','[{\"type\":\"text\",\"content\":\"hello\"},{\"type\":\"tool-call\",\"toolName\":\"x\"}]',1);"
        ).unwrap();
        c
    }

    #[test]
    fn map_lists_nodes_and_wiring() {
        let m = tool_canvas_map(&seed(), "p1");
        assert!(m.contains("[text] \"Spec\" — Line one"), "{m}");
        assert!(m.contains("[chat] \"Plan\" — 2 msgs · discuss auth"), "{m}");
        assert!(m.contains("\"Spec\" → \"Plan\""), "{m}");
        assert!(tool_canvas_map(&seed(), "other").contains("No canvas threads"));
    }

    #[test]
    fn read_returns_body_and_transcript() {
        let c = seed();
        assert_eq!(tool_read_node(&c, "p1", "Spec"), "Line one\nLine two");
        // case-insensitive + text-parts-only (tool-call dropped)
        assert_eq!(tool_read_node(&c, "p1", "plan"), "user: hi\n\nassistant: hello");
        assert!(tool_read_node(&c, "p1", "nope").contains("No canvas node"));
    }
}
