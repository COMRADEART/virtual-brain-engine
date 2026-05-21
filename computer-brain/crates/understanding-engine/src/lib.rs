use chrono::{DateTime, Utc};
use perception_engine::{ObservationKind, PerceptionSource, StructuredObservation};
use serde::{Deserialize, Serialize};
use shared_types::{new_id, BrainId, MemoryRecord, ProjectRecord};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SituationalIntent {
    Debug,
    Build,
    Test,
    Recall,
    Observe,
    Learn,
    SafetyReview,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SituationalUnderstanding {
    pub id: BrainId,
    pub observation_id: BrainId,
    pub intent: SituationalIntent,
    pub summary: String,
    pub project_id: Option<BrainId>,
    pub related_memory_ids: Vec<BrainId>,
    pub relationships: Vec<String>,
    pub recurring_patterns: Vec<String>,
    pub confidence: f32,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Default)]
pub struct UnderstandingEngine;

impl UnderstandingEngine {
    pub fn understand(
        &self,
        observation: &StructuredObservation,
        projects: &[ProjectRecord],
        memories: &[MemoryRecord],
    ) -> SituationalUnderstanding {
        let text = format!("{} {}", observation.summary, observation.tags.join(" ")).to_ascii_lowercase();
        let intent = if text.contains("test") || text.contains("cargo test") {
            SituationalIntent::Test
        } else if text.contains("build") || text.contains("check") || text.contains("compile") {
            SituationalIntent::Build
        } else if text.contains("fail") || text.contains("error") || matches!(&observation.kind, ObservationKind::Failure) {
            SituationalIntent::Debug
        } else if text.contains("memory") || text.contains("recall") {
            SituationalIntent::Recall
        } else if text.contains("skill") || text.contains("learn") {
            SituationalIntent::Learn
        } else if matches!(&observation.source, PerceptionSource::System | PerceptionSource::Filesystem | PerceptionSource::Git) {
            SituationalIntent::Observe
        } else if matches!(&observation.kind, ObservationKind::SafetySignal) {
            SituationalIntent::SafetyReview
        } else {
            SituationalIntent::Unknown
        };

        let project = projects.iter().find(|project| {
            text.contains(&project.name.to_ascii_lowercase()) || text.contains(&project.root_path.to_ascii_lowercase())
        }).or_else(|| projects.first());

        let observation_tokens = tokens(&text);
        let mut related = memories
            .iter()
            .filter(|memory| {
                let content = format!("{} {}", memory.tags.join(" "), memory.content).to_ascii_lowercase();
                observation_tokens.iter().any(|token| content.contains(token))
            })
            .take(8)
            .map(|memory| memory.id.clone())
            .collect::<Vec<_>>();
        related.dedup();

        let mut relationships = Vec::new();
        if let Some(project) = project {
            relationships.push(format!("active-project:{}", project.name));
        }
        relationships.extend(observation.tags.iter().map(|tag| format!("tag:{tag}")));

        let recurring_patterns = detect_patterns(memories);
        let confidence = (observation.confidence * 0.55
            + if project.is_some() { 0.15 } else { 0.0 }
            + if !related.is_empty() { 0.2 } else { 0.0 }
            + if !recurring_patterns.is_empty() { 0.1 } else { 0.0 })
            .clamp(0.05, 0.98);

        SituationalUnderstanding {
            id: new_id("understanding"),
            observation_id: observation.id.clone(),
            intent,
            summary: format!("{}; related memories: {}; patterns: {}", observation.summary, related.len(), recurring_patterns.len()),
            project_id: project.map(|p| p.id.clone()),
            related_memory_ids: related,
            relationships,
            recurring_patterns,
            confidence,
            created_at: Utc::now(),
        }
    }
}

fn tokens(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_ascii_alphanumeric() && c != '-')
        .filter(|part| part.len() > 3)
        .take(24)
        .map(ToString::to_string)
        .collect()
}

fn detect_patterns(memories: &[MemoryRecord]) -> Vec<String> {
    let mut out = Vec::new();
    let cargo_count = memories.iter().filter(|m| m.content.contains("cargo")).count();
    let sqlite_count = memories.iter().filter(|m| m.content.to_ascii_lowercase().contains("sqlite")).count();
    if cargo_count >= 2 {
        out.push("recurring-rust-validation".to_string());
    }
    if sqlite_count >= 2 {
        out.push("recurring-sqlite-work".to_string());
    }
    out
}
