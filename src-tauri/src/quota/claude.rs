// Claude Code quota reader.
//
// Reads the OAuth token from `~/.claude/.credentials.json` (macOS also falls
// back to the login keychain when the file isn't there), calls Anthropic's
// oauth usage endpoint, and reports the 5-hour "Session" window and the
// 7-day "Weekly" window that the CLI itself surfaces via `/status`.
//
// On a 401 we exchange the refresh token, persist the new pair back to the
// same file, and retry once. A refresh failure is a soft error: the row shows
// up in the island with an "auth expired" message rather than vanishing, so
// the user knows why their quota disappeared.

use super::{tone_from_used, to_epoch_ms, Detail, ProviderUsage, ProviderStatus, Tone, Window};
use serde::Deserialize;
use serde_json::{json, Value};

const ID: &str = "claude";
const NAME: &str = "Claude Code";
const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const OAUTH_BETA: &str = "oauth-2025-04-20";

// The CLI writes `~/.claude/.credentials.json` as
//   { "claudeAiOauth": { accessToken, refreshToken, expiresAt, ... },
//     "mcpOAuth": { ... } }
// We own only the `claudeAiOauth` slot; every other top-level key + every
// unknown key inside it is preserved verbatim across a refresh write so we
// don't stomp MCP tokens or future fields.
#[derive(Debug, Deserialize)]
struct OauthSlot {
    #[serde(rename = "accessToken")]
    access_token: Option<String>,
    #[serde(rename = "refreshToken")]
    refresh_token: Option<String>,
    #[serde(flatten)]
    extra: std::collections::BTreeMap<String, Value>,
}

#[derive(Debug)]
struct Credentials {
    oauth: OauthSlot,
    /// Every top-level key other than `claudeAiOauth`, kept intact on write.
    other: std::collections::BTreeMap<String, Value>,
}

pub fn fetch() -> ProviderUsage {
    let path = super::home_dir().join(".claude").join(".credentials.json");
    let mut creds = match read_credentials(&path) {
        Ok(Some(c)) => c,
        Ok(None) => return ProviderUsage::unavailable(ID, NAME),
        Err(e) => return ProviderUsage::errored(ID, NAME, e),
    };
    let Some(access) = creds.oauth.access_token.clone() else {
        return ProviderUsage::unavailable(ID, NAME);
    };

    match call_usage(&access) {
        Ok(v) => parse_usage(&v),
        Err(FetchError::Unauthorized) => {
            let Some(refresh) = creds.oauth.refresh_token.clone() else {
                return ProviderUsage::errored(ID, NAME, "sign in expired — re-run `claude`");
            };
            match refresh_tokens(&refresh) {
                Ok((new_access, new_refresh)) => {
                    creds.oauth.access_token = Some(new_access.clone());
                    if let Some(r) = new_refresh { creds.oauth.refresh_token = Some(r); }
                    // Persist first, then retry: a successful refresh whose
                    // write failed still leaves the *new* token in memory, but
                    // the next Tempest launch would reuse the *stale* one and
                    // 401 again in a loop.
                    if let Err(e) = write_credentials(&path, &creds) {
                        return ProviderUsage::errored(ID, NAME, format!("token refreshed but could not save: {e}"));
                    }
                    match call_usage(&new_access) {
                        Ok(v) => parse_usage(&v),
                        Err(e) => ProviderUsage::errored(ID, NAME, e.to_string()),
                    }
                }
                Err(e) => ProviderUsage::errored(ID, NAME, format!("sign in expired ({e})")),
            }
        }
        Err(e) => ProviderUsage::errored(ID, NAME, e.to_string()),
    }
}

#[derive(Debug)]
enum FetchError {
    Unauthorized,
    Http(String),
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unauthorized => write!(f, "unauthorized"),
            Self::Http(s) => f.write_str(s),
        }
    }
}

fn read_credentials(path: &std::path::Path) -> Result<Option<Credentials>, String> {
    let s = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("credentials.json unreadable: {e}")),
    };
    let mut top: std::collections::BTreeMap<String, Value> = serde_json::from_str(&s)
        .map_err(|e| format!("credentials.json unreadable: {e}"))?;
    let oauth_val = top.remove("claudeAiOauth").unwrap_or(Value::Null);
    // Missing/null slot → treated as signed-out, not a parse error. Anything
    // else that is present but wrong-shaped IS an error worth surfacing.
    let oauth: OauthSlot = if oauth_val.is_null() {
        return Ok(None);
    } else {
        serde_json::from_value(oauth_val).map_err(|e| format!("credentials.json unreadable: {e}"))?
    };
    Ok(Some(Credentials { oauth, other: top }))
}

