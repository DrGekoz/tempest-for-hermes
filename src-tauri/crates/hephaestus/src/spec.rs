use std::path::PathBuf;
use serde::{Deserialize, Serialize};

use crate::HephaestusError;

// ─── SandboxMode ─────────────────────────────────────────────────────────────

/// How the isolation backend handles policy violations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[non_exhaustive]
pub enum SandboxMode {
    /// Sandbox is disabled. The process runs with full host permissions.
    Off,

    /// Violations are logged to the event stream but never blocked.
    ///
    /// Use this to build an allow-list before switching to [`Enforce`](Self::Enforce).
    Monitor,

    /// All violations are blocked (deny-default policy).
    ///
    /// This is the production mode and the default.
    #[default]
    Enforce,
}

// ─── HostPattern ─────────────────────────────────────────────────────────────

/// A host pattern used by [`NetworkPolicy`] to gate outbound connections.
///
/// # String conversion
///
/// `HostPattern` implements `From<&str>` and `From<String>` with the
/// following conventions:
///
/// | Input              | Parsed as                          |
/// |--------------------|------------------------------------|
/// | `**.example.com`   | `Suffix("example.com")`            |
/// | `*.example.com`    | `Subdomain("example.com")`         |
/// | anything else      | `Exact(value)`                     |
///
/// Use the explicit constructors when you need `Regex`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub enum HostPattern {
    /// Case-insensitive exact match against the full hostname.
    Exact(String),

    /// Matches any single-level subdomain of `domain`.
    ///
    /// `Subdomain("example.com")` matches `api.example.com` but not
    /// `deep.api.example.com`.
    Subdomain(String),

    /// Matches `domain` itself and any subdomain at any depth.
    ///
    /// `Suffix("example.com")` matches `example.com`, `api.example.com`,
    /// and `deep.api.example.com`.
    Suffix(String),

    /// An anchored regular expression matched against the full hostname.
    ///
    /// The pattern is implicitly anchored at both ends (`^...$`).
    Regex(String),
}

impl HostPattern {
    /// Exact hostname match.
    pub fn exact(host: impl Into<String>) -> Self {
        Self::Exact(host.into())
    }

    /// Single-level subdomain wildcard (`*.domain`).
    pub fn subdomain(domain: impl Into<String>) -> Self {
        Self::Subdomain(domain.into())
    }

    /// Any-depth suffix match (`**.domain`).
    pub fn suffix(domain: impl Into<String>) -> Self {
        Self::Suffix(domain.into())
    }

    /// Anchored regex pattern.
    pub fn regex(pattern: impl Into<String>) -> Self {
        Self::Regex(pattern.into())
    }
}

impl From<&str> for HostPattern {
    fn from(s: &str) -> Self {
        if let Some(domain) = s.strip_prefix("**.") {
            Self::Suffix(domain.to_string())
        } else if let Some(domain) = s.strip_prefix("*.") {
            Self::Subdomain(domain.to_string())
        } else {
            Self::Exact(s.to_string())
        }
    }
}

impl From<String> for HostPattern {
    fn from(s: String) -> Self {
        Self::from(s.as_str())
    }
}

// ─── NetworkPolicy ────────────────────────────────────────────────────────────

/// Network policy governing outbound connections from an isolation environment.
///
/// The loopback address and the in-process CONNECT proxy are always implicitly
/// reachable regardless of this policy.
///
/// # Example
///
/// ```
/// use hephaestus::{NetworkPolicy, HostPattern};
///
/// let policy = NetworkPolicy::deny_all()
///     .allow(HostPattern::suffix("anthropic.com"))
///     .allow(HostPattern::suffix("github.com"))
///     .allow("registry.npmjs.org");  // From<&str> into HostPattern::Exact
/// ```
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NetworkPolicy {
    /// Patterns of hosts the sandboxed process may reach.
    ///
    /// Consulted only when `default_allow` is `false`. An empty list then
    /// blocks all outbound traffic (except the loopback proxy).
    pub allowed: Vec<HostPattern>,

    /// Patterns of hosts the sandboxed process may never reach.
    ///
    /// Evaluated *before* `allowed`, so a block always wins — including when
    /// `default_allow` is `true`.
    pub blocked: Vec<HostPattern>,

    /// Baseline posture.
    ///
    /// `false` (the default) is deny-by-default: only `allowed` gets through.
    /// `true` is allow-by-default: everything gets through except `blocked`.
    pub default_allow: bool,
}

