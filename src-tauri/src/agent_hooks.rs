//! Loopback receiver for agent lifecycle hooks.
//!
//! A managed hook script that Tempest installs into each agent's own config
//! (see `src/lib/agentHooks/`) POSTs one event per turn boundary / tool call /
//! permission prompt to `http://127.0.0.1:<port>/hook/<agent>`. This module is a
//! **dumb, secure pipe**: it authenticates the request, reads which Tempest
//! session it belongs to (echoed back from the `TEMPEST_SESSION` env we inject
//! at spawn), and forwards the raw agent payload to the frontend as an
//! `agent-hook` event. All per-agent parsing lives in TypeScript next to the
//! agent registry — Rust never interprets the payload.
//!
//! The port is ephemeral and the token is per-run, both published to
//! `~/.tempest/hooks/endpoint.{env,cmd}` so a hook script re-sources the current
//! values even after the app restarts under a still-live PTY.

use std::io::Read;
use std::path::Path;
use tauri::{AppHandle, Emitter};

/// Hard cap on a forwarded payload. Tool outputs can be large but a status hook
/// never needs more; anything past this is a malformed or hostile poster.
const MAX_BODY_BYTES: u64 = 1024 * 1024;

#[derive(Clone, serde::Serialize)]
struct HookEvent {
    agent: String,
    session: String,
    /// Lifecycle event name, when the script conveys it out-of-band via the
    /// X-Tempest-Event header (agents like Antigravity whose payload doesn't
    /// carry it). Empty when the event lives inside the payload itself.
    event: String,
    /// Raw agent payload (JSON text as the agent emitted it). Parsed in TS.
    body: String,
}

/// `~/.tempest/hooks` — holds the managed scripts, agent plugins, and the
/// endpoint files. Shared with the TS installer, which computes the same path
/// from the home dir.
pub fn hooks_dir() -> std::path::PathBuf {
    super::global_home().join(".tempest").join("hooks")
}

/// Atomic write (temp + rename) with mkdir -p, a same-content skip, and an
/// optional exec bit on unix. Backs both the endpoint files here and the
/// `hooks_write_atomic` command the installer uses for scripts and configs.
#[cfg_attr(not(unix), allow(unused_variables))]
pub fn write_atomic(path: &Path, contents: &str, executable: bool) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // Skip a no-op rewrite so re-installing on every launch neither churns the
    // disk nor rolls a backup forward over the last good copy.
    if let Ok(existing) = std::fs::read_to_string(path) {
        if existing == contents {
            #[cfg(unix)]
            if executable {
                set_executable(path)?;
            }
            return Ok(());
        }
    }
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "tmp".to_string());
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = path.with_file_name(format!(".{file_name}.{}.{nanos}.tmp", std::process::id()));
    std::fs::write(&tmp, contents)?;
    #[cfg(unix)]
    if executable {
        set_executable(&tmp)?;
    }
    // rename is atomic on the same filesystem; a crash mid-write leaves the
    // original intact and only an orphan temp behind.
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

#[cfg(unix)]
fn set_executable(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
}

/// 32 hex chars of OS entropy — the shared secret a poster must present so a
/// stray local process can't spoof agent status.
fn random_token() -> String {
    let mut buf = [0u8; 16];
    if getrandom::getrandom(&mut buf).is_err() {
        // Entropy failure is near-impossible; fall back to a time+pid seed so the
        // server still starts (degrades auth strength, never availability).
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let seed = nanos ^ (std::process::id() as u128);
        return format!("{seed:032x}");
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// Length-independent equality so token verification doesn't leak the secret
/// through response timing. Loopback makes this near-paranoia, but it's cheap.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

fn write_endpoint_files(dir: &Path, port: u16, token: &str) {
    // POSIX `. endpoint.env` sources these; the shell reads KEY=VALUE lines.
    let env = format!("TEMPEST_HOOK_PORT={port}\nTEMPEST_HOOK_TOKEN={token}\n");
    let _ = write_atomic(&dir.join("endpoint.env"), &env, false);
    // cmd.exe `call endpoint.cmd` needs `set KEY=VALUE` with CRLF.
    let cmd = format!("set TEMPEST_HOOK_PORT={port}\r\nset TEMPEST_HOOK_TOKEN={token}\r\n");
    let _ = write_atomic(&dir.join("endpoint.cmd"), &cmd, false);
}

/// Start the loopback hook server. Best-effort: a bind failure logs and returns,
/// leaving sessions on the PTY-scraping fallback — status degrades, never breaks.
pub fn start(app: AppHandle) {
    let dir = hooks_dir();
    let _ = std::fs::create_dir_all(&dir);
    let token = random_token();

    let server = match tiny_http::Server::http("127.0.0.1:0") {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[agent-hooks] failed to bind loopback server: {e}");
            return;
        }
    };
    let port = match server.server_addr().to_ip() {
        Some(addr) => addr.port(),
        None => {
            eprintln!("[agent-hooks] server bound to a non-IP address");
            return;
        }
    };
    write_endpoint_files(&dir, port, &token);

    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            handle_request(&app, &token, request);
        }
    });
}

// Takes the request by value: `Request::respond` consumes it, and each branch
// below responds exactly once before returning.
fn handle_request(app: &AppHandle, token: &str, mut request: tiny_http::Request) {
    if *request.method() != tiny_http::Method::Post {
        let _ = request.respond(tiny_http::Response::empty(404));
        return;
    }
    // URL is `/hook/<agent>`; agent selects the TS adapter.
    let agent = request
        .url()
        .strip_prefix("/hook/")
        .map(|a| a.split(['?', '/']).next().unwrap_or("").to_string())
        .unwrap_or_default();
    if agent.is_empty() {
        let _ = request.respond(tiny_http::Response::empty(404));
        return;
    }

    let mut got_token: Option<String> = None;
    let mut session: Option<String> = None;
    let mut event = String::new();
    for header in request.headers() {
        let field = header.field.as_str().as_str();
        if field.eq_ignore_ascii_case("x-tempest-token") {
            got_token = Some(header.value.as_str().to_string());
        } else if field.eq_ignore_ascii_case("x-tempest-session") {
            session = Some(header.value.as_str().to_string());
        } else if field.eq_ignore_ascii_case("x-tempest-event") {
            event = header.value.as_str().to_string();
        }
    }

    if !got_token.map(|t| constant_time_eq(&t, token)).unwrap_or(false) {
        let _ = request.respond(tiny_http::Response::empty(403));
        return;
    }
    let session = match session {
        Some(s) if !s.is_empty() => s,
        // An unattributed hook can't be routed to a session; drop it.
        _ => {
            let _ = request.respond(tiny_http::Response::empty(400));
            return;
        }
    };

    let mut body = String::new();
    let _ = request
        .as_reader()
        .take(MAX_BODY_BYTES)
        .read_to_string(&mut body);

    let _ = app.emit(
        "agent-hook",
        HookEvent {
            agent,
            session,
            event,
            body,
        },
    );
    let _ = request.respond(tiny_http::Response::empty(200));
}
