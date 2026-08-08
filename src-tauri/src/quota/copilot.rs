// GitHub Copilot quota reader.
//
// Copilot's rate limits aren't exposed as a live window — GitHub only tells
// the user their plan and the date the next quota resets. The island still
// gets a row so the user can see the plan they're on and their reset date;
// we just don't fabricate a percent.
//
// Auth is a personal GitHub token. We look at the same places the Copilot
// extension does: three env vars, then the `gh` CLI's hosts.yml.

use super::{Detail, ProviderUsage, ProviderStatus};
use serde_json::Value;

const ID: &str = "copilot";
const NAME: &str = "GitHub Copilot";
const USAGE_URL: &str = "https://api.github.com/copilot_internal/user";
// These two Editor-* headers are what unlocks the internal endpoint; without
// them GitHub returns 404. Values match a recent VS Code Copilot Chat build.
const EDITOR_VERSION: &str = "vscode/1.96.2";
const EDITOR_PLUGIN: &str = "copilot-chat/0.26.7";
const UA: &str = "GitHubCopilotChat/0.26.7";
const API_VERSION: &str = "2025-04-01";

pub fn fetch() -> ProviderUsage {
    let Some(token) = find_token() else { return ProviderUsage::unavailable(ID, NAME); };
    match call_user(&token) {
        Ok(v) => parse_user(&v),
        Err(e) => ProviderUsage::errored(ID, NAME, e),
    }
}

fn find_token() -> Option<String> {
    for var in ["COPILOT_TOKEN", "GITHUB_TOKEN", "GITHUB_PAT"] {
        if let Ok(v) = std::env::var(var) { if !v.trim().is_empty() { return Some(v); } }
    }
    // gh CLI hosts.yml: don't pull in a YAML dep for one regex.
    let hosts = gh_hosts_path()?;
    let text = std::fs::read_to_string(hosts).ok()?;
    // Look for `oauth_token: <value>` (optionally quoted).
    for line in text.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("oauth_token:") {
            let v = rest.trim().trim_matches(|c: char| c == '"' || c == '\'');
            if !v.is_empty() { return Some(v.into()); }
        }
    }
    None
}

fn gh_hosts_path() -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    {
        let appdata = std::env::var("APPDATA").ok()?;
        let p = std::path::PathBuf::from(appdata).join("GitHub CLI").join("hosts.yml");
        if p.exists() { return Some(p); }
    }
    let p = super::home_dir().join(".config").join("gh").join("hosts.yml");
    if p.exists() { Some(p) } else { None }
}

fn call_user(token: &str) -> Result<Value, String> {
    // GitHub wants `token <pat>`, not `Bearer <pat>`.
    let resp = ureq::get(USAGE_URL)
        .set("Authorization", &format!("token {token}"))
        .set("Accept", "application/json")
        .set("Editor-Version", EDITOR_VERSION)
        .set("Editor-Plugin-Version", EDITOR_PLUGIN)
        .set("User-Agent", UA)
        .set("X-Github-Api-Version", API_VERSION)
        .call();
    match resp {
        Ok(r) => r.into_json::<Value>().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(401 | 403, _)) => Err("not a Copilot subscriber, or token missing copilot scope".into()),
        Err(ureq::Error::Status(code, r)) => {
            let body = r.into_string().unwrap_or_default();
            Err(format!("HTTP {code}: {}", body.chars().take(200).collect::<String>()))
        }
        Err(e) => Err(e.to_string()),
    }
}

fn parse_user(v: &Value) -> ProviderUsage {
    let plan_label = v.get("copilot_plan").and_then(|x| x.as_str()).map(str::to_owned);
    let mut details = vec![];
    if let Some(d) = v.get("quota_reset_date").and_then(|x| x.as_str()) {
        details.push(Detail { label: "Quota resets".into(), value: d.into() });
    }
    ProviderUsage {
        provider_id: ID.into(),
        display_name: NAME.into(),
        status: ProviderStatus::Available,
        plan_label,
        windows: vec![],
        balances: vec![],
        details,
        error: None,
    }
}
