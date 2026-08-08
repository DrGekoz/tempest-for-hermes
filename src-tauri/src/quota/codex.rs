// Codex CLI quota reader.
//
// Codex is OpenAI's terminal agent. It signs in with ChatGPT and stores an
// OAuth token pair under `~/.codex/auth.json` (or `$CODEX_HOME`, or the XDG
// path). The usage endpoint is the same one the ChatGPT web app calls; we
// pretend to be a browser so it does not reject us for missing UA.

use super::{tone_from_used, to_epoch_ms, Balance, ProviderUsage, ProviderStatus, Tone, Window};
use serde::Deserialize;
use serde_json::Value;

const ID: &str = "codex";
const NAME: &str = "Codex";
const USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
// The desktop-client id the Codex CLI itself refreshes with — anything else is
// rejected by OpenAI's auth server.
const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
// Any modern-looking UA works; a missing UA gets served the HTML sign-in page.
const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

#[derive(Debug, Deserialize)]
struct Auth {
    tokens: Option<Tokens>,
    #[serde(rename = "OPENAI_API_KEY")]
    #[serde(default)]
    _openai_api_key: Option<String>,
    #[serde(flatten)]
    extra: std::collections::BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Deserialize)]
struct Tokens {
    #[serde(rename = "access_token")]
    access: Option<String>,
    #[serde(rename = "refresh_token")]
    refresh: Option<String>,
    #[serde(rename = "account_id")]
    account_id: Option<String>,
    #[serde(flatten)]
    extra: std::collections::BTreeMap<String, Value>,
}

