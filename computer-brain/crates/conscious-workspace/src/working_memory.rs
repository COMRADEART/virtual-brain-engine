//! # Working Memory System

use crate::{AttentionFocus, CognitivePriority, FocusType};
use hashbrown::HashMap;
use shared_types::BrainEvent;
use std::collections::VecDeque;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct WorkingMemoryId(pub Uuid);

impl WorkingMemoryId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

#[derive(Debug, Clone)]
pub struct WorkingMemoryEntry {
    pub id: WorkingMemoryId,
    pub content: String,
    pub entry_type: WorkingMemoryType,
    pub importance: f64,
    pub attention_weight: f64,
    pub access_count: usize,
    pub last_accessed: chrono::DateTime<chrono::Utc>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub decay_factor: f64,
    pub linked_memories: Vec<String>,
    pub linked_tasks: Vec<String>,
    pub metadata: HashMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WorkingMemoryType {
    Task,
    Goal,
    Hypothesis,
    Simulation,
    Context,
    Reasoning,
    Prediction,
    Observation,
    Memory,
    PendingDecision,
}

impl WorkingMemoryEntry {
    pub fn new(content: String, entry_type: WorkingMemoryType, importance: f64) -> Self {
        let now = chrono::Utc::now();
        Self {
            id: WorkingMemoryId::new(),
            content,
            entry_type,
            importance,
            attention_weight: importance,
            access_count: 0,
            last_accessed: now,
            created_at: now,
            decay_factor: 0.95,
            linked_memories: Vec::new(),
            linked_tasks: Vec::new(),
            metadata: HashMap::new(),
        }
    }

    pub fn update_attention_weight(&mut self, focus: &AttentionFocus) {
        let relevance = self.calculate_relevance(focus);
        self.attention_weight = self.importance * (0.5 + 0.5 * relevance);
    }

    fn calculate_relevance(&self, focus: &AttentionFocus) -> f64 {
        let mut score = 0.0;
        let content_lower = self.content.to_lowercase();
        let focus_lower = focus.content.to_lowercase();

        if content_lower.contains(&focus_lower) || focus_lower.contains(&content_lower) {
            score += 0.4;
        }

        match (&self.entry_type, &focus.focus_type) {
            (WorkingMemoryType::Task, FocusType::Task) => score += 0.2,
            (WorkingMemoryType::Goal, FocusType::Planning) => score += 0.2,
            (WorkingMemoryType::Hypothesis, FocusType::Analysis) => score += 0.2,
            (WorkingMemoryType::Simulation, FocusType::Simulation) => score += 0.2,
            (WorkingMemoryType::Prediction, FocusType::Prediction) => score += 0.2,
            (WorkingMemoryType::Observation, FocusType::Observation) => score += 0.2,
            (WorkingMemoryType::Reasoning, FocusType::Analysis) => score += 0.2,
            _ => {}
        }

        let priority_val = focus.priority as u8 as f64;
        score += (self.importance * priority_val * 0.2).min(0.3);

        score.min(1.0)
    }

    pub fn decay(&mut self, elapsed_ms: u64) {
        let decay_rate = self.decay_factor.powf(elapsed_ms as f64 / 60000.0);
        self.importance *= decay_rate;
        self.attention_weight *= decay_rate;
    }

