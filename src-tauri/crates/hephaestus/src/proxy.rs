/// In-process HTTPS CONNECT proxy shared by all platforms.
///
/// Sandboxed processes route all outbound traffic through this proxy via the
/// `http_proxy` / `https_proxy` environment variables injected by
/// [`Isolate::prepare`](crate::Isolate::prepare). The proxy enforces
/// [`NetworkPolicy`](crate::NetworkPolicy) from the environment spec.
///
/// # Protocol
///
/// - **CONNECT tunnels**: hostname extracted from the request line, matched
///   against the policy allow-list, then proxied as a transparent byte-pipe
///   on success, or returned as `HTTP 407` with an `X-Hephaestus-Block`
///   header on failure.
/// - **Plain HTTP**: `Host` header checked against the policy, then forwarded.
///
/// The proxy binds to `127.0.0.1:0` (kernel-assigned port) so there are
/// no port collisions between concurrent sandboxed environments.
///
/// In [`Monitor`](crate::SandboxMode::Monitor) mode all requests are logged
/// but `407` is never returned.
use std::io::{self, BufRead, BufReader, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::thread;
use std::time::Duration;

use crate::{HephaestusError, NetworkPolicy, SandboxMode};

/// How long a client has to send its request line and headers before the
/// connection is dropped. Bounds a slow-loris to one thread.
///
/// It applies to the *handshake only* — [`relay`] clears it before tunnelling.
#[cfg(not(test))]
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(test)]
const HANDSHAKE_TIMEOUT: Duration = Duration::from_millis(300);

// ─── ProxyConfig ─────────────────────────────────────────────────────────────

/// Configuration for a [`ConnectProxy`] instance.
///
/// Build one per isolation environment and pass to [`ConnectProxy::start`].
#[derive(Debug, Clone)]
pub struct ProxyConfig {
    /// Network policy to enforce.
    pub policy: NetworkPolicy,
    /// How violations are handled.
    pub mode: SandboxMode,
}

impl ProxyConfig {
    /// A config that enforces `policy` (blocks disallowed hosts).
    pub fn enforce(policy: NetworkPolicy) -> Self {
        Self { policy, mode: SandboxMode::Enforce }
    }

    /// A config that monitors `policy` (logs violations but never blocks).
    pub fn monitor(policy: NetworkPolicy) -> Self {
        Self { policy, mode: SandboxMode::Monitor }
    }
}

// ─── ConnectProxy ─────────────────────────────────────────────────────────────

/// An in-process HTTPS CONNECT proxy.
///
/// Runs on a background thread. Shut down by dropping the struct, which
/// signals the thread via an `AtomicBool` and joins it.
pub struct ConnectProxy {
    port: u16,
    shutdown: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl ConnectProxy {
    /// Bind to `127.0.0.1:0` and start the accept loop on a background thread.
    ///
    /// Host patterns in `config.policy` are compiled once at start time.
    /// Returns the bound proxy on success.
    ///
    /// # Errors
    ///
    /// Returns [`HephaestusError::Proxy`] if the socket could not be bound or
    /// the accept thread could not be spawned.
    pub fn start(config: ProxyConfig) -> Result<Self, HephaestusError> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|e| HephaestusError::proxy(format!("bind: {e}")))?;

        let port = listener
            .local_addr()
            .map_err(|e| HephaestusError::proxy(format!("local_addr: {e}")))?
            .port();

        // Non-blocking so the accept loop can poll the shutdown flag.
        listener
            .set_nonblocking(true)
            .map_err(|e| HephaestusError::proxy(format!("set_nonblocking: {e}")))?;

        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_bg = Arc::clone(&shutdown);
        let policy = Arc::new(config.policy);
        let mode = config.mode;

        let thread = thread::Builder::new()
            .name(format!("hephaestus-proxy-{port}"))
            .spawn(move || accept_loop(listener, policy, mode, shutdown_bg))
            .map_err(|e| HephaestusError::proxy(format!("thread spawn: {e}")))?;

        Ok(Self { port, shutdown, thread: Some(thread) })
    }

    /// The loopback port this proxy is listening on.
    ///
    /// Set this as `http_proxy=http://127.0.0.1:{port}` on sandboxed processes.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Returns the full proxy URL for use as `http_proxy` / `https_proxy`.
    ///
    /// Format: `http://127.0.0.1:{port}`
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

