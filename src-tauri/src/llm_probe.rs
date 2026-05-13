// Tauri-side counterpart of server/src/connectors/discovery.ts. Probes the
// same 7 local-LLM ports with the same content checks. Routing through Rust
// reqwest sidesteps the renderer's CORS preflight, which would otherwise be
// rejected by every one of these servers since they ship without CORS headers
// on loopback.
//
// If you change the probe table here, port the change to discovery.ts too.

use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const PROBE_TIMEOUT_MS: u64 = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredRuntime {
    pub kind: String,
    pub label: String,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    pub state: String,
    pub models: Vec<String>,
    #[serde(rename = "embedsAvailable")]
    pub embeds_available: bool,
    #[serde(rename = "connectorKind")]
    pub connector_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OllamaTag {
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OllamaTagsResponse {
    models: Option<Vec<OllamaTag>>,
}

#[derive(Debug, Deserialize)]
struct OpenAIModel {
    id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAIModels {
    object: Option<String>,
    data: Option<Vec<OpenAIModel>>,
}

#[derive(Debug, Deserialize)]
struct HealthBody {
    status: Option<String>,
}

struct ProbeConfig {
    kind: &'static str,
    label: &'static str,
    port: u16,
    connector_kind: &'static str,
    embeds_available: bool,
    style: ProbeStyle,
}

enum ProbeStyle {
    Ollama,
    OpenAI,
    LlamaCpp,
    Vllm,
    Tgi,
}

fn probes() -> [ProbeConfig; 7] {
    [
        ProbeConfig { kind: "ollama", label: "Ollama", port: 11434, connector_kind: "ollama", embeds_available: true, style: ProbeStyle::Ollama },
        ProbeConfig { kind: "lmstudio", label: "LM Studio", port: 1234, connector_kind: "openai-compatible", embeds_available: true, style: ProbeStyle::OpenAI },
        ProbeConfig { kind: "llamacpp", label: "llama.cpp", port: 8080, connector_kind: "openai-compatible", embeds_available: true, style: ProbeStyle::LlamaCpp },
        ProbeConfig { kind: "jan", label: "Jan", port: 1337, connector_kind: "openai-compatible", embeds_available: true, style: ProbeStyle::OpenAI },
        ProbeConfig { kind: "gpt4all", label: "GPT4All", port: 4891, connector_kind: "openai-compatible", embeds_available: false, style: ProbeStyle::OpenAI },
        ProbeConfig { kind: "vllm", label: "vLLM", port: 8000, connector_kind: "openai-compatible", embeds_available: true, style: ProbeStyle::Vllm },
        ProbeConfig { kind: "tgi", label: "TGI", port: 3000, connector_kind: "openai-compatible", embeds_available: false, style: ProbeStyle::Tgi },
    ]
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_millis(PROBE_TIMEOUT_MS))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

async fn probe_openai_shape(client: &reqwest::Client, base_url: &str) -> Result<Vec<String>, String> {
    let res = client
        .get(format!("{}/v1/models", base_url))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("Status {}", res.status()));
    }
    let body = res.json::<OpenAIModels>().await.map_err(|e| e.to_string())?;
    if body.object.as_deref() != Some("list") {
        return Err("Not an OpenAI-shape response".to_string());
    }
    Ok(body
        .data
        .unwrap_or_default()
        .into_iter()
        .filter_map(|m| m.id)
        .collect())
}

async fn probe_one(client: reqwest::Client, config: &ProbeConfig) -> DiscoveredRuntime {
    let base_url = format!("http://127.0.0.1:{}", config.port);
    let result = match config.style {
        ProbeStyle::Ollama => probe_ollama(&client, &base_url).await,
        ProbeStyle::OpenAI => probe_openai_shape(&client, &base_url).await,
        ProbeStyle::LlamaCpp => probe_llamacpp(&client, &base_url).await,
        ProbeStyle::Vllm => probe_vllm(&client, &base_url).await,
        ProbeStyle::Tgi => probe_tgi(&client, &base_url).await,
    };
    match result {
        Ok(models) => {
            let state = if models.is_empty() { "ok-no-model" } else { "ok" };
            DiscoveredRuntime {
                kind: config.kind.to_string(),
                label: config.label.to_string(),
                base_url,
                state: state.to_string(),
                models,
                embeds_available: config.embeds_available,
                connector_kind: config.connector_kind.to_string(),
                message: None,
            }
        }
        Err(message) => DiscoveredRuntime {
            kind: config.kind.to_string(),
            label: config.label.to_string(),
            base_url,
            state: "unreachable".to_string(),
            models: Vec::new(),
            embeds_available: false,
            connector_kind: config.connector_kind.to_string(),
            message: Some(message),
        },
    }
}

async fn probe_ollama(client: &reqwest::Client, base_url: &str) -> Result<Vec<String>, String> {
    let res = client.get(format!("{}/", base_url)).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("Ollama root returned {}", res.status()));
    }
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !text.contains("Ollama is running") {
        return Err("Ollama signature missing".to_string());
    }
    let tags = client.get(format!("{}/api/tags", base_url)).send().await.map_err(|e| e.to_string())?;
    if !tags.status().is_success() {
        return Ok(Vec::new());
    }
    let body = tags.json::<OllamaTagsResponse>().await.map_err(|e| e.to_string())?;
    Ok(body
        .models
        .unwrap_or_default()
        .into_iter()
        .filter_map(|m| m.name)
        .collect())
}

async fn probe_llamacpp(client: &reqwest::Client, base_url: &str) -> Result<Vec<String>, String> {
    let res = client.get(format!("{}/health", base_url)).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("/health returned {}", res.status()));
    }
    let body = res.json::<HealthBody>().await.unwrap_or(HealthBody { status: None });
    if body.status.as_deref() != Some("ok") {
        return Err(format!(
            "/health status={}",
            body.status.unwrap_or_else(|| "missing".to_string())
        ));
    }
    probe_openai_shape(client, base_url).await
}

async fn probe_vllm(client: &reqwest::Client, base_url: &str) -> Result<Vec<String>, String> {
    let res = client.get(format!("{}/health", base_url)).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("/health returned {}", res.status()));
    }
    probe_openai_shape(client, base_url).await
}

async fn probe_tgi(client: &reqwest::Client, base_url: &str) -> Result<Vec<String>, String> {
    let res = client.get(format!("{}/info", base_url)).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("/info returned {}", res.status()));
    }
    probe_openai_shape(client, base_url).await
}

#[derive(Debug, Serialize)]
pub struct ProbeResponse {
    pub runtimes: Vec<DiscoveredRuntime>,
}

#[tauri::command]
pub async fn probe_local_llms() -> Result<ProbeResponse, String> {
    let client = client();
    let configs = probes();
    let futures = configs.iter().map(|c| probe_one(client.clone(), c));
    let runtimes = join_all(futures).await;
    Ok(ProbeResponse { runtimes })
}
