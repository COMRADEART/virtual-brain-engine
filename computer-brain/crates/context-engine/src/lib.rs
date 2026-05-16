use chrono::Utc;
use serde::{Deserialize, Serialize};
use shared_types::{BrainId, MemoryRecord, ProjectRecord};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextSnapshot {
    pub id: BrainId,
    pub project_id: Option<BrainId>,
    pub active_files: Vec<String>,
    pub relevant_memory_ids: Vec<BrainId>,
    pub likely_intent: String,
    pub confidence: f32,
    pub summary: String,
    pub created_at: chrono::DateTime<Utc>,
}

#[derive(Clone, Default)]
pub struct ContextEngine;

impl ContextEngine {
    pub fn infer(
        &self,
        prompt: Option<&str>,
        projects: &[ProjectRecord],
        memories: &[MemoryRecord],
        active_files: Vec<String>,
    ) -> ContextSnapshot {
        let prompt_text = prompt.unwrap_or_default().to_ascii_lowercase();
        let project = projects.first();
        let relevant = memories
            .iter()
            .filter(|memory| {
                prompt_text.is_empty()
                    || tokenize(&memory.content)
                        .into_iter()
                        .any(|token| prompt_text.contains(&token))
            })
            .take(8)
            .map(|m| m.id.clone())
            .collect::<Vec<_>>();
        let likely_intent = if prompt_text.contains("bug") || prompt_text.contains("fix") {
            "debugging"
        } else if prompt_text.contains("what did") || prompt_text.contains("last week") {
            "temporal-recall"
        } else if prompt_text.contains("search") || prompt_text.contains("recall") {
            "memory-retrieval"
        } else if !active_files.is_empty() {
            "project-work"
        } else {
            "ambient-awareness"
        }
        .to_string();
        let confidence = (0.25_f32
            + if project.is_some() { 0.2_f32 } else { 0.0_f32 }
            + if !relevant.is_empty() { 0.25_f32 } else { 0.0_f32 }
            + if !active_files.is_empty() { 0.18_f32 } else { 0.0_f32 })
            .min(0.96_f32);
        let summary = format!(
            "{} intent in {}; {} related memories; {} active files",
            likely_intent,
            project.map(|p| p.name.as_str()).unwrap_or("local workspace"),
            relevant.len(),
            active_files.len()
        );
        ContextSnapshot {
            id: shared_types::new_id("ctx"),
            project_id: project.map(|p| p.id.clone()),
            active_files,
            relevant_memory_ids: relevant,
            likely_intent,
            confidence,
            summary,
            created_at: Utc::now(),
        }
    }
}

fn tokenize(text: &str) -> Vec<String> {
    text.to_ascii_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| s.len() > 4)
        .take(32)
        .map(ToString::to_string)
        .collect()
}
