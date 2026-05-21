use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ContextSignalKind {
    ActiveFile,
    FileChange,
    GitActivity,
    UserPrompt,
    RuntimeActivity,
    MemoryRecall,
    SystemMetric,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextSignal {
    pub kind: ContextSignalKind,
    pub project_path: Option<String>,
    pub detail: String,
    pub weight: f32,
    pub observed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryReference {
    pub id: String,
    pub score: f32,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextSnapshot {
    pub id: String,
    pub project_path: Option<String>,
    pub project_name: Option<String>,
    pub active_files: Vec<String>,
    pub related_memories: Vec<MemoryReference>,
    pub relevant_tools: Vec<String>,
    pub likely_intent: String,
    pub confidence: f32,
    pub summary: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default)]
pub struct ContextEngine {
    tool_markers: BTreeMap<&'static str, &'static str>,
}

impl ContextEngine {
    pub fn new() -> Self {
        let tool_markers = BTreeMap::from([
            ("Cargo.toml", "rust"),
            ("src-tauri", "tauri"),
            ("tauri.conf.json", "tauri"),
            ("package.json", "node"),
            ("vite.config", "vite"),
            (".uproject", "unreal"),
            (".uplugin", "unreal"),
            ("CMakeLists.txt", "cmake"),
            ("docker-compose", "docker"),
        ]);
        Self { tool_markers }
    }

    pub fn build_snapshot(
        &self,
        project_path: Option<String>,
        project_name: Option<String>,
        active_files: Vec<String>,
        memories: Vec<MemoryReference>,
        signals: Vec<ContextSignal>,
    ) -> ContextSnapshot {
        let relevant_tools = self.detect_tools(&project_path, &active_files, &signals);
        let likely_intent = infer_intent(&active_files, &signals, &memories);
        let confidence = confidence_score(&active_files, &memories, &signals, &relevant_tools);
        let summary = summarize_context(
            project_name.as_deref(),
            &likely_intent,
            &relevant_tools,
            active_files.len(),
            memories.len(),
        );

        ContextSnapshot {
            id: Uuid::new_v4().to_string(),
            project_path,
            project_name,
            active_files,
            related_memories: memories,
            relevant_tools,
            likely_intent,
            confidence,
            summary,
            created_at: Utc::now(),
        }
    }

    fn detect_tools(
        &self,
        project_path: &Option<String>,
        active_files: &[String],
        signals: &[ContextSignal],
    ) -> Vec<String> {
        let mut tools = BTreeSet::new();
        let corpus = project_path
            .iter()
            .chain(active_files.iter())
            .chain(signals.iter().map(|s| &s.detail))
            .map(|s| s.to_ascii_lowercase())
            .collect::<Vec<_>>();

        for item in &corpus {
            for (marker, tool) in &self.tool_markers {
                if item.contains(&marker.to_ascii_lowercase()) {
                    tools.insert((*tool).to_string());
                }
            }
            if item.ends_with(".rs") {
                tools.insert("rust".to_string());
            }
            if item.ends_with(".tsx") || item.ends_with(".ts") || item.ends_with(".jsx") {
                tools.insert("react".to_string());
                tools.insert("typescript".to_string());
            }
            if item.ends_with(".cpp") || item.ends_with(".h") {
                tools.insert("cpp".to_string());
            }
            if item.ends_with(".py") {
                tools.insert("python".to_string());
            }
        }

        tools.into_iter().collect()
    }
}

impl Default for ContextSignal {
    fn default() -> Self {
        Self {
            kind: ContextSignalKind::RuntimeActivity,
            project_path: None,
            detail: String::new(),
            weight: 0.5,
            observed_at: Utc::now(),
        }
    }
}

fn infer_intent(
    active_files: &[String],
    signals: &[ContextSignal],
    memories: &[MemoryReference],
) -> String {
    let text = active_files
        .iter()
        .chain(signals.iter().map(|s| &s.detail))
        .map(|s| s.to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join(" ");

    if text.contains("error") || text.contains("panic") || text.contains("bug") || text.contains("fix") {
        "debugging".to_string()
    } else if text.contains("test") || text.contains("spec") || text.contains("selfcheck") {
        "verification".to_string()
    } else if text.contains("summary") || text.contains("digest") || text.contains("timeline") {
        "summarization".to_string()
    } else if !memories.is_empty() && signals.iter().any(|s| matches!(s.kind, ContextSignalKind::UserPrompt)) {
        "memory-assisted-answering".to_string()
    } else if !active_files.is_empty() {
        "implementation".to_string()
    } else {
        "ambient-monitoring".to_string()
    }
}

fn confidence_score(
    active_files: &[String],
    memories: &[MemoryReference],
    signals: &[ContextSignal],
    tools: &[String],
) -> f32 {
    let mut score: f32 = 0.2;
    if !active_files.is_empty() {
        score += 0.22;
    }
    if !memories.is_empty() {
        score += memories.iter().map(|m| m.score).sum::<f32>() / memories.len() as f32 * 0.25;
    }
    if !signals.is_empty() {
        score += signals.iter().map(|s| s.weight).sum::<f32>() / signals.len() as f32 * 0.18;
    }
    if !tools.is_empty() {
        score += 0.15;
    }
    score.clamp(0.0, 0.98)
}

fn summarize_context(
    project_name: Option<&str>,
    intent: &str,
    tools: &[String],
    active_file_count: usize,
    memory_count: usize,
) -> String {
    let project = project_name.unwrap_or("current workspace");
    let tools = if tools.is_empty() {
        "unknown stack".to_string()
    } else {
        tools.join(", ")
    };
    format!(
        "{project}: likely {intent}; stack {tools}; {active_file_count} active files; {memory_count} related memories."
    )
}
