use anyhow::Result;
use brain_core::{BrainCore, BrainDashboard};
use serde::{Deserialize, Serialize};
use shared_types::{BrainConfig, GraphEdgeRecord, GraphNodeRecord, MemoryRecord};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct DesktopBridge {
    core: Arc<Mutex<BrainCore>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatInput {
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatOutput {
    pub answer: String,
    pub related_memories: Vec<semantic_memory::SemanticHit>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngestMemoryInput {
    pub content: String,
    pub tags: Vec<String>,
    pub source_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectInput {
    pub root_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandInput {
    pub command: String,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphOutput {
    pub nodes: Vec<GraphNodeRecord>,
    pub edges: Vec<GraphEdgeRecord>,
}

impl DesktopBridge {
    pub async fn boot(config: BrainConfig) -> Result<Self> {
        let mut core = BrainCore::boot(config)?;
        core.start().await?;
        Ok(Self {
            core: Arc::new(Mutex::new(core)),
        })
    }

    pub async fn dashboard(&self) -> Result<BrainDashboard> {
        self.core.lock().await.dashboard()
    }

    pub async fn chat(&self, input: ChatInput) -> Result<ChatOutput> {
        let hits = self.core.lock().await.user_message(input.message.clone()).await?;
        let answer = if hits.is_empty() {
            "I recorded that locally. No related memories were found yet.".to_string()
        } else {
            format!(
                "I found {} related memories. Strongest match: {}",
                hits.len(),
                hits[0].memory.title.clone().unwrap_or_else(|| hits[0].memory.id.clone())
            )
        };
        Ok(ChatOutput {
            answer,
            related_memories: hits,
        })
    }

    pub async fn ingest_memory(&self, input: IngestMemoryInput) -> Result<MemoryRecord> {
        self.core
            .lock()
            .await
            .ingest_memory(input.content, input.tags, input.source_path)
    }

    pub async fn observe_project(&self, input: ProjectInput) -> Result<shared_types::ProjectRecord> {
        self.core
            .lock()
            .await
            .observe_project(PathBuf::from(input.root_path))
    }

    pub async fn run_command(&self, input: CommandInput) -> Result<()> {
        self.core.lock().await.run_command(input.command, input.cwd).await
    }

    pub async fn graph(&self) -> Result<GraphOutput> {
        let (nodes, edges) = self.core.lock().await.graph_snapshot()?;
        Ok(GraphOutput { nodes, edges })
    }
}