fn write_credentials(path: &std::path::Path, c: &Credentials) -> Result<(), String> {
    let mut oauth_map = serde_json::Map::new();
    if let Some(a) = &c.oauth.access_token { oauth_map.insert("accessToken".into(), Value::String(a.clone())); }
    if let Some(r) = &c.oauth.refresh_token { oauth_map.insert("refreshToken".into(), Value::String(r.clone())); }
    for (k, v) in &c.oauth.extra { oauth_map.insert(k.clone(), v.clone()); }
    let mut top = serde_json::Map::new();
    for (k, v) in &c.other { top.insert(k.clone(), v.clone()); }
    top.insert("claudeAiOauth".into(), Value::Object(oauth_map));
    let text = serde_json::to_string_pretty(&Value::Object(top)).map_err(|e| e.to_string())?;
    // Non-atomic; a torn write here would delete a user's login. Write to a
    // sibling temp file and rename — same pattern as `hooks_write_atomic`.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

fn call_usage(access: &str) -> Result<Value, FetchError> {
    let resp = ureq::get(USAGE_URL)
        .set("Authorization", &format!("Bearer {access}"))
        .set("Accept", "application/json")
        .set("anthropic-beta", OAUTH_BETA)
        .call();
    match resp {
        Ok(r) => r.into_json::<Value>().map_err(|e| FetchError::Http(e.to_string())),
        Err(ureq::Error::Status(401 | 403, _)) => Err(FetchError::Unauthorized),
        Err(ureq::Error::Status(code, r)) => {
            let body = r.into_string().unwrap_or_default();
            Err(FetchError::Http(format!("HTTP {code}: {}", body.chars().take(200).collect::<String>())))
        }
        Err(e) => Err(FetchError::Http(e.to_string())),
    }
}

fn refresh_tokens(refresh: &str) -> Result<(String, Option<String>), String> {
    let body = json!({ "grant_type": "refresh_token", "refresh_token": refresh });
    let resp = ureq::post(TOKEN_URL)
        .set("Accept", "application/json")
        .send_json(body)
        .map_err(|e| e.to_string())?
        .into_json::<Value>()
        .map_err(|e| e.to_string())?;
    let access = resp.get("access_token").and_then(|v| v.as_str())
        .ok_or_else(|| "refresh response missing access_token".to_string())?;
    let new_refresh = resp.get("refresh_token").and_then(|v| v.as_str()).map(String::from);
    Ok((access.into(), new_refresh))
}

/// Anthropic's usage payload:
///   {
///     "five_hour":  { "utilization": 0.42, "resets_at": "2026-08-08T..." },
///     "seven_day":  { "utilization": 0.17, "resets_at": "..." },
///     "seven_day_opus":     { ... },   // optional, per-model scoped
///     "seven_day_opusmax":  { ... },
///     "subscriptionType": "pro",
///     "rateLimitTier":    "tier-1",
///     "extra_usage": { "is_enabled": true }
///   }
fn parse_usage(v: &Value) -> ProviderUsage {
    let mut windows = vec![];
    for (key, label) in [
        ("five_hour", "5-hour"),
        ("seven_day", "Weekly"),
        ("seven_day_opus", "Weekly · Opus"),
        ("seven_day_opusmax", "Weekly · Opus Max"),
    ] {
        if let Some(w) = v.get(key) { if let Some(win) = window_from(key, label, w) { windows.push(win); } }
    }
    // Newer API versions moved the scoped windows under `limits: [...]`.
    if let Some(limits) = v.get("limits").and_then(|x| x.as_array()) {
        for item in limits {
            let kind = item.get("kind").and_then(|x| x.as_str()).unwrap_or("");
            let name = item.get("name").and_then(|x| x.as_str()).unwrap_or(kind);
            let id = format!("limits:{name}");
            if let Some(win) = window_from(&id, &humanize(name), item) { windows.push(win); }
        }
    }

    let plan_label = plan_label(v);
    let mut details = vec![];
    if let Some(true) = v.pointer("/extra_usage/is_enabled").and_then(|x| x.as_bool()) {
        details.push(Detail { label: "Extra usage".into(), value: "enabled".into() });
    }

    ProviderUsage {
        provider_id: ID.into(),
        display_name: NAME.into(),
        status: ProviderStatus::Available,
        plan_label,
        windows,
        balances: vec![],
        details,
        error: None,
    }
}

fn window_from(id: &str, label: &str, v: &Value) -> Option<Window> {
    // `utilization` is Anthropic's field name; some scoped rows use `used_pct`.
    // Both come back as 0–100 percentages; our shared shape is 0–1.
    let used = v.get("utilization").or_else(|| v.get("used_pct"))
        .and_then(|x| x.as_f64())
        .map(|p| p / 100.0);
    let resets_at = v.get("resets_at").or_else(|| v.get("reset_at")).and_then(to_epoch_ms);
    // No used and no reset → nothing worth showing.
    if used.is_none() && resets_at.is_none() { return None; }
    let tone = used.map(tone_from_used).unwrap_or(Tone::Default);
    Some(Window { id: id.into(), label: label.into(), used, resets_at, tone })
}

fn plan_label(v: &Value) -> Option<String> {
    let sub = v.get("subscriptionType").and_then(|x| x.as_str());
    let tier = v.get("rateLimitTier").and_then(|x| x.as_str());
    match (sub, tier) {
        (Some(s), Some(t)) => Some(format!("{s} · {t}")),
        (Some(s), None) => Some(s.into()),
        (None, Some(t)) => Some(t.into()),
        _ => None,
    }
}

fn humanize(s: &str) -> String {
    // "seven_day_opus" → "Seven Day Opus". Cheap; only runs on scoped-window labels.
    s.split(&['_', '-'][..])
        .filter(|p| !p.is_empty())
        .map(|p| { let mut c = p.chars(); c.next().map(|f| f.to_ascii_uppercase()).into_iter().chain(c).collect::<String>() })
        .collect::<Vec<_>>()
        .join(" ")
}

