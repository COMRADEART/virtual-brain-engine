//! # Context Activation System

use crate::{AttentionFocus, WorkingMemory, WorkingMemoryEntry, WorkingMemoryId, WorkingMemoryType};
use chrono::Timelike;
use std::collections::{VecDeque, HashMap};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct ContextSignature {
    pub project: Option<String>,
    pub task_type: Option<String>,
    pub tools: Vec<String>,
    pub files: Vec<String>,
    pub agents: Vec<String>,
    pub time_context: TimeContext,
    pub emotional_state: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeContext {
    Morning,
    Afternoon,
    Evening,
    Night,
    Unknown,
}

impl ContextSignature {
    pub fn from_focus(focus: &AttentionFocus) -> Self {
        let now = chrono::Utc::now();
        let hour = now.hour();

        let time = if hour >= 5 && hour < 12 {
            TimeContext::Morning
        } else if hour >= 12 && hour < 17 {
            TimeContext::Afternoon
        } else if hour >= 17 && hour < 21 {
            TimeContext::Evening
        } else {
            TimeContext::Night
        };

        let mut tools = Vec::new();
        let mut files = Vec::new();
        let mut project = None;

        let content_lower = focus.content.to_lowercase();

        if let Some(colon_pos) = focus.content.find(':') {
            let potential_project = focus.content[..colon_pos].trim();
            if !potential_project.is_empty() && potential_project.len() < 50 {
                project = Some(potential_project.to_string());
            }
        }

        let tool_keywords = ["compile", "build", "test", "debug", "deploy", "run", "execute"];
        for tool in tool_keywords {
            if content_lower.contains(tool) {
                tools.push(tool.to_string());
            }
        }

        if content_lower.contains(".rs")
            || content_lower.contains(".ts")
            || content_lower.contains(".js")
            || content_lower.contains(".py")
        {
            for ext in [".rs", ".ts", ".js", ".py", ".go", ".java"] {
                if content_lower.contains(ext) {
                    files.push(ext.to_string());
                }
            }
        }

        Self {
            project,
            task_type: None,
            tools,
            files,
            agents: Vec::new(),
            time_context: time,
            emotional_state: None,
        }
    }

    pub fn similarity(&self, other: &ContextSignature) -> f64 {
        let mut score = 0.0;
        let mut weights = 0.0;

        weights += 0.35;
        if let (Some(p1), Some(p2)) = (&self.project, &other.project) {
            if p1 == p2 {
                score += 0.35;
            } else if p1.contains(p2) || p2.contains(p1) {
                score += 0.2;
            }
        }

        weights += 0.15;
        if let (Some(t1), Some(t2)) = (&self.task_type, &other.task_type) {
            if t1 == t2 {
                score += 0.15;
            }
        }

        weights += 0.20;
        if !self.tools.is_empty() || !other.tools.is_empty() {
            let overlap: f64 = self
                .tools
                .iter()
                .filter(|t| other.tools.contains(t))
                .count() as f64;
            let union = (self.tools.len() + other.tools.len()) as f64;
            if union > 0.0 {
                score += 0.20 * (overlap / union);
            }
        }

        weights += 0.15;
        if !self.files.is_empty() || !other.files.is_empty() {
            let overlap: f64 = self
                .files
                .iter()
                .filter(|f| other.files.contains(f))
                .count() as f64;
            let union = (self.files.len() + other.files.len()) as f64;
            if union > 0.0 {
                score += 0.15 * (overlap / union);
            }
        }

        weights += 0.10;
        if self.time_context == other.time_context {
            score += 0.10;
        }

        if weights > 0.0 {
            score / weights
        } else {
            0.0
        }
    }
}

#[derive(Debug, Clone)]
pub struct MemoryContext {
    pub memory_id: String,
    pub signature: ContextSignature,
    pub importance: f64,
    pub access_count: usize,
    pub last_accessed: chrono::DateTime<chrono::Utc>,
    pub activation_count: usize,
    pub associations: Vec<String>,
}

impl MemoryContext {
    pub fn new(memory_id: String, signature: ContextSignature) -> Self {
        Self {
            memory_id,
            signature,
            importance: 0.5,
            access_count: 0,
            last_accessed: chrono::Utc::now(),
            activation_count: 0,
            associations: Vec::new(),
        }
    }

    pub fn record_access(&mut self) {
        self.access_count += 1;
        self.last_accessed = chrono::Utc::now();
        self.activation_count += 1;
    }
}

pub struct ContextActivator {
    pub memory_contexts: HashMap<String, MemoryContext>,
    pub context_stack: VecDeque<ContextSignature>,
    pub recent_activations: VecDeque<(String, chrono::DateTime<chrono::Utc>)>,
    pub activation_threshold: f64,
}

impl ContextActivator {
    pub fn new() -> Self {
        Self {
            memory_contexts: HashMap::new(),
            context_stack: VecDeque::with_capacity(20),
            recent_activations: VecDeque::with_capacity(100),
            activation_threshold: 0.4,
        }
    }

    pub fn register_memory(&mut self, memory_id: String, signature: ContextSignature) {
        let ctx = MemoryContext::new(memory_id.clone(), signature);
        self.memory_contexts.insert(memory_id, ctx);
    }

    pub fn activate_context(
        &mut self,
        focus: &AttentionFocus,
        working_memory: &mut WorkingMemory,
    ) -> Vec<String> {
        let current_sig = ContextSignature::from_focus(focus);

        self.context_stack.push_front(current_sig.clone());
        if self.context_stack.len() > 20 {
            self.context_stack.pop_back();
        }

        let mut activated = Vec::new();
        let mut relevance_scores: Vec<(String, f64)> = self
            .memory_contexts
            .iter()
            .map(|(id, ctx)| {
                let score = current_sig.similarity(&ctx.signature);
                (id.clone(), score)
            })
            .filter(|(_, score)| *score >= self.activation_threshold)
            .collect();

        relevance_scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        let max_activations = 8;
        for (memory_id, score) in relevance_scores.into_iter().take(max_activations) {
            if let Some(ctx) = self.memory_contexts.get_mut(&memory_id) {
                ctx.record_access();
            }

            let entry = WorkingMemoryEntry::new(
                format!("Activated memory: {}", memory_id),
                WorkingMemoryType::Memory,
                score,
            );
            working_memory.add(entry);

            activated.push(memory_id.clone());

            self.recent_activations.push_front((memory_id, chrono::Utc::now()));
            if self.recent_activations.len() > 100 {
                self.recent_activations.pop_back();
            }
        }

        self.update_associations(&activated);

        activated
    }

    fn update_associations(&mut self, activated: &[String]) {
        for id1 in activated {
            for id2 in activated {
                if id1 != id2 {
                    if let Some(ctx1) = self.memory_contexts.get_mut(id1) {
                        if !ctx1.associations.contains(id2) {
                            ctx1.associations.push(id2.clone());
                        }
                    }
                }
            }
        }
    }

    pub fn get_recent_activations(&self, limit: usize) -> Vec<String> {
        self.recent_activations
            .iter()
            .take(limit)
            .map(|(id, _)| id.clone())
            .collect()
    }

    pub fn get_associated_memories(&self, memory_id: &str) -> Vec<String> {
        self.memory_contexts
            .get(memory_id)
            .map(|ctx| ctx.associations.clone())
            .unwrap_or_default()
    }

    pub fn get_stats(&self) -> ContextStats {
        let total_activations: usize = self.memory_contexts.values().map(|c| c.activation_count).sum();
        let avg_importance: f64 = self
            .memory_contexts
            .values()
            .map(|c| c.importance)
            .sum::<f64>()
            / self.memory_contexts.len().max(1) as f64;

        ContextStats {
            registered_memories: self.memory_contexts.len(),
            total_activations,
            avg_importance,
            recent_activation_count: self.recent_activations.len(),
            context_stack_depth: self.context_stack.len(),
        }
    }

    pub fn decay(&mut self, elapsed_ms: u64) {
        let decay_factor = 0.999f64.powf(elapsed_ms as f64 / 60000.0);
        for ctx in self.memory_contexts.values_mut() {
            ctx.activation_count = (ctx.activation_count as f64 * decay_factor) as usize;
            ctx.importance *= decay_factor;
            ctx.importance = ctx.importance.max(0.1);
        }
    }
}

impl Default for ContextActivator {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone)]
pub struct ContextStats {
    pub registered_memories: usize,
    pub total_activations: usize,
    pub avg_importance: f64,
    pub recent_activation_count: usize,
    pub context_stack_depth: usize,
}