impl NetworkPolicy {
    /// A policy that blocks all outbound traffic.
    pub fn deny_all() -> Self {
        Self { allowed: vec![], blocked: vec![], default_allow: false }
    }

    /// A policy that allows all outbound traffic.
    ///
    /// Use with care — this gives the process unrestricted network access.
    /// Prefer an explicit allow-list in production.
    pub fn allow_all() -> Self {
        Self { allowed: vec![], blocked: vec![], default_allow: true }
    }

    /// Add a host pattern to the allow-list.
    ///
    /// Accepts anything that converts to [`HostPattern`], including `&str`
    /// (parsed as exact/subdomain/suffix based on prefix).
    pub fn allow(mut self, pattern: impl Into<HostPattern>) -> Self {
        self.allowed.push(pattern.into());
        self
    }

    /// Add a host pattern to the block-list. Blocks beat allows.
    pub fn block(mut self, pattern: impl Into<HostPattern>) -> Self {
        self.blocked.push(pattern.into());
        self
    }

    /// Set the baseline posture. See [`default_allow`](Self::default_allow).
    #[must_use]
    pub fn with_default_allow(mut self, allow: bool) -> Self {
        self.default_allow = allow;
        self
    }

    /// Returns `true` if this policy permits traffic to `host`.
    ///
    /// `host` may carry a port (`example.com:8443`) and/or IPv6 brackets
    /// (`[::1]`); both are normalized away before matching. Matching is
    /// case-insensitive.
    ///
    /// `Regex` patterns are **not** evaluated — matching one always returns
    /// `false`. The sole exception is the `".*"` sentinel, treated as a blanket
    /// allow. Hephaestus deliberately carries no regex dependency; use
    /// `Exact` / `Subdomain` / `Suffix`, which cover every pattern the
    /// `From<&str>` parser can produce.
    pub fn is_allowed(&self, host: &str) -> bool {
        let host = normalize_host(host);

        // A block always wins, in either posture.
        if self.blocked.iter().any(|p| host_matches(p, &host)) {
            return false;
        }
        if self.default_allow {
            return true;
        }
        self.allowed.iter().any(|p| host_matches(p, &host))
    }
}

/// Strip IPv6 brackets and any trailing `:port` so patterns match the bare
/// hostname. A trailing colon group is only treated as a port when it is
/// all-digits, so bare IPv6 literals survive intact.
fn normalize_host(host: &str) -> String {
    let host = host.trim();

    // `[::1]:443` / `[::1]` → `::1`
    if let Some(rest) = host.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            return rest[..end].to_ascii_lowercase();
        }
    }

    match host.rsplit_once(':') {
        Some((h, port))
            if !port.is_empty()
                && port.bytes().all(|b| b.is_ascii_digit())
                // A remaining colon means this is a bare IPv6 literal
                // (`fe80::1`), not `host:port` — its final group is an address
                // group, not a port. Ports on IPv6 must be bracketed.
                && !h.contains(':') =>
        {
            h.to_ascii_lowercase()
        }
        _ => host.to_ascii_lowercase(),
    }
}

/// Match one pattern against an already-normalized (lowercase, port-free) host.
fn host_matches(pattern: &HostPattern, host: &str) -> bool {
    match pattern {
        HostPattern::Exact(h) => h.trim().eq_ignore_ascii_case(host),

        // `*.example.com` — exactly one extra label.
        HostPattern::Subdomain(domain) => {
            let domain = domain.trim().to_ascii_lowercase();
            host.strip_suffix(&domain)
                .and_then(|prefix| prefix.strip_suffix('.'))
                .map(|sub| !sub.is_empty() && !sub.contains('.'))
                .unwrap_or(false)
        }

        // `**.example.com` — the apex or any depth beneath it.
        HostPattern::Suffix(domain) => {
            let domain = domain.trim().to_ascii_lowercase();
            host == domain || host.ends_with(&format!(".{domain}"))
        }

        // ".*" is the legacy allow-all sentinel; see `is_allowed` docs.
        HostPattern::Regex(r) if r == ".*" => true,
        HostPattern::Regex(_) => false,
    }
}

// ─── PathMount ────────────────────────────────────────────────────────────────

/// A filesystem path exposed inside an isolation environment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PathMount {
    /// The host path to expose inside the sandbox.
    pub path: PathBuf,

    /// Whether the sandboxed process may write to this path.
    pub writable: bool,

    /// When `true`, this mount is silently skipped if `path` does not exist
    /// on the host. When `false`, provisioning fails if the path is absent.
    pub optional: bool,
}

