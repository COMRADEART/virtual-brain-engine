//! SearchAgent — handles web search queries and result extraction.

use crate::search::{SearchEngine, SearchResult};
use crate::sanitizer::ContentSanitizer;
use crate::BrowserManager;
use agent_runtime::{AgentContext, AgentFuture};
use anyhow::Result;
use chrono::Utc;
use shared_types::{
    new_id, AgentCapability, AgentState, AgentTask, BrainEvent, BrainEventEnvelope,
};
use std::pin::Pin;
use crate::brain_core::BrainServices;

macro_rules! boxed {
    ($body:expr) => {
        Box::pin(async move { $body })
    };
}

#[derive(Clone)]
pub struct SearchAgent {
    pub services: BrainServices,
}

impl SearchAgent {
    pub fn new(services: BrainServices) -> Self {
        Self { services }
    }

    async fn perform_search(&self, query: &str, engine: &str) -> Result<Vec<SearchResult>> {
        let browser = BrowserManager::new(crate::browser::BrowserConfig::default());
        let search = SearchEngine::new(browser, ContentSanitizer::new());
        let response = search.search(query, engine).await?;
        Ok(response.results)
    }

    pub async fn search_and_store(&self, query: &str, engine: &str) -> Result<Vec<String>> {
        let results = self.perform_search(query, engine).await?;

        self.services.bus.emit(
            BrainEvent::WebSearchPerformed {
                query: query.to_string(),
                result_count: results.len(),
                sources: results.iter().map(|r| r.url.clone()).collect(),
                at: Utc::now(),
            },
            Some("SearchAgent".to_string()),
        )?;

        let memory_ids: Vec<String> = results
            .iter()
            .take(10)
            .map(|result| {
                let record = memory_cortex::memory(
                    shared_types::MemoryKind::LongTerm,
                    Some("web search result".to_string()),
                    format!(
                        "Title: {}\nURL: {}\nSnippet: {}\nDomain: {}",
                        result.title, result.url, result.snippet, result.domain
                    ),
                    None,
                    vec![
                        "web-search".to_string(),
                        result.domain.clone(),
                        format!("position-{}", result.position),
                    ],
                    Some(result.url.clone()),
                    0.60,
                );
                if let Ok(id) = self.services.memory.store_memory(&record) {
                    id.id
                } else {
                    String::new()
                }
            })
            .filter(|id| !id.is_empty())
            .collect();

        for result in results.iter().take(5) {
            let href = &result.url;
            if let Ok((title, html)) = self.fetch_page(href).await {
                if let Some(content) = self.sanitized_content(&html, &title) {
                    let record = memory_cortex::memory(
                        shared_types::MemoryKind::LongTerm,
                        Some("web page content".to_string()),
                        content,
                        None,
                        vec![
                            "web-page".to_string(),
                            "web-source".to_string(),
                            format!("source:{}", result.domain),
                        ],
                        Some(href.clone()),
                        0.55,
                    );
                    let _ = self.services.memory.store_memory(&record);
                }
            }
        }

        Ok(memory_ids)
    }

    async fn fetch_page(&self, url: &str) -> Result<(String, String)> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .user_agent("Mozilla/5.0 (compatible; ComputerBrain/1.0)")
            .build()?;
        let resp = client.get(url).send().await?;
        let html = resp.text().await?;
        let title = scraper::Html::parse_document(&html)
            .select(&scraper::Selector::parse("title").unwrap())
            .next()
            .map(|el| el.text().collect::<String>())
            .unwrap_or_default();
        Ok((title, html))
    }

    fn sanitized_content(&self, html: &str, title: &str) -> Option<String> {
        let sanitizer = ContentSanitizer::new();
        let sanitized = sanitizer.sanitize(html, title);
        if sanitized.threats_removed.iter().any(|t| t.contains("Critical")) {
            return None;
        }
        let text = scraper::Html::parse_document(&sanitized.text)
            .select(&scraper::Selector::parse("body").unwrap())
            .next()
            .map(|b| b.text().collect::<Vec<_>>().join(" "))
            .unwrap_or_default();
        if text.chars().count() < 100 {
            return None;
        }
        Some(text)
    }
}

impl agent_runtime::Agent for SearchAgent {
    fn name(&self) -> String {
        "SearchAgent".to_string()
    }

    fn capabilities(&self) -> Vec<AgentCapability> {
        vec![AgentCapability::SearchWeb]
    }

    fn init<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> {
        boxed!(ctx.status(&self.name(), AgentState::Idle, Some("search agent ready".to_string())))
    }

    fn handle_event<'a>(&'a self, ctx: &'a AgentContext, event: BrainEventEnvelope) -> AgentFuture<'a> {
        boxed!(Ok(()))
    }

    fn run_task<'a>(&'a self, ctx: &'a AgentContext, task: AgentTask) -> AgentFuture<'a> {
        boxed!(async move {
            let query = task.payload.get("query")
                .and_then(|v| v.as_str())
                .unwrap_or(&task.action);
            let engine = task.payload.get("engine")
                .and_then(|v| v.as_str())
                .unwrap_or("duckduckgo");

            ctx.status(&self.name(), AgentState::Thinking, Some("searching web".to_string()))?;

            let memory_ids = self.search_and_store(query, engine).await?;

            self.services.bus.emit(
                BrainEvent::WebSearchPerformed {
                    query: query.to_string(),
                    result_count: memory_ids.len(),
                    sources: vec![],
                    at: Utc::now(),
                },
                Some("SearchAgent".to_string()),
            )?;

            ctx.status(&self.name(), AgentState::Idle, None)?;
            Ok(())
        })
    }

    fn shutdown<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> {
        boxed!(ctx.status(&self.name(), AgentState::Stopped, None))
    }
}

use scraper::Selector;
use memory_cortex::memory;