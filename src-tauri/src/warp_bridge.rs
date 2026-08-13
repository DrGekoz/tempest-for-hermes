//! Experimental Warp (warpllm) chat backend. One Tauri command:
//! `warp_chat` takes a prompt + history + provider/model string and returns the
//! full completion text. Non-streaming (warpllm has no streaming yet), so the
//! frontend shows a spinner and drops the result in as one message.
//!
//! Keys: warpllm reads `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`,
//! `MOONSHOT_API_KEY` from the process env. If the caller passes a key we install
//! it before dispatch. Gated by the frontend's "experimental features" toggle —
//! this command is only ever invoked when the user opts in.

use warpllm::{ChatCompletionRequestMessage, Client, ClientConfig, CreateChatCompletionRequest};

#[derive(serde::Deserialize)]
pub struct WarpMessage {
    pub role: String,
    pub content: String,
}

#[derive(serde::Deserialize)]
pub struct WarpChatArgs {
    pub model: String,
    pub messages: Vec<WarpMessage>,
    pub system: Option<String>,
    /// Provider-specific env var to install for this call (e.g. "OPENAI_API_KEY").
    pub api_key_env: Option<String>,
    pub api_key: Option<String>,
}

#[derive(serde::Serialize)]
pub struct WarpChatResult {
    pub content: String,
    pub input_tokens: u32,
    pub output_tokens: u32,
}

#[tauri::command]
pub async fn warp_chat(args: WarpChatArgs) -> Result<WarpChatResult, String> {
    // ponytail: process-wide env write. warpllm's ClientConfig doesn't expose a
    // per-call key yet; upgrade to a proper credential slot when it does.
    if let (Some(name), Some(key)) = (args.api_key_env.as_deref(), args.api_key.as_deref()) {
        if !name.is_empty() && !key.is_empty() {
            unsafe { std::env::set_var(name, key); }
        }
    }

    let mut messages: Vec<ChatCompletionRequestMessage> = Vec::new();
    if let Some(sys) = args.system.as_deref().filter(|s| !s.trim().is_empty()) {
        messages.push(ChatCompletionRequestMessage {
            role: "system".to_string(),
            content: sys.to_string(),
            ..Default::default()
        });
    }
    for m in args.messages {
        messages.push(ChatCompletionRequestMessage {
            role: m.role,
            content: m.content,
            ..Default::default()
        });
    }

    let client = Client::new(ClientConfig::default()).map_err(|e| e.to_string())?;
    let resp = client
        .chat_completions(CreateChatCompletionRequest {
            model: args.model,
            messages,
            ..Default::default()
        })
        .await
        .map_err(|e| e.to_string())?;

    let content = resp
        .choices
        .get(0)
        .and_then(|c| c.message.content.clone())
        .unwrap_or_default();
    let usage = resp.usage.as_ref();
    Ok(WarpChatResult {
        content,
        input_tokens: usage.map(|u| u.prompt_tokens).unwrap_or(0),
        output_tokens: usage.map(|u| u.completion_tokens).unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn args_deserialize() {
        let raw = r#"{"model":"openai/gpt-5-nano","messages":[{"role":"user","content":"hi"}]}"#;
        let a: WarpChatArgs = serde_json::from_str(raw).unwrap();
        assert_eq!(a.model, "openai/gpt-5-nano");
        assert_eq!(a.messages.len(), 1);
        assert!(a.system.is_none());
    }
}