impl PathMount {
    /// Mount `path` with read-write access.
    pub fn rw(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into(), writable: true, optional: false }
    }

    /// Mount `path` with read-only access.
    pub fn ro(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into(), writable: false, optional: false }
    }

    /// Mark this mount as optional (silently skipped if the path does not exist).
    #[must_use]
    pub fn optional(mut self) -> Self {
        self.optional = true;
        self
    }
}

// ─── ResourceLimits ──────────────────────────────────────────────────────────

/// Caller-defined resource quotas for an isolation unit.
///
/// All fields are optional. Unset fields are left at OS defaults.
/// Construct via [`ResourceLimits::builder()`] for ergonomic chaining.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ResourceLimits {
    /// Maximum resident memory in bytes.
    ///
    /// Maps to cgroups v2 `memory.max` on Linux and
    /// `JOBOBJECT_EXTENDED_LIMIT_INFORMATION.ProcessMemoryLimit` on Windows.
    pub max_memory_bytes: Option<u64>,

    /// CPU scheduling weight (1–10 000). Higher values receive proportionally
    /// more CPU time relative to other cgroups or Job Objects.
    pub cpu_weight: Option<u32>,

    /// Maximum number of concurrent processes in the isolation unit.
    ///
    /// Maps to `RLIMIT_NPROC` on Unix and
    /// `JOBOBJECT_BASIC_LIMIT_INFORMATION.ActiveProcessLimit` on Windows.
    pub max_processes: Option<u32>,

    /// Maximum total bytes the process tree may write to storage during
    /// its lifetime. Platform support varies.
    pub max_disk_write_bytes: Option<u64>,
}

impl ResourceLimits {
    /// Returns a builder for constructing limits ergonomically.
    pub fn builder() -> ResourceLimitsBuilder {
        ResourceLimitsBuilder::default()
    }
}

/// Builder for [`ResourceLimits`].
#[derive(Debug, Default)]
pub struct ResourceLimitsBuilder {
    inner: ResourceLimits,
}

impl ResourceLimitsBuilder {
    /// Set the memory limit in bytes.
    pub fn max_memory_bytes(mut self, bytes: u64) -> Self {
        self.inner.max_memory_bytes = Some(bytes);
        self
    }

    /// Set the CPU scheduling weight (1–10 000).
    pub fn cpu_weight(mut self, weight: u32) -> Self {
        self.inner.cpu_weight = Some(weight);
        self
    }

    /// Set the maximum number of concurrent processes.
    pub fn max_processes(mut self, n: u32) -> Self {
        self.inner.max_processes = Some(n);
        self
    }

    /// Set the maximum bytes the process tree may write to disk.
    pub fn max_disk_write_bytes(mut self, bytes: u64) -> Self {
        self.inner.max_disk_write_bytes = Some(bytes);
        self
    }

    /// Finalize the limits.
    pub fn build(self) -> ResourceLimits {
        self.inner
    }
}

// ─── EnvironmentSpec ─────────────────────────────────────────────────────────

/// Full specification for one isolation environment.
///
/// Construct via [`EnvironmentSpec::builder`]; direct struct construction is
/// intentionally disabled across crate boundaries via `#[non_exhaustive]`.
///
/// # Example
///
/// ```
/// use hephaestus::{EnvironmentSpec, PathMount, SandboxMode};
/// use std::path::PathBuf;
///
/// let spec = EnvironmentSpec::builder("ws-abc", "/home/user/project")
///     .mount(PathMount::rw("/home/user/.cargo").optional())
///     .allow_host("**.anthropic.com")
///     .allow_host("**.github.com")
///     .mode(SandboxMode::Enforce)
///     .build()
///     .unwrap();
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
#[non_exhaustive]
pub struct EnvironmentSpec {
    /// Stable identifier for this isolation unit.
    ///
    /// Used as the primary key for all OS-level resources Hephaestus
    /// provisions (profile files, Job Object names, cgroup paths, etc.).
    /// Must be unique within a single backend instance. In Tempest this is
    /// also the Atlas branch ID so the execution environment and the
    /// code-intelligence branch share one key.
    pub id: String,

    /// Root directory of the isolated workspace.
    ///
    /// Always mounted read-write. This is the working directory of the
    /// sandboxed process.
    pub root: PathBuf,