    pub fn access(&mut self) {
        self.access_count += 1;
        self.last_accessed = chrono::Utc::now();
        self.importance = (self.importance * 1.1).min(1.0);
    }
}

pub struct WorkingMemory {
    pub entries: HashMap<WorkingMemoryId, WorkingMemoryEntry>,
    pub entry_order: VecDeque<WorkingMemoryId>,
    pub capacity: usize,
    pub current_load: f64,
    pub recent_activations: VecDeque<(WorkingMemoryId, chrono::DateTime<chrono::Utc>)>,
}

impl WorkingMemory {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
            entry_order: VecDeque::new(),
            capacity: 64,
            current_load: 0.0,
            recent_activations: VecDeque::with_capacity(100),
        }
    }

    pub fn add(&mut self, entry: WorkingMemoryEntry) -> WorkingMemoryId {
        let id = entry.id;
        while self.entries.len() >= self.capacity {
            self.evict_lowest_priority();
        }
        self.entries.insert(id, entry);
        self.entry_order.push_front(id);
        self.update_load();
        id
    }

    pub fn get(&mut self, id: &WorkingMemoryId) -> Option<&mut WorkingMemoryEntry> {
        if let Some(entry) = self.entries.get_mut(id) {
            entry.access();
            if let Some(pos) = self.entry_order.iter().position(|i| *i == *id) {
                self.entry_order.remove(pos);
                self.entry_order.push_front(*id);
            }
            self.recent_activations.push_front((*id, chrono::Utc::now()));
            if self.recent_activations.len() > 100 {
                self.recent_activations.pop_back();
            }
        }
        self.entries.get_mut(id)
    }

    pub fn get_by_type(&self, entry_type: WorkingMemoryType) -> Vec<&WorkingMemoryEntry> {
        self.entries
            .values()
            .filter(|e| e.entry_type == entry_type)
            .collect()
    }

    pub fn get_sorted_by_attention(&self) -> Vec<&WorkingMemoryEntry> {
        let mut entries: Vec<_> = self.entries.values().collect();
        entries.sort_by(|a, b| {
            b.attention_weight
                .partial_cmp(&a.attention_weight)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        entries
    }

    pub fn update_attention_weights(&mut self, focus: &Option<AttentionFocus>) {
        if let Some(f) = focus {
            for entry in self.entries.values_mut() {
                entry.update_attention_weight(f);
            }
        }
    }

    fn evict_lowest_priority(&mut self) {
        if let Some(lowest) = self
            .entries
            .iter()
            .min_by(|a, b| {
                a.1.attention_weight
                    .partial_cmp(&b.1.attention_weight)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|(id, _)| *id)
        {
            self.entries.remove(&lowest);
            if let Some(pos) = self.entry_order.iter().position(|i| *i == lowest) {
                self.entry_order.remove(pos);
            }
        }
    }

    pub fn decay_all(&mut self, elapsed_ms: u64) {
        for entry in self.entries.values_mut() {
            entry.decay(elapsed_ms);
        }
        self.entries.retain(|_, e| e.importance > 0.05);
        self.update_load();
    }

    fn update_load(&mut self) {
        let total_importance: f64 = self.entries.values().map(|e| e.attention_weight).sum();
        self.current_load = (total_importance / self.capacity as f64).min(1.0);
    }

    pub fn ingest_event(&mut self, event: &BrainEvent) {
        match event {
            BrainEvent::UserMessage { content, at: _ } => {
                let mut entry = WorkingMemoryEntry::new(
                    format!("User request: {}", content),
                    WorkingMemoryType::Observation,
                    0.8,
                );
                entry.metadata.insert("source".to_string(), "user".to_string());
                self.add(entry);
            }
            BrainEvent::ToolCompleted { result, at: _ } => {
                let success_str = if result.ok { "success" } else { "failure" };
                let mut entry = WorkingMemoryEntry::new(
                    format!("Tool result: {:?} - {}", result.provider, success_str),
                    WorkingMemoryType::Observation,
                    0.7,
                );
                entry.metadata.insert("success".to_string(), result.ok.to_string());
                if let Some(err) = &result.error {
                    entry.metadata.insert("error".to_string(), err.clone());
                }
                self.add(entry);
            }
            BrainEvent::Error { source, message, at: _ } => {
                let mut entry = WorkingMemoryEntry::new(
                    format!("Error from {}: {}", source, message),
                    WorkingMemoryType::Observation,
                    0.9,
                );
                entry.metadata.insert("severity".to_string(), "high".to_string());
                self.add(entry);
            }
            BrainEvent::FileChanged { path, change: _, project_root: _, at: _ } => {
                let mut entry = WorkingMemoryEntry::new(
                    format!("File changed: {}", path),
                    WorkingMemoryType::Observation,
                    0.5,
                );
                self.add(entry);
            }
            BrainEvent::PerceptionCreated { observation_id: _, source, summary, at: _ } => {
                let mut entry = WorkingMemoryEntry::new(
                    summary.clone(),
                    WorkingMemoryType::Observation,
                    0.6,
                );
                entry.metadata.insert("source".to_string(), source.clone());
                self.add(entry);
            }
            BrainEvent::PlanCreated { plan_id, intent, step_count: _, at: _ } => {
                let mut entry = WorkingMemoryEntry::new(
                    format!("Plan: {}", intent),
                    WorkingMemoryType::Task,
                    0.8,
                );
                entry.metadata.insert("plan_id".to_string(), plan_id.to_string());
                self.add(entry);
            }
            BrainEvent::GoalStackUpdated { goal_id, title, status: _, at: _ } => {
                let mut entry = WorkingMemoryEntry::new(
                    title.clone(),
                    WorkingMemoryType::Goal,
                    0.7,
                );
                entry.metadata.insert("goal_id".to_string(), goal_id.to_string());
                self.add(entry);
            }
            BrainEvent::SystemObserved { cpu, memory, active_process: _, at: _ } => {
                if *cpu > 80.0 || *memory > 85.0 {
                    let mut entry = WorkingMemoryEntry::new(
                        format!("System overload: CPU {}%, Memory {}%", cpu, memory),
                        WorkingMemoryType::Observation,
                        0.85,
                    );
                    entry.metadata.insert("type".to_string(), "resource_pressure".to_string());
                    self.add(entry);
                }
            }
            _ => {}
        }
    }

    pub fn snapshot(&self) -> WorkingMemorySnapshot {
        let entries: Vec<_> = self
            .get_sorted_by_attention()
            .into_iter()
            .map(|e| WorkingMemoryEntrySummary {
                id: e.id.0,
                content: e.content.clone(),
                entry_type: e.entry_type,
                attention_weight: e.attention_weight,
                importance: e.importance,
                created_at: e.created_at,
            })
            .collect();

        WorkingMemorySnapshot {
            entries,
            total_entries: self.entries.len(),
            capacity: self.capacity,
            current_load: self.current_load,
        }
    }
}

impl Default for WorkingMemory {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone)]
pub struct WorkingMemorySnapshot {
    pub entries: Vec<WorkingMemoryEntrySummary>,
    pub total_entries: usize,
    pub capacity: usize,
    pub current_load: f64,
}

#[derive(Debug, Clone)]
pub struct WorkingMemoryEntrySummary {
    pub id: Uuid,
    pub content: String,
    pub entry_type: WorkingMemoryType,
    pub attention_weight: f64,
    pub importance: f64,
    pub created_at: chrono::DateTime<chrono::Utc>,
}