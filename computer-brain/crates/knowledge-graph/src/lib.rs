use anyhow::Result;
use chrono::Utc;
use memory_cortex::MemoryCortex;
use serde_json::Value;
use shared_types::{
    new_id, BrainId, GraphEdgeKind, GraphEdgeRecord, GraphNodeKind, GraphNodeRecord, MemoryRecord,
};

#[derive(Clone)]
pub struct KnowledgeGraph {
    memory: MemoryCortex,
}

impl KnowledgeGraph {
    pub fn new(memory: MemoryCortex) -> Self {
        Self { memory }
    }

    pub fn ingest_memory(&self, memory: &MemoryRecord) -> Result<(usize, usize)> {
        let now = Utc::now();
        let memory_node = GraphNodeRecord {
            id: stable_id("memory", &memory.id),
            kind: GraphNodeKind::Memory,
            label: memory.title.clone().unwrap_or_else(|| memory.id.clone()),
            project_id: memory.project_id.clone(),
            metadata: serde_json::json!({ "memory_id": memory.id }),
            created_at: now,
            updated_at: now,
        };
        self.memory.upsert_graph_node(&memory_node)?;

        let mut node_count = 1;
        let mut edge_count = 0;
        if let Some(path) = &memory.source_path {
            let file_node = GraphNodeRecord {
                id: stable_id("file", path),
                kind: GraphNodeKind::File,
                label: path.clone(),
                project_id: memory.project_id.clone(),
                metadata: serde_json::json!({ "path": path }),
                created_at: now,
                updated_at: now,
            };
            self.memory.upsert_graph_node(&file_node)?;
            self.memory.upsert_graph_edge(&edge(&file_node.id, &memory_node.id, GraphEdgeKind::ProducedBy, 0.82, serde_json::json!({})))?;
            node_count += 1;
            edge_count += 1;
        }

        for concept in extract_concepts(&memory.content).into_iter().take(10) {
            let concept_node = GraphNodeRecord {
                id: stable_id("concept", &concept),
                kind: GraphNodeKind::Concept,
                label: concept,
                project_id: memory.project_id.clone(),
                metadata: serde_json::json!({}),
                created_at: now,
                updated_at: now,
            };
            self.memory.upsert_graph_node(&concept_node)?;
            self.memory.upsert_graph_edge(&edge(&memory_node.id, &concept_node.id, GraphEdgeKind::Mentions, 0.55, serde_json::json!({})))?;
            node_count += 1;
            edge_count += 1;
        }

        Ok((node_count, edge_count))
    }

    pub fn snapshot(&self, limit: usize) -> Result<(Vec<GraphNodeRecord>, Vec<GraphEdgeRecord>)> {
        self.memory.graph(limit)
    }
}

pub fn extract_concepts(content: &str) -> Vec<String> {
    let mut out = Vec::new();
    for word in content.split_whitespace() {
        let cleaned = word.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-');
        if cleaned.len() < 4 {
            continue;
        }
        let lower = cleaned.to_ascii_lowercase();
        let is_concept = cleaned.contains('-')
            || cleaned.chars().any(|c| c.is_ascii_uppercase())
            || lower.ends_with("engine")
            || lower.ends_with("system")
            || lower.ends_with("agent")
            || lower.ends_with("memory")
            || lower.ends_with("runtime")
            || lower.ends_with("graph");
        if is_concept && !out.iter().any(|v| v == cleaned) {
            out.push(cleaned.to_string());
        }
    }
    out
}

fn edge(from_id: &str, to_id: &str, kind: GraphEdgeKind, weight: f32, metadata: Value) -> GraphEdgeRecord {
    let now = Utc::now();
    GraphEdgeRecord {
        id: stable_id("edge", &format!("{from_id}:{to_id}:{kind:?}")),
        from_id: from_id.to_string(),
        to_id: to_id.to_string(),
        kind,
        weight,
        metadata,
        created_at: now,
        updated_at: now,
    }
}

fn stable_id(prefix: &str, value: &str) -> BrainId {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{prefix}-{hash:016x}")
}

pub fn project_node(name: &str, project_id: Option<BrainId>) -> GraphNodeRecord {
    let now = Utc::now();
    GraphNodeRecord {
        id: project_id.unwrap_or_else(|| new_id("proj-node")),
        kind: GraphNodeKind::Project,
        label: name.to_string(),
        project_id: None,
        metadata: serde_json::json!({}),
        created_at: now,
        updated_at: now,
    }
}