pub fn fetch() -> ProviderUsage {
    let Some(path) = find_auth_file() else {
        return ProviderUsage::unavailable(ID, NAME);
    };
    let mut auth = match read_auth(&path) {
        Ok(Some(a)) => a,
        Ok(None) => return ProviderUsage::unavailable(ID, NAME),
        Err(e) => return ProviderUsage::errored(ID, NAME, e),
    };
    let Some(tokens) = auth.tokens.clone() else { return ProviderUsage::unavailable(ID, NAME); };
    let Some(access) = tokens.access.clone() else { return ProviderUsage::unavailable(ID, NAME); };

    match call_usage(&access, tokens.account_id.as_deref()) {
        Ok(v) => parse_usage(&v),
        Err(FetchError::Unauthorized) => {
            let Some(refresh) = tokens.refresh.clone() else {
                return ProviderUsage::errored(ID, NAME, "sign in expired — re-run `codex login`");
            };
            match refresh_tokens(&refresh) {
                Ok((new_access, new_refresh)) => {
                    let mut new_tokens = tokens;
                    new_tokens.access = Some(new_access.clone());
                    if let Some(r) = new_refresh { new_tokens.refresh = Some(r); }
                    auth.tokens = Some(new_tokens.clone());
                    if let Err(e) = write_auth(&path, &auth) {
                        return ProviderUsage::errored(ID, NAME, format!("token refreshed but could not save: {e}"));
                    }
                    match call_usage(&new_access, new_tokens.account_id.as_deref()) {
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

fn find_auth_file() -> Option<std::path::PathBuf> {
    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        let p = std::path::PathBuf::from(codex_home).join("auth.json");
        if p.exists() { return Some(p); }
    }
    // XDG path first, then legacy: matches Codex's own resolution order so we
    // read from the same place the CLI wrote to.
    let home = super::home_dir();
    let xdg = home.join(".config").join("codex").join("auth.json");
    if xdg.exists() { return Some(xdg); }
    let legacy = home.join(".codex").join("auth.json");
    if legacy.exists() { return Some(legacy); }
    None
}

fn read_auth(path: &std::path::Path) -> Result<Option<Auth>, String> {
    match std::fs::read_to_string(path) {
        Ok(s) => serde_json::from_str::<Auth>(&s).map(Some).map_err(|e| format!("auth.json unreadable: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("auth.json unreadable: {e}")),
    }
}

fn write_auth(path: &std::path::Path, a: &Auth) -> Result<(), String> {
    // Preserve every unknown top-level key and every unknown field inside
    // `tokens`. Codex writes fields we don't model (id_token, scope, expires_at);
    // dropping them would sign the user out on the next `codex` invocation.
    let mut root = serde_json::Map::new();
    if let Some(t) = &a.tokens {
        let mut tm = serde_json::Map::new();
        if let Some(x) = &t.access { tm.insert("access_token".into(), Value::String(x.clone())); }
        if let Some(x) = &t.refresh { tm.insert("refresh_token".into(), Value::String(x.clone())); }
        if let Some(x) = &t.account_id { tm.insert("account_id".into(), Value::String(x.clone())); }
        for (k, v) in &t.extra { tm.insert(k.clone(), v.clone()); }
        root.insert("tokens".into(), Value::Object(tm));
    }
    for (k, v) in &a.extra { root.insert(k.clone(), v.clone()); }
    let text = serde_json::to_string_pretty(&Value::Object(root)).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

fn call_usage(access: &str, account_id: Option<&str>) -> Result<Value, FetchError> {
    let mut req = ureq::get(USAGE_URL)
        .set("Authorization", &format!("Bearer {access}"))
        .set("Accept", "application/json")
        .set("User-Agent", UA);
    if let Some(id) = account_id { req = req.set("ChatGPT-Account-Id", id); }
    let resp = req.call();
    match resp {
        Ok(r) => {
            let text = r.into_string().map_err(|e| FetchError::Http(e.to_string()))?;
            // Sign-in redirects surface as an HTML page with a 200. The API
            // never legitimately returns HTML; treat it as an auth failure so
            // the refresh path runs.
            if text.trim_start().starts_with('<') {
                return Err(FetchError::Unauthorized);
            }
            serde_json::from_str::<Value>(&text).map_err(|e| FetchError::Http(e.to_string()))
        }
        Err(ureq::Error::Status(401 | 403, _)) => Err(FetchError::Unauthorized),
        Err(ureq::Error::Status(code, r)) => {
            let body = r.into_string().unwrap_or_default();
            Err(FetchError::Http(format!("HTTP {code}: {}", body.chars().take(200).collect::<String>())))
        }
        Err(e) => Err(FetchError::Http(e.to_string())),
    }
}

fn refresh_tokens(refresh: &str) -> Result<(String, Option<String>), String> {
    // OpenAI's token endpoint expects form-encoded, not JSON.
    let resp = ureq::post(TOKEN_URL)
        .set("Accept", "application/json")
        .send_form(&[
            ("grant_type", "refresh_token"),
            ("client_id", CLIENT_ID),
            ("refresh_token", refresh),
        ])
        .map_err(|e| e.to_string())?
        .into_json::<Value>()
        .map_err(|e| e.to_string())?;
    let access = resp.get("access_token").and_then(|v| v.as_str())
        .ok_or_else(|| "refresh response missing access_token".to_string())?;
    let new_refresh = resp.get("refresh_token").and_then(|v| v.as_str()).map(String::from);
    Ok((access.into(), new_refresh))
}

/// Codex's payload:
///   {
///     "rate_limit": {
///        "primary_window":   { "used_percent": 12.5, "reset_at": 1755110400 },
///        "secondary_window": { "used_percent": 3.1,  "reset_at": ... }
///     },
///     "code_review_rate_limit": { "primary_window": {...} },
///     "credits": { "balance": 4.20 },
///     "plan_type": "plus"
///   }
fn parse_usage(v: &Value) -> ProviderUsage {
    let mut windows = vec![];
    if let Some(rl) = v.get("rate_limit") {
        push_window(&mut windows, "primary", "Session (5h)", rl.get("primary_window"));
        push_window(&mut windows, "secondary", "Weekly", rl.get("secondary_window"));
    }
    if let Some(cr) = v.get("code_review_rate_limit") {
        push_window(&mut windows, "code_review", "Code review", cr.get("primary_window"));
    }

    let mut balances = vec![];
    if let Some(bal) = v.pointer("/credits/balance").and_then(|x| x.as_f64()) {
        balances.push(Balance {
            id: "credits".into(),
            label: "Credits".into(),
            used: None,
            remaining: Some(bal),
            limit: None,
            unit: "usd".into(),
            resets_at: None,
            tone: Tone::Default,
        });
    }

    let plan_label = v.get("plan_type").and_then(|x| x.as_str()).map(str::to_owned);

    ProviderUsage {
        provider_id: ID.into(),
        display_name: NAME.into(),
        status: ProviderStatus::Available,
        plan_label,
        windows,
        balances,
        details: vec![],
        error: None,
    }
}

fn push_window(out: &mut Vec<Window>, id: &str, label: &str, v: Option<&Value>) {
    let Some(v) = v else { return; };
    // `used_percent` is 0–100; our shared shape is 0–1.
    let used = v.get("used_percent").and_then(|x| x.as_f64()).map(|p| p / 100.0);
    let resets_at = v.get("reset_at").and_then(to_epoch_ms);
    if used.is_none() && resets_at.is_none() { return; }
    let tone = used.map(tone_from_used).unwrap_or(Tone::Default);
    out.push(Window { id: id.into(), label: label.into(), used, resets_at, tone });
}

