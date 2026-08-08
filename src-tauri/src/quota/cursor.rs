// Cursor quota reader.
//
// Cursor doesn't do OAuth — it caches its session token in the editor's own
// `state.vscdb` SQLite database (same schema VS Code uses). We read the token
// out, POST to its private billing endpoint, and report the plan's USD spend
// as a balance (Cursor charges per-request, not per-token, so a percent-of-
// window doesn't apply cleanly).

use super::{Balance, ProviderUsage, ProviderStatus, Tone};
use serde_json::{json, Value};

const ID: &str = "cursor";
const NAME: &str = "Cursor";
const USAGE_URL: &str = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";

pub fn fetch() -> ProviderUsage {
    let token = match find_token() {
        Ok(Some(t)) => t,
        Ok(None) => return ProviderUsage::unavailable(ID, NAME),
        Err(e) => return ProviderUsage::errored(ID, NAME, e),
    };
    match call_usage(&token) {
        Ok(v) => parse_usage(&v),
        Err(e) => ProviderUsage::errored(ID, NAME, e),
    }
}

fn find_token() -> Result<Option<String>, String> {
    for var in ["CURSOR_ACCESS_TOKEN", "CURSOR_TOKEN"] {
        if let Ok(v) = std::env::var(var) { if !v.trim().is_empty() { return Ok(Some(v)); } }
    }
    let Some(db_path) = state_vscdb_path() else { return Ok(None); };
    if !db_path.exists() { return Ok(None); }
    read_token_from_sqlite(&db_path)
}

fn state_vscdb_path() -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    {
        let appdata = std::env::var("APPDATA").ok()?;
        Some(std::path::PathBuf::from(appdata).join("Cursor").join("User").join("globalStorage").join("state.vscdb"))
    }
    #[cfg(target_os = "macos")]
    {
        Some(super::home_dir().join("Library").join("Application Support").join("Cursor").join("User").join("globalStorage").join("state.vscdb"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Some(super::home_dir().join(".config").join("Cursor").join("User").join("globalStorage").join("state.vscdb"))
    }
}

fn read_token_from_sqlite(path: &std::path::Path) -> Result<Option<String>, String> {
    // Read-only open so we never race Cursor's own writer.
    let conn = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    ).map_err(|e| format!("state.vscdb: {e}"))?;
    let text: Option<String> = conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key = 'cursorAuthStatus'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok();
    let Some(text) = text else { return Ok(None); };
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("cursorAuthStatus not JSON: {e}"))?;
    Ok(v.get("accessToken").and_then(|x| x.as_str()).map(str::to_owned))
}

fn call_usage(token: &str) -> Result<Value, String> {
    // Connect protocol over HTTPS; body is an empty JSON object.
    let resp = ureq::post(USAGE_URL)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json")
        .set("Connect-Protocol-Version", "1")
        .send_json(json!({}));
    match resp {
        Ok(r) => r.into_json::<Value>().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(401 | 403, _)) => Err("sign in expired — re-open Cursor and sign back in".into()),
        Err(ureq::Error::Status(code, r)) => {
            let body = r.into_string().unwrap_or_default();
            Err(format!("HTTP {code}: {}", body.chars().take(200).collect::<String>()))
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Cursor's payload (Connect / protobuf-JSON):
///   {
///     "planUsage":     { "totalSpend": 4200, "remaining": 800, "limit": 5000 },
///     "billingCycleEnd": "2026-09-01T00:00:00Z"   // or unix seconds
///   }
/// Amounts are USD cents.
fn parse_usage(v: &Value) -> ProviderUsage {
    let usage = v.get("planUsage").cloned().unwrap_or(Value::Null);
    let cents_to_usd = |x: &Value| x.as_f64().map(|c| c / 100.0);
    let used = usage.get("totalSpend").and_then(cents_to_usd);
    let remaining = usage.get("remaining").and_then(cents_to_usd);
    let limit = usage.get("limit").and_then(cents_to_usd);
    let resets_at = v.get("billingCycleEnd").and_then(super::to_epoch_ms);

    let tone = match (used, limit) {
        (Some(u), Some(l)) if l > 0.0 => super::tone_from_used(u / l),
        _ => Tone::Default,
    };

    let mut balances = vec![];
    if used.is_some() || remaining.is_some() || limit.is_some() {
        balances.push(Balance {
            id: "plan_usage".into(),
            label: "Plan usage".into(),
            used, remaining, limit,
            unit: "usd".into(),
            resets_at,
            tone,
        });
    }

    ProviderUsage {
        provider_id: ID.into(),
        display_name: NAME.into(),
        status: ProviderStatus::Available,
        plan_label: None,
        windows: vec![],
        balances,
        details: vec![],
        error: None,
    }
}
