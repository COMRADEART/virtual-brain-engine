use anyhow::Result;
use shared_types::{BrainId, MemoryRecord};
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap};

#[derive(Debug, Clone)]
pub struct EmbeddingModel {
    pub name: String,
    pub dimensions: usize,
}

impl Default for EmbeddingModel {
    fn default() -> Self {
        Self {
            name: "local-hash-embedding".to_string(),
            dimensions: 384,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SemanticHit {
    pub memory: MemoryRecord,
    pub score: f32,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SemanticCluster {
    pub id: BrainId,
    pub topic: String,
    pub memory_ids: Vec<BrainId>,
    pub coherence: f32,
}

#[derive(Clone)]
pub struct SemanticMemory {
    model: EmbeddingModel,
}

impl SemanticMemory {
    pub fn new(dimensions: usize) -> Self {
        Self {
            model: EmbeddingModel {
                dimensions: dimensions.max(32),
                ..EmbeddingModel::default()
            },
        }
    }

    pub fn model_name(&self) -> &str {
        &self.model.name
    }

    pub fn embed(&self, text: &str) -> Vec<f32> {
        let mut values = vec![0.0; self.model.dimensions];
        let tokens = tokenize(text);
        for token in &tokens {
            add_feature(&mut values, token, 1.0);
            if token.len() > 5 {
                for gram in char_grams(token, 4) {
                    add_feature(&mut values, &format!("sub:{gram}"), 0.3);
                }
            }
        }
        for pair in tokens.windows(2) {
            add_feature(&mut values, &format!("{} {}", pair[0], pair[1]), 1.2);
        }
        normalize(&mut values);
        values
    }

    pub fn search(
        &self,
        query: &str,
        vectors: Vec<(MemoryRecord, Vec<f32>)>,
        limit: usize,
        min_score: f32,
    ) -> Result<Vec<SemanticHit>> {
        let query_vec = self.embed(query);
        let query_tokens = tokenize(query);
        let mut hits = vectors
            .into_iter()
            .filter_map(|(memory, vector)| {
                let semantic = cosine(&query_vec, &vector);
                let lexical = lexical_overlap(&query_tokens, &tokenize(&memory.content));
                let score = (semantic * 0.78 + lexical * 0.16 + memory.importance * 0.06).clamp(0.0, 1.0);
                if score < min_score {
                    return None;
                }
                Some(SemanticHit {
                    memory,
                    score,
                    reasons: vec![format!("semantic={semantic:.2}"), format!("lexical={lexical:.2}")],
                })
            })
            .collect::<Vec<_>>();
        hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(Ordering::Equal));
        hits.truncate(limit.max(1));
        Ok(hits)
    }

    pub fn clusters(&self, vectors: Vec<(MemoryRecord, Vec<f32>)>, threshold: f32) -> Vec<SemanticCluster> {
        let mut centroids: BTreeMap<BrainId, Vec<f32>> = BTreeMap::new();
        let mut clusters: Vec<SemanticCluster> = Vec::new();
        let threshold = threshold.clamp(0.1, 0.95);

        'outer: for (memory, vector) in vectors {
            for cluster in &mut clusters {
                if let Some(centroid) = centroids.get_mut(&cluster.id) {
                    let similarity = cosine(&vector, centroid);
                    if similarity >= threshold {
                        cluster.memory_ids.push(memory.id.clone());
                        update_centroid(centroid, &vector, cluster.memory_ids.len());
                        cluster.coherence = ((cluster.coherence + similarity) / 2.0).clamp(0.0, 1.0);
                        continue 'outer;
                    }
                }
            }

            let id = shared_types::new_id("cluster");
            centroids.insert(id.clone(), vector);
            clusters.push(SemanticCluster {
                id,
                topic: topic_from(&memory),
                memory_ids: vec![memory.id],
                coherence: 1.0,
            });
        }

        clusters
    }
}

fn tokenize(text: &str) -> Vec<String> {
    text.to_ascii_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '-')
        .filter(|part| part.len() > 1)
        .map(ToString::to_string)
        .collect()
}

fn char_grams(text: &str, size: usize) -> Vec<String> {
    let chars = text.chars().collect::<Vec<_>>();
    chars.windows(size).map(|w| w.iter().collect()).collect()
}

fn add_feature(values: &mut [f32], feature: &str, weight: f32) {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in feature.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    let index = (hash as usize) % values.len();
    let sign = if hash & 1 == 0 { 1.0 } else { -1.0 };
    values[index] += weight * sign;
}

fn normalize(values: &mut [f32]) {
    let norm = values.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > 0.0 {
        for value in values {
            *value /= norm;
        }
    }
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0;
    let mut na = 0.0;
    let mut nb = 0.0;
    for (av, bv) in a.iter().zip(b) {
        dot += av * bv;
        na += av * av;
        nb += bv * bv;
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    ((dot / (na.sqrt() * nb.sqrt())) + 1.0) / 2.0
}

fn lexical_overlap(query: &[String], content: &[String]) -> f32 {
    if query.is_empty() {
        return 0.0;
    }
    let mut counts = HashMap::new();
    for token in content {
        *counts.entry(token.as_str()).or_insert(0usize) += 1;
    }
    query.iter().filter(|t| counts.contains_key(t.as_str())).count() as f32 / query.len() as f32
}

fn update_centroid(centroid: &mut [f32], vector: &[f32], count: usize) {
    let previous = count.saturating_sub(1) as f32;
    let count = count as f32;
    for (c, v) in centroid.iter_mut().zip(vector) {
        *c = ((*c * previous) + *v) / count;
    }
    normalize(centroid);
}

fn topic_from(memory: &MemoryRecord) -> String {
    memory
        .tags
        .first()
        .cloned()
        .or_else(|| memory.title.clone())
        .unwrap_or_else(|| {
            tokenize(&memory.content)
                .into_iter()
                .find(|token| token.len() > 4)
                .unwrap_or_else(|| "memory".to_string())
        })
}
