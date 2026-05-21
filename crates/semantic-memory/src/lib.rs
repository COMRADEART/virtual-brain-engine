use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingVector {
    pub model: String,
    pub dimensions: usize,
    pub values: Vec<f32>,
}

impl EmbeddingVector {
    pub fn normalized(mut self) -> Self {
        normalize_l2(&mut self.values);
        self.dimensions = self.values.len();
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingError {
    pub message: String,
}

impl std::fmt::Display for EmbeddingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for EmbeddingError {}

pub trait EmbeddingProvider: Send + Sync {
    fn model_name(&self) -> &str;
    fn dimensions(&self) -> usize;
    fn embed(&self, text: &str) -> Result<EmbeddingVector, EmbeddingError>;
}

#[derive(Debug, Clone)]
pub struct HashedEmbeddingProvider {
    model_name: String,
    dimensions: usize,
}

impl Default for HashedEmbeddingProvider {
    fn default() -> Self {
        Self::new(384)
    }
}

impl HashedEmbeddingProvider {
    pub fn new(dimensions: usize) -> Self {
        Self {
            model_name: format!("computer-brain-local-hash-{}", dimensions),
            dimensions: dimensions.max(32),
        }
    }

    fn add_feature(values: &mut [f32], feature: &str, weight: f32) {
        let mut hasher = DefaultHasher::new();
        feature.hash(&mut hasher);
        let hash = hasher.finish();
        let index = (hash as usize) % values.len();
        let sign = if (hash >> 63) == 0 { 1.0 } else { -1.0 };
        values[index] += weight * sign;
    }
}

impl EmbeddingProvider for HashedEmbeddingProvider {
    fn model_name(&self) -> &str {
        &self.model_name
    }

    fn dimensions(&self) -> usize {
        self.dimensions
    }

    fn embed(&self, text: &str) -> Result<EmbeddingVector, EmbeddingError> {
        let mut values = vec![0.0; self.dimensions];
        let tokens = tokenize(text);

        for token in &tokens {
            Self::add_feature(&mut values, token, 1.0);
            if token.len() > 5 {
                for slice in char_windows(token, 4) {
                    Self::add_feature(&mut values, &format!("sub:{slice}"), 0.35);
                }
            }
        }

        for pair in tokens.windows(2) {
            Self::add_feature(&mut values, &format!("{} {}", pair[0], pair[1]), 1.25);
        }

        if values.iter().all(|v| *v == 0.0) {
            Self::add_feature(&mut values, "empty", 1.0);
        }

        normalize_l2(&mut values);

        Ok(EmbeddingVector {
            model: self.model_name.clone(),
            dimensions: self.dimensions,
            values,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticMemoryRecord {
    pub id: String,
    pub content: String,
    pub memory_type: String,
    pub project_name: Option<String>,
    pub source_path: Option<String>,
    pub tags: Vec<String>,
    pub importance: f32,
    pub created_at: String,
    pub embedding: EmbeddingVector,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticSearchQuery {
    pub text: String,
    pub limit: usize,
    pub min_score: f32,
    pub project_name: Option<String>,
    pub memory_type: Option<String>,
}

impl Default for SemanticSearchQuery {
    fn default() -> Self {
        Self {
            text: String::new(),
            limit: 12,
            min_score: 0.18,
            project_name: None,
            memory_type: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticSearchHit {
    pub memory_id: String,
    pub score: f32,
    pub content_preview: String,
    pub project_name: Option<String>,
    pub source_path: Option<String>,
    pub memory_type: String,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryCluster {
    pub id: String,
    pub topic: String,
    pub memory_ids: Vec<String>,
    pub centroid: Vec<f32>,
    pub coherence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum VectorBackend {
    LocalSqlite,
    Qdrant { base_url: String, collection: String },
}

pub struct SemanticMemoryCortex<P: EmbeddingProvider> {
    provider: P,
    records: BTreeMap<String, SemanticMemoryRecord>,
}

impl<P: EmbeddingProvider> SemanticMemoryCortex<P> {
    pub fn new(provider: P) -> Self {
        Self {
            provider,
            records: BTreeMap::new(),
        }
    }

    pub fn provider(&self) -> &P {
        &self.provider
    }

    pub fn ingest_text(
        &mut self,
        id: String,
        content: String,
        memory_type: String,
        project_name: Option<String>,
        source_path: Option<String>,
        tags: Vec<String>,
        importance: f32,
        created_at: String,
    ) -> Result<SemanticMemoryRecord, EmbeddingError> {
        let embedding = self.provider.embed(&format!(
            "{}\n{}\n{}",
            project_name.clone().unwrap_or_default(),
            tags.join(" "),
            content
        ))?;
        let record = SemanticMemoryRecord {
            id,
            content,
            memory_type,
            project_name,
            source_path,
            tags,
            importance: importance.clamp(0.0, 1.0),
            created_at,
            embedding,
        };
        self.records.insert(record.id.clone(), record.clone());
        Ok(record)
    }

    pub fn upsert(&mut self, record: SemanticMemoryRecord) {
        self.records.insert(record.id.clone(), record);
    }

    pub fn search(&self, query: SemanticSearchQuery) -> Result<Vec<SemanticSearchHit>, EmbeddingError> {
        let limit = query.limit.clamp(1, 100);
        let query_embedding = self.provider.embed(&query.text)?;
        let query_terms = tokenize(&query.text);

        let mut hits = self
            .records
            .values()
            .filter(|record| {
                query
                    .project_name
                    .as_ref()
                    .map(|project| record.project_name.as_ref() == Some(project))
                    .unwrap_or(true)
                    && query
                        .memory_type
                        .as_ref()
                        .map(|kind| &record.memory_type == kind)
                        .unwrap_or(true)
            })
            .filter_map(|record| {
                let semantic = cosine_similarity(&query_embedding.values, &record.embedding.values);
                let lexical = lexical_overlap(&query_terms, &tokenize(&record.content));
                let importance_boost = 0.08 * record.importance.clamp(0.0, 1.0);
                let score = (semantic * 0.78 + lexical * 0.18 + importance_boost).clamp(0.0, 1.0);
                if score < query.min_score {
                    return None;
                }
                let mut reasons = vec![format!("semantic {:.2}", semantic)];
                if lexical > 0.0 {
                    reasons.push(format!("lexical {:.2}", lexical));
                }
                if record.importance >= 0.75 {
                    reasons.push("high importance".to_string());
                }
                Some(SemanticSearchHit {
                    memory_id: record.id.clone(),
                    score,
                    content_preview: preview(&record.content, 220),
                    project_name: record.project_name.clone(),
                    source_path: record.source_path.clone(),
                    memory_type: record.memory_type.clone(),
                    reasons,
                })
            })
            .collect::<Vec<_>>();

        hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(Ordering::Equal));
        hits.truncate(limit);
        Ok(hits)
    }

    pub fn clusters(&self, threshold: f32) -> Vec<MemoryCluster> {
        let mut clusters: Vec<MemoryCluster> = Vec::new();
        let threshold = threshold.clamp(0.1, 0.95);

        'record: for record in self.records.values() {
            for cluster in &mut clusters {
                let similarity = cosine_similarity(&record.embedding.values, &cluster.centroid);
                if similarity >= threshold {
                    cluster.memory_ids.push(record.id.clone());
                    update_centroid(&mut cluster.centroid, &record.embedding.values, cluster.memory_ids.len());
                    cluster.coherence = ((cluster.coherence + similarity) / 2.0).clamp(0.0, 1.0);
                    continue 'record;
                }
            }
            clusters.push(MemoryCluster {
                id: format!("cluster-{}", clusters.len() + 1),
                topic: infer_topic(&record.content, &record.tags),
                memory_ids: vec![record.id.clone()],
                centroid: record.embedding.values.clone(),
                coherence: 1.0,
            });
        }

        clusters
    }
}

#[derive(Clone)]
pub struct QdrantMemoryClient {
    client: reqwest::Client,
    base_url: String,
    collection: String,
}

impl QdrantMemoryClient {
    pub fn new(base_url: impl Into<String>, collection: impl Into<String>) -> Self {
        Self {
            client: reqwest::Client::new(),
            base_url: base_url.into().trim_end_matches('/').to_string(),
            collection: collection.into(),
        }
    }

    pub async fn upsert(
        &self,
        id: &str,
        vector: &[f32],
        payload: serde_json::Value,
    ) -> Result<(), EmbeddingError> {
        #[derive(Serialize)]
        struct Point<'a> {
            id: &'a str,
            vector: &'a [f32],
            payload: serde_json::Value,
        }

        #[derive(Serialize)]
        struct Upsert<'a> {
            points: Vec<Point<'a>>,
        }

        let url = format!(
            "{}/collections/{}/points?wait=true",
            self.base_url, self.collection
        );
        let res = self
            .client
            .put(url)
            .json(&Upsert {
                points: vec![Point { id, vector, payload }],
            })
            .send()
            .await
            .map_err(|e| EmbeddingError { message: e.to_string() })?;
        if !res.status().is_success() {
            return Err(EmbeddingError {
                message: format!("Qdrant upsert returned {}", res.status()),
            });
        }
        Ok(())
    }

    pub async fn search(
        &self,
        vector: &[f32],
        limit: usize,
    ) -> Result<Vec<QdrantSearchHit>, EmbeddingError> {
        #[derive(Serialize)]
        struct Search<'a> {
            vector: &'a [f32],
            limit: usize,
            with_payload: bool,
        }

        #[derive(Deserialize)]
        struct Response {
            result: Vec<QdrantSearchHit>,
        }

        let url = format!(
            "{}/collections/{}/points/search",
            self.base_url, self.collection
        );
        let res = self
            .client
            .post(url)
            .json(&Search {
                vector,
                limit: limit.clamp(1, 100),
                with_payload: true,
            })
            .send()
            .await
            .map_err(|e| EmbeddingError { message: e.to_string() })?;
        if !res.status().is_success() {
            return Err(EmbeddingError {
                message: format!("Qdrant search returned {}", res.status()),
            });
        }
        res.json::<Response>()
            .await
            .map(|r| r.result)
            .map_err(|e| EmbeddingError { message: e.to_string() })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QdrantSearchHit {
    pub id: serde_json::Value,
    pub score: f32,
    #[serde(default)]
    pub payload: serde_json::Value,
}

pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.is_empty() || b.is_empty() || a.len() != b.len() {
        return 0.0;
    }
    let mut dot = 0.0;
    let mut norm_a = 0.0;
    let mut norm_b = 0.0;
    for (av, bv) in a.iter().zip(b) {
        dot += av * bv;
        norm_a += av * av;
        norm_b += bv * bv;
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    ((dot / (norm_a.sqrt() * norm_b.sqrt())) + 1.0) / 2.0
}

pub fn normalize_l2(values: &mut [f32]) {
    let norm = values.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > 0.0 {
        for value in values {
            *value /= norm;
        }
    }
}

pub fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '-')
        .filter(|s| s.len() > 1)
        .map(ToString::to_string)
        .collect()
}

fn char_windows(text: &str, size: usize) -> Vec<String> {
    let chars = text.chars().collect::<Vec<_>>();
    if chars.len() < size {
        return Vec::new();
    }
    chars
        .windows(size)
        .map(|window| window.iter().collect::<String>())
        .collect()
}

fn lexical_overlap(query_terms: &[String], content_terms: &[String]) -> f32 {
    if query_terms.is_empty() || content_terms.is_empty() {
        return 0.0;
    }
    let mut counts = HashMap::<&str, usize>::new();
    for term in content_terms {
        *counts.entry(term.as_str()).or_default() += 1;
    }
    let matched = query_terms
        .iter()
        .filter(|term| counts.contains_key(term.as_str()))
        .count();
    matched as f32 / query_terms.len() as f32
}

fn preview(text: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for ch in text.chars().take(max_chars) {
        out.push(ch);
    }
    if text.chars().count() > max_chars {
        out.push_str("...");
    }
    out
}

fn update_centroid(centroid: &mut [f32], values: &[f32], count: usize) {
    if count == 0 {
        return;
    }
    let previous = count.saturating_sub(1) as f32;
    let count = count as f32;
    for (c, v) in centroid.iter_mut().zip(values) {
        *c = ((*c * previous) + *v) / count;
    }
    normalize_l2(centroid);
}

fn infer_topic(content: &str, tags: &[String]) -> String {
    if let Some(tag) = tags.first().filter(|t| !t.trim().is_empty()) {
        return tag.clone();
    }
    tokenize(content)
        .into_iter()
        .find(|token| token.len() > 4)
        .unwrap_or_else(|| "memory".to_string())
}
