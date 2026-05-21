//! Stub browser module — browser automation requires the `playwright` feature flag.
//!
//! When `playwright` is enabled, replace this with the full Playwright implementation.

use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserConfig {
    pub headless: bool,
    pub timeout_ms: u64,
    pub user_agent: Option<String>,
    pub viewport_width: u32,
    pub viewport_height: u32,
}

impl Default for BrowserConfig {
    fn default() -> Self {
        Self {
            headless: true,
            timeout_ms: 30_000,
            user_agent: None,
            viewport_width: 1280,
            viewport_height: 800,
        }
    }
}

#[derive(Clone)]
pub struct BrowserManager {
    _config: BrowserConfig,
}

impl BrowserManager {
    pub fn new(config: BrowserConfig) -> Self {
        Self { _config: config }
    }

    pub async fn ensure_browser(&self) -> Result<BrowserManager> {
        Err(anyhow::anyhow!(
            "browser automation requires the 'playwright' feature flag"
        ))
    }

    pub async fn new_context(&self) -> Result<BrowserContext> {
        Err(anyhow::anyhow!(
            "browser automation requires the 'playwright' feature flag"
        ))
    }
}

pub struct BrowserContext {
    _phantom: std::marker::PhantomData<()>,
}

impl BrowserContext {
    pub async fn new_page(&self) -> Result<BrowserPage> {
        Err(anyhow::anyhow!(
            "browser automation requires the 'playwright' feature flag"
        ))
    }

    pub async fn close(self) -> Result<()> {
        Ok(())
    }
}

pub struct BrowserPage {
    _phantom: std::marker::PhantomData<()>,
}

impl BrowserPage {
    pub async fn goto(&self, _url: &str) -> Result<GotoResult> {
        Err(anyhow::anyhow!(
            "browser automation requires the 'playwright' feature flag"
        ))
    }

    pub async fn search(&self, _query: &str, _engine: &str) -> Result<GotoResult> {
        Err(anyhow::anyhow!(
            "browser automation requires the 'playwright' feature flag"
        ))
    }

    pub async fn click(&self, _selector: &str) -> Result<()> {
        Err(anyhow::anyhow!("browser automation requires the 'playwright' feature flag"))
    }

    pub async fn wait_for_selector(&self, _selector: &str, _timeout_ms: Option<u64>) -> Result<()> {
        Err(anyhow::anyhow!("browser automation requires the 'playwright' feature flag"))
    }

    pub async fn evaluate(&self, _script: &str) -> Result<serde_json::Value> {
        Err(anyhow::anyhow!("browser automation requires the 'playwright' feature flag"))
    }

    pub async fn html(&self) -> Result<String> {
        Err(anyhow::anyhow!("browser automation requires the 'playwright' feature flag"))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GotoResult {
    pub ok: bool,
    pub title: String,
    pub url: String,
    pub html: String,
}