    /// Additional filesystem mounts inside the sandbox.
    pub mounts: Vec<PathMount>,

    /// Network policy governing outbound connections.
    pub network: NetworkPolicy,

    /// Caller-defined resource quotas.
    pub resources: ResourceLimits,

    /// How policy violations are handled.
    pub mode: SandboxMode,
}

impl EnvironmentSpec {
    /// Returns a builder for this spec.
    ///
    /// `id` must be non-empty. `root` must be an absolute path.
    /// These constraints are validated on [`EnvironmentSpecBuilder::build`].
    pub fn builder(
        id: impl Into<String>,
        root: impl Into<PathBuf>,
    ) -> EnvironmentSpecBuilder {
        EnvironmentSpecBuilder {
            id: id.into(),
            root: root.into(),
            mounts: vec![],
            network: NetworkPolicy::deny_all(),
            resources: ResourceLimits::default(),
            mode: SandboxMode::Enforce,
        }
    }
}

// ─── EnvironmentSpecBuilder ──────────────────────────────────────────────────

/// Builder for [`EnvironmentSpec`].
///
/// Obtained via [`EnvironmentSpec::builder`].
#[derive(Debug)]
pub struct EnvironmentSpecBuilder {
    id: String,
    root: PathBuf,
    mounts: Vec<PathMount>,
    network: NetworkPolicy,
    resources: ResourceLimits,
    mode: SandboxMode,
}

impl EnvironmentSpecBuilder {
    /// Add a single filesystem mount.
    pub fn mount(mut self, mount: PathMount) -> Self {
        self.mounts.push(mount);
        self
    }

    /// Add multiple filesystem mounts.
    pub fn mounts(mut self, mounts: impl IntoIterator<Item = PathMount>) -> Self {
        self.mounts.extend(mounts);
        self
    }

    /// Allow a host pattern.
    ///
    /// Accepts anything that converts to [`HostPattern`], including `&str`
    /// with prefix-based parsing (`**.foo.com`, `*.foo.com`, exact).
    pub fn allow_host(mut self, pattern: impl Into<HostPattern>) -> Self {
        self.network.allowed.push(pattern.into());
        self
    }

    /// Block a host pattern. Blocks are evaluated before allows, so this wins
    /// over both [`allow_host`](Self::allow_host) and an allow-by-default
    /// baseline.
    pub fn block_host(mut self, pattern: impl Into<HostPattern>) -> Self {
        self.network.blocked.push(pattern.into());
        self
    }

    /// Set the network baseline: `true` allows everything except blocked hosts,
    /// `false` (the default) denies everything except allowed hosts.
    pub fn network_default_allow(mut self, allow: bool) -> Self {
        self.network.default_allow = allow;
        self
    }

    /// Replace the entire network policy.
    pub fn network(mut self, policy: NetworkPolicy) -> Self {
        self.network = policy;
        self
    }

    /// Set resource quotas.
    pub fn resources(mut self, limits: ResourceLimits) -> Self {
        self.resources = limits;
        self
    }

    /// Set the sandbox mode.
    pub fn mode(mut self, mode: SandboxMode) -> Self {
        self.mode = mode;
        self
    }

    /// Finalize the spec.
    ///
    /// # Errors
    ///
    /// Returns [`HephaestusError::InvalidSpec`] if:
    /// - `id` is empty, or
    /// - `root` is not an absolute path.
    pub fn build(self) -> Result<EnvironmentSpec, HephaestusError> {
        if self.id.is_empty() {
            return Err(HephaestusError::invalid_spec("environment id must not be empty"));
        }
        if !self.root.is_absolute() {
            return Err(HephaestusError::invalid_spec(format!(
                "root path must be absolute, got: {}",
                self.root.display()
            )));
        }
        Ok(EnvironmentSpec {
            id: self.id,
            root: self.root,
            mounts: self.mounts,
            network: self.network,
            resources: self.resources,
            mode: self.mode,
        })
    }
}

// ─── Backward-compatible alias ────────────────────────────────────────────────

/// Backward-compatible alias for [`EnvironmentSpec`].
pub type BranchSpec = EnvironmentSpec;

#[cfg(test)]
mod tests {
    use super::*;

    // ── Pattern parsing ──────────────────────────────────────────────────────

    #[test]
    fn parses_prefixes_into_variants() {
        assert!(matches!(HostPattern::from("**.example.com"), HostPattern::Suffix(_)));
        assert!(matches!(HostPattern::from("*.example.com"), HostPattern::Subdomain(_)));
        assert!(matches!(HostPattern::from("example.com"), HostPattern::Exact(_)));
    }

