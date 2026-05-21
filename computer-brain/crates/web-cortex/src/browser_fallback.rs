//! Stub browser types when Playwright feature is disabled.

use anyhow::Result;

pub struct BrowserManager;

pub struct BrowserConfig;

impl Default for BrowserConfig {
    fn default() -> Self {
        Self
    }
}

impl BrowserManager {
    pub fn new(_config: BrowserConfig) -> Self {
        Self
    }

    pub async fn ensure_browser(&self) -> Result<()> {
        Err(anyhow::anyhow!("browser automation requires the 'playwright' feature flag"))
    }
}