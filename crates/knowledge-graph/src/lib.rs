use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum GraphNodeKind {
    Project,
    File,
    System,
    Concept,
    Agent,
    Summary,
    Memory,
    Bug,
    Commit,
    Discussion,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphNode {
    pub id: String,
    pub kind: GraphNodeKind,
    pub label: String,
    pub project: Option<String>,
    pub metadata: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum GraphEdgeKind {
    Contains,
    DependsOn,
    Implements,
    Mentions,
    DerivedFrom,
    RelatedTo,
    TriggeredBy,
    FixedBy,
    EvolvesInto,
    OwnedBy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphEdge {
    pub id: String,
    pub from_id: String,
    pub to_id: String,
    pub kind: GraphEdgeKind,
    pub weight: f32,
    pub metadata: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchitectureSnapshot {
    pub project: String,
    pub systems: Vec<GraphNode>,
    pub dependencies: Vec<GraphEdge>,
    pub concepts: Vec<GraphNode>,
    pub generated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct KnowledgeGraph {
    nodes: BTreeMap<String, GraphNode>,
    edges: BTreeMap<String, GraphEdge>,
}

impl KnowledgeGraph {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn nodes(&self) -> impl Iterator<Item = &GraphNode> {
        self.nodes.values()
    }

    pub fn edges(&self) -> impl Iterator<Item = &GraphEdge> {
        self.edges.values()
    }

    pub fn upsert_node(
        &mut self,
        kind: GraphNodeKind,
        label: impl Into<String>,
        project: Option<String>,
        metadata: serde_json::Value,
    ) -> GraphNode {
        let label = label.into();
        let id = stable_node_id(&kind, project.as_deref(), &label);
        let now = Utc::now();
        let node = self.nodes.entry(id.clone()).or_insert_with(|| GraphNode {
            id: id.clone(),
            kind,
            label,
            project,
            metadata: serde_json::json!({}),
            created_at: now,
            updated_at: now,
        });
        node.metadata = merge_json(&node.metadata, &metadata);
        node.updated_at = now;
        node.clone()
    }

    pub fn upsert_edge(
        &mut self,
        from_id: impl Into<String>,
        to_id: impl Into<String>,
        kind: GraphEdgeKind,
        weight: f32,
        metadata: serde_json::Value,
    ) -> GraphEdge {
        let from_id = from_id.into();
        let to_id = to_id.into();
        let id = stable_edge_id(&from_id, &to_id, &kind);
        let now = Utc::now();
        let edge = self.edges.entry(id.clone()).or_insert_with(|| GraphEdge {
            id: id.clone(),
            from_id,
            to_id,
            kind,
            weight: weight.clamp(0.0, 1.0),
            metadata: serde_json::json!({}),
            created_at: now,
            updated_at: now,
        });
        edge.weight = edge.weight.max(weight.clamp(0.0, 1.0));
        edge.metadata = merge_json(&edge.metadata, &metadata);
        edge.updated_at = now;
        edge.clone()
    }

    pub fn neighbors(&self, node_id: &str) -> Vec<&GraphNode> {
        self.edges
            .values()
            .filter_map(|edge| {
                if edge.from_id == node_id {
                    self.nodes.get(&edge.to_id)
                } else if edge.to_id == node_id {
                    self.nodes.get(&edge.from_id)
                } else {
                    None
                }
            })
            .collect()
    }

    pub fn ingest_memory(
        &mut self,
        memory_id: &str,
        project: Option<&str>,
        source_path: Option<&str>,
        content: &str,
    ) -> Vec<GraphNode> {
        let mut created = Vec::new();
        let project_node = project.map(|project| {
            self.upsert_node(
                GraphNodeKind::Project,
                project,
                Some(project.to_string()),
                serde_json::json!({ "source": "memory-ingest" }),
            )
        });
        if let Some(node) = &project_node {
            created.push(node.clone());
        }

        let memory_node = self.upsert_node(
            GraphNodeKind::Memory,
            memory_id,
            project.map(ToString::to_string),
            serde_json::json!({ "preview": trim_preview(content, 180) }),
        );
        created.push(memory_node.clone());

        if let Some(project_node) = &project_node {
            self.upsert_edge(
                project_node.id.clone(),
                memory_node.id.clone(),
                GraphEdgeKind::Contains,
                0.72,
                serde_json::json!({}),
            );
        }

        if let Some(path) = source_path {
            let file_node = self.upsert_node(
                GraphNodeKind::File,
                path,
                project.map(ToString::to_string),
                serde_json::json!({ "path": path }),
            );
            self.upsert_edge(
                file_node.id.clone(),
                memory_node.id.clone(),
                GraphEdgeKind::DerivedFrom,
                0.84,
                serde_json::json!({}),
            );
            if let Some(project_node) = &project_node {
                self.upsert_edge(
                    project_node.id.clone(),
                    file_node.id.clone(),
                    GraphEdgeKind::Contains,
                    0.9,
                    serde_json::json!({}),
                );
            }
            created.push(file_node);
        }

        for concept in extract_concepts(content).into_iter().take(12) {
            let concept_node = self.upsert_node(
                GraphNodeKind::Concept,
                concept,
                project.map(ToString::to_string),
                serde_json::json!({ "source": "concept-extraction" }),
            );
            self.upsert_edge(
                memory_node.id.clone(),
                concept_node.id.clone(),
                GraphEdgeKind::Mentions,
                0.62,
                serde_json::json!({}),
            );
            created.push(concept_node);
        }

        created
    }

    pub fn architecture_snapshot(&self, project: &str) -> ArchitectureSnapshot {
        let systems = self
            .nodes
            .values()
            .filter(|node| node.project.as_deref() == Some(project) && node.kind == GraphNodeKind::System)
            .cloned()
            .collect::<Vec<_>>();
        let concepts = self
            .nodes
            .values()
            .filter(|node| node.project.as_deref() == Some(project) && node.kind == GraphNodeKind::Concept)
            .cloned()
            .collect::<Vec<_>>();
        let system_ids = systems.iter().map(|n| n.id.as_str()).collect::<BTreeSet<_>>();
        let dependencies = self
            .edges
            .values()
            .filter(|edge| {
                edge.kind == GraphEdgeKind::DependsOn
                    && (system_ids.contains(edge.from_id.as_str())
                        || system_ids.contains(edge.to_id.as_str()))
            })
            .cloned()
            .collect();
        ArchitectureSnapshot {
            project: project.to_string(),
            systems,
            dependencies,
            concepts,
            generated_at: Utc::now(),
        }
    }
}

pub fn extract_concepts(content: &str) -> Vec<String> {
    let mut concepts = BTreeSet::new();
    let normalized = content.replace(['_', '/', '\\', '.'], " ");
    let words = normalized.split_whitespace().collect::<Vec<_>>();

    for window in words.windows(2) {
        let joined = format!("{} {}", clean_word(window[0]), clean_word(window[1]));
        if looks_like_concept(&joined) {
            concepts.insert(title_case(&joined));
        }
    }

    for word in words {
        let cleaned = clean_word(word);
        if looks_like_concept(&cleaned) {
            concepts.insert(title_case(&cleaned));
        }
    }

    concepts.into_iter().collect()
}

pub fn stable_node_id(kind: &GraphNodeKind, project: Option<&str>, label: &str) -> String {
    stable_id(&format!("node::{kind:?}::{:?}::{label}", project.unwrap_or("")))
}

pub fn stable_edge_id(from_id: &str, to_id: &str, kind: &GraphEdgeKind) -> String {
    stable_id(&format!("edge::{from_id}::{to_id}::{kind:?}"))
}

fn stable_id(input: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in input.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("kg-{hash:016x}")
}

fn clean_word(word: &str) -> String {
    word.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-')
        .to_string()
}

fn looks_like_concept(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.len() < 4 || trimmed.len() > 64 {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    let stop = [
        "this", "that", "with", "from", "into", "the", "and", "for", "when", "what", "last",
        "next", "create", "update", "delete",
    ];
    if stop.contains(&lower.as_str()) {
        return false;
    }
    trimmed.contains('-')
        || trimmed.chars().any(|c| c.is_ascii_uppercase())
        || lower.ends_with("engine")
        || lower.ends_with("system")
        || lower.ends_with("agent")
        || lower.ends_with("memory")
        || lower.ends_with("runtime")
        || lower.ends_with("graph")
}

fn title_case(text: &str) -> String {
    text.split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn trim_preview(text: &str, max: usize) -> String {
    let mut out = String::new();
    for ch in text.chars().take(max) {
        out.push(ch);
    }
    if text.chars().count() > max {
        out.push_str("...");
    }
    out
}

fn merge_json(left: &serde_json::Value, right: &serde_json::Value) -> serde_json::Value {
    match (left, right) {
        (serde_json::Value::Object(a), serde_json::Value::Object(b)) => {
            let mut merged = a.clone();
            for (key, value) in b {
                merged.insert(key.clone(), value.clone());
            }
            serde_json::Value::Object(merged)
        }
        (_, serde_json::Value::Null) => left.clone(),
        (_, other) => other.clone(),
    }
}