    // ── Restrictive baseline (deny by default) ───────────────────────────────

    #[test]
    fn empty_allow_list_denies_everything() {
        assert!(!NetworkPolicy::deny_all().is_allowed("example.com"));
    }

    #[test]
    fn exact_matches_only_itself() {
        let p = NetworkPolicy::deny_all().allow("api.anthropic.com");
        assert!(p.is_allowed("api.anthropic.com"));
        assert!(!p.is_allowed("anthropic.com"));
        assert!(!p.is_allowed("evil.com"));
    }

    /// The classic allow-list bypass: a suffix check without a boundary would
    /// let an attacker-controlled domain end with the allowed one.
    #[test]
    fn exact_rejects_suffix_impersonation() {
        let p = NetworkPolicy::deny_all().allow("api.anthropic.com");
        assert!(!p.is_allowed("api.anthropic.com.evil.com"));
        assert!(!p.is_allowed("notapi.anthropic.com"));
    }

    #[test]
    fn subdomain_is_exactly_one_label() {
        let p = NetworkPolicy::deny_all().allow("*.example.com");
        assert!(p.is_allowed("api.example.com"));
        assert!(!p.is_allowed("example.com"), "apex is not a subdomain match");
        assert!(!p.is_allowed("a.b.example.com"), "two labels is not one label");
        assert!(!p.is_allowed(".example.com"), "empty label must not match");
    }

    #[test]
    fn suffix_covers_apex_and_any_depth() {
        let p = NetworkPolicy::deny_all().allow("**.example.com");
        assert!(p.is_allowed("example.com"));
        assert!(p.is_allowed("api.example.com"));
        assert!(p.is_allowed("a.b.c.example.com"));
        assert!(!p.is_allowed("notexample.com"));
    }

    // ── Permissive baseline (allow by default) ───────────────────────────────

    #[test]
    fn permissive_allows_unlisted_hosts() {
        let p = NetworkPolicy::allow_all();
        assert!(p.is_allowed("anything.example.com"));
    }

    #[test]
    fn block_beats_permissive_baseline() {
        let p = NetworkPolicy::allow_all().block("*.tracker.com");
        assert!(p.is_allowed("example.com"));
        assert!(!p.is_allowed("ads.tracker.com"));
    }

    /// A block must win even against an explicit allow of the same host —
    /// otherwise a broad allow silently re-opens something deliberately shut.
    #[test]
    fn block_beats_explicit_allow() {
        let p = NetworkPolicy::deny_all()
            .allow("**.example.com")
            .block("secrets.example.com");
        assert!(p.is_allowed("api.example.com"));
        assert!(!p.is_allowed("secrets.example.com"));
    }

    // ── Normalization ────────────────────────────────────────────────────────

    #[test]
    fn matching_ignores_case() {
        let p = NetworkPolicy::deny_all().allow("API.Example.COM");
        assert!(p.is_allowed("api.example.com"));
        assert!(p.is_allowed("API.EXAMPLE.COM"));
    }

    #[test]
    fn port_is_stripped_before_matching() {
        let p = NetworkPolicy::deny_all().allow("example.com");
        assert!(p.is_allowed("example.com:443"));
        assert!(p.is_allowed("example.com:8443"));
    }

    #[test]
    fn ipv6_brackets_are_stripped() {
        let p = NetworkPolicy::deny_all().allow("::1");
        assert!(p.is_allowed("[::1]"));
        assert!(p.is_allowed("[::1]:8080"));
    }

    /// A bare IPv6 literal must not have its last group mistaken for a port.
    #[test]
    fn bare_ipv6_is_not_truncated_as_port() {
        let p = NetworkPolicy::deny_all().allow("fe80::1");
        assert!(p.is_allowed("fe80::1"));
    }

    // ── Regex variant ────────────────────────────────────────────────────────

    #[test]
    fn regex_patterns_do_not_match_but_wildcard_sentinel_does() {
        let unevaluated = NetworkPolicy::deny_all().allow(HostPattern::regex("^example\\.com$"));
        assert!(!unevaluated.is_allowed("example.com"), "no regex engine is linked");

        let sentinel = NetworkPolicy::deny_all().allow(HostPattern::regex(".*"));
        assert!(sentinel.is_allowed("anything.com"));
    }
}
