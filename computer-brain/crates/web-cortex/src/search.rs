//! Search abstraction over HTTP fetch.
//!
//! Uses reqwest for lightweight search when Playwright is not available,
//! and provides page fetch + content extraction capabilities.

use crate::sanitizer::ContentSanitizer;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub domain: String,
    pub position: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResponse {
    pub query: String,
    pub engine: String,
    pub results: Vec<SearchResult>,
    pub total_estimate: Option<String>,
    pub sanitized: bool,
    pub threats_removed: Vec<String>,
}

#[derive(Clone)]
pub struct SearchEngine {
    sanitizer: std::sync::Arc<ContentSanitizer>,
}

impl SearchEngine {
    pub fn new(sanitizer: std::sync::Arc<ContentSanitizer>) -> Self {
        Self { sanitizer }
    }

    pub async fn search(&self, query: &str, engine: &str) -> Result<SearchResponse> {
        let search_url = self.build_search_url(query, engine)?;
        self.sanitizer.sanitize_url(&search_url)?;
        let html = self.http_get(&search_url).await?;
        let results = self.parse_results(&html, engine);
        let threats_removed: Vec<String> = Vec::new();
        Ok(SearchResponse {
            query: query.to_string(),
            engine: engine.to_string(),
            results,
            total_estimate: None,
            sanitized: !threats_removed.is_empty(),
            threats_removed,
        })
    }

    pub async fn search_multi(&self, query: &str, engines: &[&str]) -> Vec<SearchResponse> {
        let mut responses = Vec::new();
        for engine in engines {
            if let Ok(resp) = self.search(query, engine).await {
                responses.push(resp);
            }
        }
        responses
    }

    fn build_search_url(&self, query: &str, engine: &str) -> Result<String> {
        let encoded: String = urlencoding_encode(query);
        let url = match engine {
            "duckduckgo" | "" => format!("https://html.duckduckgo.com/html/?q={}", encoded),
            "google" => format!("https://www.google.com/search?q={}", encoded),
            "bing" => format!("https://www.bing.com/search?q={}", encoded),
            "startpage" => format!("https://www.startpage.com/search?q={}", encoded),
            "wikipedia" => format!("https://en.wikipedia.org/w/index.php?search={}", encoded),
            "github" => format!("https://github.com/search?q={}", encoded),
            "crates" => format!("https://crates.io/search?q={}", encoded),
            "docsrs" => format!("https://docs.rs/releases/search?query={}", encoded),
            _other => format!("https://duckduckgo.com/?q={}", encoded),
        };
        Ok(url)
    }

    async fn http_get(&self, url: &str) -> Result<String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .user_agent("Mozilla/5.0 (compatible; ComputerBrain/1.0; +local)")
            .build()?;
        let resp = client.get(url).send().await?;
        let html = resp.text().await?;
        Ok(html)
    }

    fn parse_results(&self, html: &str, engine: &str) -> Vec<SearchResult> {
        let document = scraper::Html::parse_document(html);
        let mut results = Vec::new();
        let mut position = 0;
        let mut seen_urls: HashSet<String> = HashSet::new();

        match engine {
            "duckduckgo" | "html.duckduckgo" | "" => {
                let result_selector = scraper::Selector::parse(".result").unwrap();
                let title_selector = scraper::Selector::parse(".result__title a").unwrap();
                let snippet_selector = scraper::Selector::parse(".result__snippet").unwrap();

                for result_el in document.select(&result_selector) {
                    let title = result_el
                        .select(&title_selector)
                        .next()
                        .map(|el| el.text().collect::<String>().trim().to_string())
                        .unwrap_or_default();

                    let snippet = result_el
                        .select(&snippet_selector)
                        .next()
                        .map(|el| el.text().collect::<String>().trim().to_string())
                        .unwrap_or_default();

                    let href = result_el
                        .select(&title_selector)
                        .filter_map(|a| a.value().attr("href"))
                        .find(|h| h.starts_with("http"))
                        .unwrap_or_default();

                    if title.is_empty() || seen_urls.contains(href) {
                        continue;
                    }
                    seen_urls.insert(href.to_string());
                    position += 1;
                    let domain = extract_domain(&href);
                    results.push(SearchResult {
                        title,
                        url: href.to_string(),
                        snippet,
                        domain,
                        position,
                    });
                    if results.len() >= 20 {
                        break;
                    }
                }
            }
            "github" => {
                let result_selector = scraper::Selector::parse(".repo-list-item").unwrap();
                let title_selector = scraper::Selector::parse(".repo-list-item h3 a").unwrap();
                let desc_selector = scraper::Selector::parse(".repo-list-item p").unwrap();

                for result_el in document.select(&result_selector) {
                    let title = result_el
                        .select(&title_selector)
                        .next()
                        .map(|el| el.text().collect::<String>().trim().to_string())
                        .unwrap_or_default();

                    let snippet = result_el
                        .select(&desc_selector)
                        .next()
                        .map(|el| el.text().collect::<String>().trim().to_string())
                        .unwrap_or_default();

                    let href = result_el
                        .select(&title_selector)
                        .filter_map(|a| a.value().attr("href"))
                        .find(|h| h.starts_with("/"))
                        .map(|h| format!("https://github.com{}", h))
                        .unwrap_or_default();

                    if title.is_empty() || seen_urls.contains(&href) {
                        continue;
                    }
                    seen_urls.insert(href.clone());
                    position += 1;
                    results.push(SearchResult {
                        title,
                        url: href,
                        snippet,
                        domain: "github.com".to_string(),
                        position,
                    });
                    if results.len() >= 15 {
                        break;
                    }
                }
            }
            _ => {
                let link_selector = scraper::Selector::parse("a[href]").unwrap();
                for a in document.select(&link_selector) {
                    if let Some(href) = a.value().attr("href") {
                        if !href.starts_with("http") || seen_urls.contains(href) {
                            continue;
                        }
                        let text = a.text().collect::<String>().trim().to_string();
                        if text.len() < 10 || text.len() > 300 {
                            continue;
                        }
                        seen_urls.insert(href.to_string());
                        position += 1;
                        let domain = extract_domain(href);
                        results.push(SearchResult {
                            title: text.clone(),
                            url: href.to_string(),
                            snippet: text,
                            domain,
                            position,
                        });
                    }
                    if results.len() >= 20 {
                        break;
                    }
                }
            }
        }

        results
    }
}

fn urlencoding_encode(input: &str) -> String {
    let mut encoded = String::with_capacity(input.len() * 3);
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => {
                encoded.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    encoded
}

fn extract_domain(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(ToString::to_string))
        .unwrap_or_default()
}