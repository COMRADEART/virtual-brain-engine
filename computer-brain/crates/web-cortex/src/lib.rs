//! Web Cortex — browser automation, web search, and internet reasoning.
//!
//! This is a pure service library: it provides [`WebCortex`] which
//! wraps HTTP search + content sanitization.
//! Agents live in `brain-core` and hold `Arc<WebCortex>` as a service field.
//!
//! ## Features
//!
//! - `runtime-async-std` — async-std runtime (default), enables playwright
//! - `runtime-tokio` — tokio runtime, enables playwright
//! - Without browser features: lightweight HTTP-only fetch mode

pub mod sanitizer;
pub mod page_scraper;
pub mod search;

#[cfg(feature = "playwright")]
pub mod browser;

use anyhow::Result;
use search::{SearchEngine, SearchResponse};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebCortexConfig {
    pub headless: bool,
    pub default_engine: String,
    pub domain_allowlist: Vec<String>,
    pub max_content_length: usize,
    pub timeout_ms: u64,
}

impl Default for WebCortexConfig {
    fn default() -> Self {
        Self {
            headless: true,
            default_engine: "duckduckgo".to_string(),
            domain_allowlist: vec![
                "wikipedia.org".to_string(),
                "github.com".to_string(),
                "crates.io".to_string(),
                "docs.rs".to_string(),
                "stackoverflow.com".to_string(),
                "reddit.com".to_string(),
                "news.ycombinator.com".to_string(),
                "arxiv.org".to_string(),
                "nature.com".to_string(),
                "docs.github.com".to_string(),
                "rust-lang.org".to_string(),
            ],
            max_content_length: 200_000,
            timeout_ms: 30_000,
        }
    }
}

#[derive(Clone)]
pub struct WebCortex {
    config: WebCortexConfig,
    sanitizer: Arc<sanitizer::ContentSanitizer>,
    search_engine: SearchEngine,
}

impl WebCortex {
    pub fn new(config: WebCortexConfig) -> Self {
        let sanitizer = Arc::new(sanitizer::ContentSanitizer::new());
        let search_engine = SearchEngine::new(sanitizer.clone());
        Self {
            config,
            sanitizer,
            search_engine,
        }
    }

    pub async fn search(&self, query: &str) -> Result<SearchResponse> {
        self.search_engine
            .search(query, &self.config.default_engine)
            .await
    }

    pub async fn search_with_engine(&self, query: &str, engine: &str) -> Result<SearchResponse> {
        self.search_engine.search(query, engine).await
    }

    pub async fn search_multi_engine(&self, query: &str, engines: &[&str]) -> Vec<SearchResponse> {
        self.search_engine.search_multi(query, engines).await
    }

    pub async fn fetch_page(&self, url: &str) -> Result<FetchResult> {
        self.sanitizer.sanitize_url(url)?;

        if !self.is_allowed_domain(url) {
            anyhow::bail!("domain not in allowlist: {url}");
        }

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(self.config.timeout_ms))
            .user_agent("Mozilla/5.0 (compatible; ComputerBrain/1.0; +local)")
            .build()?;
        let resp = client.get(url).send().await?;
        let html = resp.text().await?;

        let title = ::scraper::Html::parse_document(&html)
            .select(&::scraper::Selector::parse("title").unwrap())
            .next()
            .map(|el| el.text().collect::<Vec<_>>().join(" "))
            .unwrap_or_default();

        let sanitized = self.sanitizer.sanitize(&html, &title);
        let scraped = page_scraper::PageScraper::scrape(&sanitized.text, url);

        Ok(FetchResult {
            url: url.to_string(),
            title: sanitized.title,
            content: sanitized.text,
            scraped,
            sanitized_content: true,
            threats_removed: sanitized.threats_removed,
            credibility_flags: sanitized.credibility_flags,
        })
    }

    pub async fn fetch_github_repo(&self, repo: &str) -> Result<GitHubRepoInfo> {
        let url = format!("https://api.github.com/repos/{repo}");
        let client = reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (compatible; ComputerBrain/1.0)")
            .build()?;
        let resp = client.get(&url).send().await?;
        if !resp.status().is_success() {
            anyhow::bail!("GitHub API returned {} for {repo}", resp.status());
        }
        let json: serde_json::Value = resp.json().await?;

        let topics: Vec<String> = json["topics"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(ToString::to_string))
                    .collect()
            })
            .unwrap_or_default();

        let license_name = json["license"]
            .as_object()
            .and_then(|obj| obj.get("name"))
            .and_then(|v| v.as_str())
            .map(ToString::to_string);

        Ok(GitHubRepoInfo {
            full_name: json["full_name"].as_str().unwrap_or(repo).to_string(),
            description: json["description"].as_str().map(ToString::to_string),
            stars: json["stargazers_count"].as_u64(),
            language: json["language"].as_str().map(ToString::to_string),
            topics,
            readme_url: format!("https://raw.githubusercontent.com/{}/HEAD/README.md", repo),
            html_url: json["html_url"].as_str().unwrap_or("").to_string(),
            license: license_name,
        })
    }

    pub fn is_allowed_domain(&self, url: &str) -> bool {
        self.config.domain_allowlist.iter().any(|domain| {
            url.contains(domain) || domain == "*"
        })
    }

    pub fn sanitizer(&self) -> &sanitizer::ContentSanitizer {
        &self.sanitizer
    }

    pub fn config(&self) -> &WebCortexConfig {
        &self.config
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FetchResult {
    pub url: String,
    pub title: String,
    pub content: String,
    pub scraped: page_scraper::ScrapedPage,
    pub sanitized_content: bool,
    pub threats_removed: Vec<String>,
    pub credibility_flags: Vec<String>,
}

impl FetchResult {
    pub fn word_count(&self) -> usize {
        self.content.split_whitespace().count()
    }

    pub fn has_threats(&self) -> bool {
        self.threats_removed
            .iter()
            .any(|t| t.contains("Critical") || t.contains("High"))
    }

    pub fn credibility_score(&self) -> f32 {
        let mut score = 0.65_f32;
        if self.sanitized_content {
            score += 0.10;
        }
        if self.has_threats() {
            score -= 0.30;
        }
        if self.content.chars().count() > 500 {
            score += 0.05;
        }
        if !self.scraped.code_blocks.is_empty() {
            score += 0.05;
        }
        score.clamp(0.0, 1.0)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubRepoInfo {
    pub full_name: String,
    pub description: Option<String>,
    pub stars: Option<u64>,
    pub language: Option<String>,
    pub topics: Vec<String>,
    pub readme_url: String,
    pub html_url: String,
    pub license: Option<String>,
}