impl Drop for ConnectProxy {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

// ─── Accept loop ──────────────────────────────────────────────────────────────

fn accept_loop(
    listener: TcpListener,
    policy: Arc<NetworkPolicy>,
    mode: SandboxMode,
    shutdown: Arc<AtomicBool>,
) {
    loop {
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        match listener.accept() {
            Ok((stream, _)) => {
                // Winsock hands the accepted socket the listener's non-blocking
                // mode; POSIX does not. The listener is non-blocking only so the
                // loop above can poll `shutdown`, and every handler below is
                // written against a blocking socket — inherited, it makes each
                // read return `WouldBlock` instantly, which `io::copy` reports as
                // an error and the relay turns into an immediate teardown. The
                // client sees the tunnel abort mid-handshake as ECONNRESET.
                let _ = stream.set_nonblocking(false);

                let policy = Arc::clone(&policy);
                thread::spawn(move || {
                    let _ = handle_connection(stream, &policy, mode);
                });
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(50));
            }
            Err(_) => {
                thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

// ─── Connection handling ──────────────────────────────────────────────────────

fn handle_connection(
    stream: TcpStream,
    policy: &NetworkPolicy,
    mode: SandboxMode,
) -> io::Result<()> {
    stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT))?;
    stream.set_write_timeout(Some(HANDSHAKE_TIMEOUT))?;

    // Clone before the BufReader consumes the stream.
    let write_half = stream.try_clone()?;
    let mut reader = BufReader::new(stream);

    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let request_line = request_line.trim_end_matches(|c| c == '\r' || c == '\n');

    if request_line.is_empty() {
        return Ok(());
    }

    let mut parts = request_line.splitn(3, ' ');
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");

    if method.eq_ignore_ascii_case("CONNECT") {
        handle_connect(reader, write_half, target, policy, mode)
    } else {
        handle_plain_http(reader, write_half, method, target, policy, mode)
    }
}

// ─── CONNECT tunnel ───────────────────────────────────────────────────────────

fn handle_connect(
    mut reader: BufReader<TcpStream>,
    mut write_half: TcpStream,
    target: &str,
    policy: &NetworkPolicy,
    mode: SandboxMode,
) -> io::Result<()> {
    let host = host_from_connect_target(target);
    drain_headers(&mut reader)?;

    // Any bytes BufReader pulled past the blank line (shouldn't happen for
    // CONNECT but safe to handle).
    let buffered: Vec<u8> = reader.buffer().to_vec();
    let read_half = reader.into_inner();

    if !policy_allows(host, policy, mode) {
        // `&mut { write_half }` would move into a temporary dropped at the end of
        // the statement, closing the socket the instant the body is written — with
        // client bytes still unread, Windows answers that with an RST and the
        // explanatory body never arrives.
        write_deny(&mut write_half, host);
        return Ok(());
    }

    let mut upstream = match TcpStream::connect(target) {
        Ok(s) => s,
        Err(e) => {
            // Returning here would drop the client socket with nothing written,
            // which a client reports as a bare connection reset. Name the reason
            // instead: an upstream failure is not a policy decision.
            write_gateway_error(&mut write_half, host, &e.to_string());
            return Ok(());
        }
    };

    // Acknowledge the tunnel to the client.
    write_half.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")?;

    // Forward any bytes the BufReader pre-fetched.
    if !buffered.is_empty() {
        upstream.write_all(&buffered)?;
    }

    relay(read_half, write_half, upstream)
}

// ─── Plain HTTP forwarding ────────────────────────────────────────────────────

fn handle_plain_http(
    mut reader: BufReader<TcpStream>,
    mut write_half: TcpStream,
    method: &str,
    target: &str,
    policy: &NetworkPolicy,
    mode: SandboxMode,
) -> io::Result<()> {
    let headers = collect_headers(&mut reader)?;

    let host = headers
        .iter()
        .find(|h| h.to_ascii_lowercase().starts_with("host:"))
        .and_then(|h| h.splitn(2, ':').nth(1))
        .map(|s| s.trim())
        .unwrap_or("");

    if !policy_allows(host, policy, mode) {
        write_deny(&mut write_half, host);
        return Ok(());
    }

    let upstream_addr = target_to_addr(target, 80);
    let mut upstream = TcpStream::connect(upstream_addr)?;

    // Forward the original request.
    let forwarded = format!("{} {} HTTP/1.1\r\n{}\r\n\r\n", method, target, headers.join("\r\n"));
    upstream.write_all(forwarded.as_bytes())?;

    // Forward any already-buffered body bytes.
    let body_prefix: Vec<u8> = reader.buffer().to_vec();
    if !body_prefix.is_empty() {
        upstream.write_all(&body_prefix)?;
    }
    let read_half = reader.into_inner();

    relay(read_half, write_half, upstream)
}

// ─── Bidirectional relay ──────────────────────────────────────────────────────

/// Relay bytes between `client` and `upstream` until either side closes.
fn relay(client_r: TcpStream, client_w: TcpStream, upstream: TcpStream) -> io::Result<()> {
    // [`HANDSHAKE_TIMEOUT`] must not survive into the tunnel. A tunnel is idle
    // in one direction for as long as the far end takes to answer, and an agent
    // streaming a long completion leaves client→upstream silent for minutes. A
    // read timeout there ends that pump permanently — the tunnel stays half
    // alive, so the next request the client sends on the reused connection is
    // never forwarded and the agent reports an opaque API error.
    let _ = client_r.set_read_timeout(None);
    let _ = client_r.set_write_timeout(None);
    let _ = client_w.set_read_timeout(None);
    let _ = client_w.set_write_timeout(None);

    let upstream_r = upstream.try_clone()?;
    let upstream_w = upstream;

    // client → upstream
    let t1 = thread::spawn(move || {
        let mut r = client_r;
        let mut w = upstream_w;
        let _ = io::copy(&mut r, &mut w);
        // Propagate EOF as a half-close. `try_clone` hands out a second
        // descriptor onto the same socket, so dropping this end sends nothing —
        // without an explicit shutdown the opposite thread blocks forever and
        // the connection leaks for the life of the process.
        let _ = w.shutdown(Shutdown::Write);
    });

    // upstream → client
    let t2 = thread::spawn(move || {
        let mut r = upstream_r;
        let mut w = client_w;
        let _ = io::copy(&mut r, &mut w);
        let _ = w.shutdown(Shutdown::Write);
    });

    let _ = t1.join();
    let _ = t2.join();
    Ok(())
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn host_from_connect_target(target: &str) -> &str {
    match target.rfind(':') {
        Some(i) => &target[..i],
        None => target,
    }
}

fn policy_allows(host: &str, policy: &NetworkPolicy, mode: SandboxMode) -> bool {
    if mode == SandboxMode::Monitor {
        // Log-only: always forward, never block.
        return true;
    }
    policy.is_allowed(host)
}

/// Refuse the request with a self-identifying response.
///
/// `403` rather than `407`: the request is denied by policy, not missing proxy
/// credentials. `407` makes curl and other clients prompt for a proxy password
/// and retry, which turns a clear policy block into a confusing auth loop.
///
/// The host and the reason are echoed in the body so an agent CLI that reads
/// the response can tell the user exactly which host to add to the allow-list,
/// rather than surfacing an opaque connection failure.
fn write_deny(stream: &mut TcpStream, host: &str) {
    // The only trace a block leaves; without it a policy denial reaches the user
    // as an unexplained agent-side network failure.
    eprintln!("[hephaestus] network policy blocked {host}");
    let body = format!(
        "Blocked by Hephaestus sandbox.\n\n\
         Host: {host}\n\
         This environment's network policy does not permit traffic to this host.\n\n\
         To unblock, add it to the allowed hosts for this project \
         (wildcards accepted, e.g. `*.{host}`), or set the network policy to \
         permissive.\n"
    );
    let header = format!(
        "HTTP/1.1 403 Blocked by sandbox policy\r\n\
         X-Hephaestus-Block: true\r\n\
         X-Hephaestus-Block-Host: {host}\r\n\
         Content-Type: text/plain; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body.as_bytes());
}

/// Report an upstream connection failure as a `502` rather than a silent close.
///
/// Without this the agent sees only a reset socket and cannot tell a sandbox
/// problem apart from a network one.
fn write_gateway_error(stream: &mut TcpStream, host: &str, reason: &str) {
    eprintln!("[hephaestus] upstream {host} unreachable: {reason}");
    let body = format!("Hephaestus could not reach {host}.\n\n{reason}\n");
    let header = format!(
        "HTTP/1.1 502 Bad Gateway\r\n\
         Content-Type: text/plain; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body.as_bytes());
}

fn drain_headers(reader: &mut BufReader<TcpStream>) -> io::Result<()> {
    let mut line = String::new();
    loop {
        line.clear();
        reader.read_line(&mut line)?;
        if line == "\r\n" || line == "\n" || line.is_empty() {
            break;
        }
    }
    Ok(())
}

fn collect_headers(reader: &mut BufReader<TcpStream>) -> io::Result<Vec<String>> {
    let mut headers = Vec::new();
    let mut line = String::new();
    loop {
        line.clear();
        reader.read_line(&mut line)?;
        let trimmed = line.trim_end_matches(|c| c == '\r' || c == '\n');
        if trimmed.is_empty() {
            break;
        }
        headers.push(trimmed.to_string());
    }
    Ok(headers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    /// A CONNECT tunnel must survive a gap longer than [`HANDSHAKE_TIMEOUT`] in
    /// either direction — the shape of every streaming agent request.
    #[test]
    fn tunnel_outlives_the_handshake_timeout() {
        // Upstream: echo one line, pause past the timeout, echo the next.
        let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        thread::spawn(move || {
            let (sock, _) = upstream.accept().unwrap();
            let mut w = sock.try_clone().unwrap();
            let mut r = BufReader::new(sock);
            let mut line = String::new();
            while r.read_line(&mut line).unwrap() > 0 {
                w.write_all(line.as_bytes()).unwrap();
                line.clear();
            }
        });

        let proxy = ConnectProxy::start(ProxyConfig::enforce(NetworkPolicy::allow_all())).unwrap();
        let mut client = TcpStream::connect(("127.0.0.1", proxy.port())).unwrap();
        write!(client, "CONNECT {upstream_addr} HTTP/1.1\r\n\r\n").unwrap();

        let mut reader = BufReader::new(client.try_clone().unwrap());
        let mut status = String::new();
        reader.read_line(&mut status).unwrap();
        assert!(status.contains("200"), "tunnel refused: {status}");
        drain_headers(&mut reader).unwrap();

        client.write_all(b"first\n").unwrap();
        let mut echoed = String::new();
        reader.read_line(&mut echoed).unwrap();
        assert_eq!(echoed, "first\n");

        // The gap that used to kill the client→upstream pump for good.
        thread::sleep(HANDSHAKE_TIMEOUT * 3);

        client.write_all(b"second\n").unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        echoed.clear();
        reader.read_line(&mut echoed).unwrap();
        assert_eq!(echoed, "second\n", "tunnel died while idle");
    }

    /// Closing the client must tear the tunnel down rather than park a thread on
    /// a socket `try_clone` keeps open.
    #[test]
    fn client_close_propagates_to_upstream() {
        let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let (mut sock, _) = upstream.accept().unwrap();
            let mut buf = Vec::new();
            // Returns only once the proxy forwards the client's EOF.
            sock.read_to_end(&mut buf).unwrap();
            tx.send(()).unwrap();
        });

        let proxy = ConnectProxy::start(ProxyConfig::enforce(NetworkPolicy::allow_all())).unwrap();
        let mut client = TcpStream::connect(("127.0.0.1", proxy.port())).unwrap();
        write!(client, "CONNECT {upstream_addr} HTTP/1.1\r\n\r\n").unwrap();
        let mut reader = BufReader::new(client.try_clone().unwrap());
        let mut status = String::new();
        reader.read_line(&mut status).unwrap();
        drain_headers(&mut reader).unwrap();

        client.shutdown(Shutdown::Write).unwrap();
        rx.recv_timeout(Duration::from_secs(5))
            .expect("client EOF never reached upstream");
    }

    #[test]
    fn blocked_host_gets_403() {
        let proxy = ConnectProxy::start(ProxyConfig::enforce(NetworkPolicy::deny_all())).unwrap();
        let mut client = TcpStream::connect(("127.0.0.1", proxy.port())).unwrap();
        write!(client, "CONNECT blocked.example.com:443 HTTP/1.1\r\n\r\n").unwrap();
        let mut status = String::new();
        BufReader::new(client).read_line(&mut status).unwrap();
        assert!(status.contains("403"), "expected a policy block: {status}");
    }
}

fn target_to_addr(target: &str, default_port: u16) -> String {
    let stripped = target
        .strip_prefix("http://")
        .or_else(|| target.strip_prefix("https://"))
        .unwrap_or(target);
    let host_port = stripped.splitn(2, '/').next().unwrap_or(stripped);
    if host_port.contains(':') {
        host_port.to_string()
    } else {
        format!("{host_port}:{default_port}")
    }
}
