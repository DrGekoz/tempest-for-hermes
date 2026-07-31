//! Per-branch dev-server hostnames — the second half of the service proxy.
//!
//! v0.1.7 gave each worktree a deterministic port (`servicePort.ts`) so parallel
//! dev servers stop colliding. That fixes the collision but leaves you reaching a
//! branch at an opaque `localhost:3417`. This adds the *stable hostname*: a tiny
//! loopback reverse proxy on a fixed port that routes `<slug>.localhost` to the
//! branch's real dev port, so every worktree is reachable at a URL that says
//! which branch it is.
//!
//! `*.localhost` resolves to 127.0.0.1 in every modern browser (and WebView2)
//! with zero OS config — no hosts file, no mDNS, no admin. So the only moving
//! part is the routing.
//!
//! **Design: peek the Host, then splice.** We parse only the first request's
//! header block to learn the target, then dumb-pipe the TCP connection both ways.
//! Every request on one connection shares an origin, so one peek suffices — and
//! raw byte copying carries keep-alive, chunked bodies, and WebSocket/HMR
//! upgrades transparently, with no HTTP semantics to get wrong. No async runtime,
//! no new dependency: std::net + a thread per connection, matching agent_hooks.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Fixed so the URL is stable across restarts. 7000 is conventionally free.
/// ponytail: hard-coded port; make it a setting only if a collision is reported.
pub const PROXY_PORT: u16 = 7000;

/// Slug → dev-server port. Shared with the `register_service_route` command,
/// which the frontend calls wherever it already computes a worktree's port.
pub type Routes = Arc<Mutex<HashMap<String, u16>>>;

const HEADER_CAP: usize = 32 * 1024; // a request head past this is malformed/hostile

/// Binds synchronously so the caller learns success now; `true` means hostnames
/// will route. On conflict it's dormant (like agent_hooks) — direct
/// `localhost:<port>` still works — and callers should keep the direct URL.
pub fn start(routes: Routes) -> bool {
    let listener = match TcpListener::bind(("127.0.0.1", PROXY_PORT)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[service-proxy] :{PROXY_PORT} unavailable, hostnames disabled: {e}");
            return false;
        }
    };
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let routes = routes.clone();
            std::thread::spawn(move || handle(stream, &routes));
        }
    });
    true
}

fn handle(mut client: TcpStream, routes: &Routes) {
    // Bound the header read so a silent connection can't pin a thread forever.
    let _ = client.set_read_timeout(Some(Duration::from_secs(10)));

    let mut head = Vec::new();
    let mut tmp = [0u8; 8192];
    loop {
        let n = match client.read(&mut tmp) {
            Ok(0) => return,
            Ok(n) => n,
            Err(_) => return,
        };
        head.extend_from_slice(&tmp[..n]);
        if find_subslice(&head, b"\r\n\r\n").is_some() || head.len() > HEADER_CAP {
            break;
        }
    }

    let port = host_slug(&head).and_then(|s| routes.lock().ok().and_then(|r| r.get(&s).copied()));
    let port = match port {
        Some(p) => p,
        None => {
            let _ = client.write_all(
                b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
            return;
        }
    };

    let upstream = match TcpStream::connect(("127.0.0.1", port)) {
        Ok(u) => u,
        Err(_) => {
            // Registered but nothing listening yet (dev server not started).
            let _ = client.write_all(
                b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
            return;
        }
    };

    // Long-lived (WebSocket/HMR) from here — no idle deadline.
    let _ = client.set_read_timeout(None);
    let (mut c_read, mut c_write) = match (client.try_clone(), client) {
        (Ok(a), b) => (b, a),
        _ => return,
    };
    let (mut u_read, mut u_write) = match (upstream.try_clone(), upstream) {
        (Ok(a), b) => (b, a),
        _ => return,
    };

    // Replay the bytes we already consumed peeking the Host, then pipe both ways.
    if u_write.write_all(&head).is_err() {
        return;
    }
    let pump = std::thread::spawn(move || {
        let _ = std::io::copy(&mut u_read, &mut c_write);
        let _ = c_write.shutdown(std::net::Shutdown::Write);
    });
    let _ = std::io::copy(&mut c_read, &mut u_write);
    let _ = u_write.shutdown(std::net::Shutdown::Write);
    let _ = pump.join();
}

/// The subdomain of the `Host` header, lowercased: `Feat-Login.localhost:7000`
/// → `feat-login`. None if there is no Host or no subdomain label.
fn host_slug(head: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(head.get(..head.len().min(HEADER_CAP))?).ok()?;
    for line in text.split("\r\n") {
        let Some((name, value)) = line.split_once(':') else { continue };
        if name.eq_ignore_ascii_case("host") {
            let host = value.trim().split(':').next().unwrap_or("").to_ascii_lowercase();
            let slug = host.split('.').next().unwrap_or("");
            return if slug.is_empty() || slug == "localhost" { None } else { Some(slug.to_string()) };
        }
    }
    None
}

fn find_subslice(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_from_host() {
        let mk = |h: &str| host_slug(format!("GET / HTTP/1.1\r\nHost: {h}\r\n\r\n").as_bytes());
        assert_eq!(mk("feat-login.localhost:7000"), Some("feat-login".into()));
        assert_eq!(mk("Feat-Login.localhost"), Some("feat-login".into())); // case-folded
        assert_eq!(mk("localhost:7000"), None); // no subdomain
        assert_eq!(mk("127.0.0.1:7000"), Some("127".into())); // ip → harmless miss on lookup
        assert_eq!(host_slug(b"GET / HTTP/1.1\r\n\r\n"), None); // no Host
    }
}
