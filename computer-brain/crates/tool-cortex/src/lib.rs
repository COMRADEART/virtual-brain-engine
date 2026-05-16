use anyhow::{anyhow, Result};
use reqwest::Client;
use safety_layer::SafetyLayer;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use shared_types::{new_id, SafetyDecisionKind, ToolProvider, ToolRequest, ToolResult};
use std::time::Instant;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCortexConfig {
    pub ollama_base_url: String,
    pub ollama_model: String,
    pub openai_base_url: Option<String>,
    pub openai_api_key: Option<String>,
    pub claude_api_key: Option<String>,
    pub gemini_api_key: Option<String>,
}

impl Default for ToolCortexConfig {
    fn default() -> Self {
        Self {
            ollama_base_url: "http://127.0.0.1:11434".to_string(),
            ollama_model: "llama3.1".to_string(),
            openai_base_url: None,
            openai_api_key: None,
            claude_api_key: None,
            gemini_api_key: None,
        }
    }
}

#[derive(Clone)]
pub struct ToolCortex {
    config: ToolCortexConfig,
    safety: SafetyLayer,
    client: Client,
}

impl ToolCortex {
    pub fn new(config: ToolCortexConfig, safety: SafetyLayer) -> Self {
        Self {
            config,
            safety,
            client: Client::new(),
        }
    }

    pub async fn route(&self, request: ToolRequest) -> ToolResult {
        let output = match request.provider {
            ToolProvider::Ollama => self.call_ollama(&request).await,
            ToolProvider::Shell => self.run_shell(&request).await,
            ToolProvider::OpenAI => self.block_or_call_cloud(&request, "OpenAI").await,
            ToolProvider::Claude => self.block_or_call_cloud(&request, "Claude").await,
            ToolProvider::Gemini => self.block_or_call_cloud(&request, "Gemini").await,
            ToolProvider::Python => Err(anyhow!("Python plugins are disabled until enabled in safety policy")),
            ToolProvider::GitHub => Err(anyhow!("GitHub plugin interface is reserved for explicit connector configuration")),
        };

        match output {
            Ok(output) => ToolResult {
                request_id: request.id,
                provider: request.provider,
                ok: true,
                output,
                error: None,
            },
            Err(err) => ToolResult {
                request_id: request.id,
                provider: request.provider,
                ok: false,
                output: serde_json::json!({}),
                error: Some(err.to_string()),
            },
        }
    }

    pub fn ollama_request(prompt: &str) -> ToolRequest {
        ToolRequest {
            id: new_id("tool"),
            provider: ToolProvider::Ollama,
            tool: "chat".to_string(),
            input: serde_json::json!({ "prompt": prompt }),
            local_only: true,
            requires_confirmation: false,
        }
    }

    async fn call_ollama(&self, request: &ToolRequest) -> Result<Value> {
        let prompt = request
            .input
            .get("prompt")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("missing prompt"))?;
        let res = self
            .client
            .post(format!("{}/api/generate", self.config.ollama_base_url.trim_end_matches('/')))
            .json(&serde_json::json!({
                "model": self.config.ollama_model,
                "prompt": prompt,
                "stream": false,
            }))
            .send()
            .await?;
        if !res.status().is_success() {
            return Err(anyhow!("Ollama returned {}", res.status()));
        }
        let body: Value = res.json().await?;
        Ok(serde_json::json!({
            "provider": "ollama",
            "model": self.config.ollama_model,
            "response": body.get("response").cloned().unwrap_or(Value::String(String::new())),
        }))
    }

    async fn run_shell(&self, request: &ToolRequest) -> Result<Value> {
        let command = request
            .input
            .get("command")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("missing command"))?;
        let cwd = request.input.get("cwd").and_then(Value::as_str);
        let timeout_ms = request
            .input
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .unwrap_or(120_000)
            .clamp(1_000, 600_000);
        let env = request.input.get("env").and_then(Value::as_object);
        let decision = self.safety.check_command(command);
        if !matches!(decision.decision, SafetyDecisionKind::Allow) {
            return Err(anyhow!("{}: {}", serde_json::to_string(&decision.decision)?, decision.reason));
        }

        #[cfg(target_os = "windows")]
        let mut child = {
            let mut command_builder = Command::new("powershell");
            command_builder.args(["-NoProfile", "-Command", command]);
            command_builder
        };

        #[cfg(not(target_os = "windows"))]
        let mut child = {
            let mut command_builder = Command::new("sh");
            command_builder.args(["-lc", command]);
            command_builder
        };

        if let Some(cwd) = cwd {
            child.current_dir(cwd);
        }
        if let Some(env) = env {
            for (key, value) in env {
                if is_safe_env_key(key) {
                    if let Some(value) = value.as_str() {
                        child.env(key, value);
                    }
                }
            }
        }

        let started = Instant::now();
        let output = timeout(Duration::from_millis(timeout_ms), child.output())
            .await
            .map_err(|_| anyhow!("command timed out after {timeout_ms} ms"))??;
        let duration_ms = started.elapsed().as_millis() as u64;

        Ok(serde_json::json!({
            "status": output.status.code(),
            "stdout": truncate_output(&String::from_utf8_lossy(&output.stdout), 32_000),
            "stderr": truncate_output(&String::from_utf8_lossy(&output.stderr), 32_000),
            "cwd": cwd,
            "duration_ms": duration_ms,
            "timed_out": false,
        }))
    }

    async fn block_or_call_cloud(&self, request: &ToolRequest, provider: &str) -> Result<Value> {
        let decision = self.safety.check_cloud(provider, request.local_only);
        if !matches!(decision.decision, SafetyDecisionKind::Allow) {
            return Err(anyhow!("{}: {}", serde_json::to_string(&decision.decision)?, decision.reason));
        }
        Err(anyhow!("{provider} connector is configured behind safety confirmation but no API key handler is active"))
    }
}

fn truncate_output(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut out = value.chars().take(max_chars).collect::<String>();
    out.push_str("\n[output truncated]");
    out
}

fn is_safe_env_key(key: &str) -> bool {
    let lowered = key.to_ascii_lowercase();
    !(lowered.contains("token")
        || lowered.contains("secret")
        || lowered.contains("password")
        || lowered.contains("key"))
}
