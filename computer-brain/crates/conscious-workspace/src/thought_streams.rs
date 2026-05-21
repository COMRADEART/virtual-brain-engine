//! # Thought Stream Engine

use crate::{CognitivePriority, FocusType};
use hashbrown::HashMap;
use std::collections::{VecDeque};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ThoughtStreamId(pub Uuid);

impl ThoughtStreamId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StreamType {
    ActivePlanning,
    MemoryRecall,
    Simulation,
    WorkflowMonitoring,
    Prediction,
    Reflection,
    Learning,
    Observation,
}

impl StreamType {
    pub fn base_priority(&self) -> CognitivePriority {
        match self {
            StreamType::ActivePlanning => CognitivePriority::High,
            StreamType::Simulation => CognitivePriority::Normal,
            StreamType::Prediction => CognitivePriority::Normal,
            StreamType::MemoryRecall => CognitivePriority::Low,
            StreamType::WorkflowMonitoring => CognitivePriority::Low,
            StreamType::Reflection => CognitivePriority::Idle,
            StreamType::Learning => CognitivePriority::Idle,
            StreamType::Observation => CognitivePriority::Idle,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamStatus {
    Active,
    Paused,
    Merged,
    Split,
    Completed,
    Failed,
}

#[derive(Debug, Clone)]
pub struct ThoughtStep {
    pub id: Uuid,
    pub content: String,
    pub step_type: ThoughtStepType,
    pub confidence: f64,
    pub importance: f64,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub artifacts: Vec<ThoughtArtifact>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThoughtStepType {
    Observation,
    Analysis,
    Reasoning,
    Decision,
    Planning,
    Execution,
    Reflection,
    Validation,
}

#[derive(Debug, Clone)]
pub struct ThoughtArtifact {
    pub artifact_type: String,
    pub content: String,
    pub metadata: HashMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct ThoughtStream {
    pub id: ThoughtStreamId,
    pub stream_type: StreamType,
    pub name: String,
    pub status: StreamStatus,
    pub priority: CognitivePriority,
    pub intensity: f64,
    pub steps: VecDeque<ThoughtStep>,
    pub parent_streams: Vec<ThoughtStreamId>,
    pub child_streams: Vec<ThoughtStreamId>,
    pub linked_memories: Vec<String>,
    pub linked_goals: Vec<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub last_updated: chrono::DateTime<chrono::Utc>,
    pub expected_completion: Option<chrono::DateTime<chrono::Utc>>,
    pub result: Option<StreamResult>,
}

#[derive(Debug, Clone)]
pub struct StreamResult {
    pub conclusion: String,
    pub confidence: f64,
    pub related_memories: Vec<String>,
    pub next_actions: Vec<String>,
}

impl ThoughtStream {
    pub fn new(stream_type: StreamType, name: String) -> Self {
        let now = chrono::Utc::now();
        Self {
            id: ThoughtStreamId::new(),
            stream_type,
            name,
            status: StreamStatus::Active,
            priority: stream_type.base_priority(),
            intensity: 0.5,
            steps: VecDeque::new(),
            parent_streams: Vec::new(),
            child_streams: Vec::new(),
            linked_memories: Vec::new(),
            linked_goals: Vec::new(),
            created_at: now,
            last_updated: now,
            expected_completion: None,
            result: None,
        }
    }

    pub fn add_step(&mut self, step: ThoughtStep) {
        self.steps.push_back(step);
        self.last_updated = chrono::Utc::now();
    }

    pub fn current_step(&self) -> Option<&ThoughtStep> {
        self.steps.back()
    }

    pub fn calculate_intensity(&self) -> f64 {
        let priority_val = match self.priority {
            CognitivePriority::Critical => 1.0,
            CognitivePriority::Urgent => 0.9,
            CognitivePriority::High => 0.7,
            CognitivePriority::Normal => 0.5,
            CognitivePriority::Low => 0.3,
            CognitivePriority::Idle => 0.1,
        };

        let activity_factor = if self.steps.len() > 5 { 0.8 } else { 0.5 };

        priority_val * activity_factor
    }

    pub fn pause(&mut self) {
        self.status = StreamStatus::Paused;
        self.intensity *= 0.5;
    }

    pub fn resume(&mut self) {
        self.status = StreamStatus::Active;
        self.intensity = self.calculate_intensity();
    }

    pub fn split(&mut self) -> Vec<ThoughtStreamId> {
        self.status = StreamStatus::Split;
        let mut child_ids = Vec::new();

        for i in 0..2 {
            let mut child = ThoughtStream::new(
                self.stream_type,
                format!("{} (branch {})", self.name, i),
            );
            child.parent_streams.push(self.id);
            child_ids.push(child.id);
        }

        self.child_streams = child_ids.clone();
        child_ids
    }

    pub fn merge_with(&mut self, other: &mut ThoughtStream) {
        self.status = StreamStatus::Merged;
        other.status = StreamStatus::Merged;

        while let Some(step) = other.steps.pop_front() {
            self.steps.push_back(step);
        }

        self.child_streams.push(other.id);
        other.parent_streams.push(self.id);
    }
}

pub struct ThoughtStreamManager {
    pub active_streams: HashMap<ThoughtStreamId, ThoughtStream>,
    pub stream_history: Vec<ThoughtStreamId>,
    pub max_concurrent_streams: usize,
    pub total_thought_time_ms: u64,
}

impl ThoughtStreamManager {
    pub fn new() -> Self {
        Self {
            active_streams: HashMap::new(),
            stream_history: Vec::with_capacity(100),
            max_concurrent_streams: 8,
            total_thought_time_ms: 0,
        }
    }

    pub fn create_stream(&mut self, stream_type: StreamType, name: String) -> ThoughtStreamId {
        while self.active_streams.len() >= self.max_concurrent_streams {
            self.evict_lowest_priority();
        }

        let stream = ThoughtStream::new(stream_type, name);
        let id = stream.id;
        self.active_streams.insert(id, stream);
        self.stream_history.push(id);

        id
    }

    pub fn get_stream(&self, id: &ThoughtStreamId) -> Option<&ThoughtStream> {
        self.active_streams.get(id)
    }

    pub fn get_stream_mut(&mut self, id: &ThoughtStreamId) -> Option<&mut ThoughtStream> {
        self.active_streams.get_mut(id)
    }

    pub fn pause_stream(&mut self, id: &ThoughtStreamId) {
        if let Some(stream) = self.active_streams.get_mut(id) {
            stream.pause();
        }
    }

    pub fn resume_stream(&mut self, id: &ThoughtStreamId) {
        if let Some(stream) = self.active_streams.get_mut(id) {
            stream.resume();
        }
    }

    pub fn add_step(
        &mut self,
        stream_id: &ThoughtStreamId,
        content: String,
        step_type: ThoughtStepType,
    ) -> Option<Uuid> {
        if let Some(stream) = self.active_streams.get_mut(stream_id) {
            let step = ThoughtStep {
                id: Uuid::new_v4(),
                content,
                step_type,
                confidence: 0.8,
                importance: 0.7,
                timestamp: chrono::Utc::now(),
                artifacts: Vec::new(),
            };
            stream.add_step(step.clone());
            stream.intensity = stream.calculate_intensity();
            Some(step.id)
        } else {
            None
        }
    }

    pub fn complete_stream(
        &mut self,
        id: &ThoughtStreamId,
        conclusion: String,
        confidence: f64,
    ) -> Option<StreamResult> {
        if let Some(stream) = self.active_streams.get_mut(id) {
            stream.status = StreamStatus::Completed;
            stream.result = Some(StreamResult {
                conclusion: conclusion.clone(),
                confidence,
                related_memories: stream.linked_memories.clone(),
                next_actions: Vec::new(),
            });

            let result = stream.result.clone();
            self.total_thought_time_ms += (chrono::Utc::now() - stream.created_at)
                .num_milliseconds()
                .unsigned_abs();

            result
        } else {
            None
        }
    }

    pub fn split_stream(&mut self, id: &ThoughtStreamId) -> Option<Vec<ThoughtStreamId>> {
        if let Some(stream) = self.active_streams.get_mut(id) {
            let child_ids = stream.split();
            Some(child_ids)
        } else {
            None
        }
    }

    pub fn merge_streams(&mut self, id1: &ThoughtStreamId, id2: &ThoughtStreamId) -> bool {
        if id1 == id2 {
            return false;
        }

        // Get id2's data first
        let s2_data = if let Some(s2) = self.active_streams.get(id2) {
            Some(ThoughtStream {
                id: s2.id,
                stream_type: s2.stream_type,
                name: s2.name.clone(),
                status: s2.status,
                priority: s2.priority,
                intensity: s2.intensity,
                steps: s2.steps.clone(),
                parent_streams: s2.parent_streams.clone(),
                child_streams: s2.child_streams.clone(),
                linked_memories: s2.linked_memories.clone(),
                linked_goals: s2.linked_goals.clone(),
                created_at: s2.created_at,
                last_updated: s2.last_updated,
                expected_completion: s2.expected_completion,
                result: s2.result.clone(),
            })
        } else {
            None
        };

        if let Some(mut s2_stream) = s2_data {
            if let Some(s1) = self.active_streams.get_mut(id1) {
                s1.merge_with(&mut s2_stream);
                self.active_streams.remove(id2);
                return true;
            }
        }
        false
    }

    pub fn update_priorities(&mut self, focused_content: &str) {
        for stream in self.active_streams.values_mut() {
            let relevance = if stream.name.to_lowercase().contains(&focused_content.to_lowercase()) {
                0.8
            } else {
                0.3
            };

            let base_priority_val = stream.stream_type.base_priority() as u8 as f64;
            let new_priority_val = (base_priority_val * (1.0 - relevance) + 3.0 * relevance).round();

            stream.priority = match new_priority_val as u8 {
                5 => CognitivePriority::Critical,
                4 => CognitivePriority::Urgent,
                3 => CognitivePriority::High,
                2 => CognitivePriority::Normal,
                1 => CognitivePriority::Low,
                _ => CognitivePriority::Idle,
            };
            stream.intensity = stream.calculate_intensity();
        }
    }

    pub fn get_intensity(&self, id: &ThoughtStreamId) -> f64 {
        self.active_streams.get(id).map(|s| s.intensity).unwrap_or(0.0)
    }

    pub fn get_active_streams_sorted(&self) -> Vec<&ThoughtStream> {
        let mut streams: Vec<_> = self
            .active_streams
            .values()
            .filter(|s| s.status == StreamStatus::Active)
            .collect();
        streams.sort_by(|a, b| {
            b.priority
                .cmp(&a.priority)
                .then_with(|| {
                    b.intensity
                        .partial_cmp(&a.intensity)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
        });
        streams
    }

    fn evict_lowest_priority(&mut self) {
        if let Some(lowest) = self
            .active_streams
            .iter()
            .filter(|(_, s)| s.status == StreamStatus::Active)
            .min_by(|a, b| {
                a.1.priority
                    .cmp(&b.1.priority)
                    .then_with(|| {
                        a.1.intensity
                            .partial_cmp(&b.1.intensity)
                            .unwrap_or(std::cmp::Ordering::Equal)
                    })
            })
            .map(|(id, _)| *id)
        {
            self.active_streams.remove(&lowest);
        }
    }

    pub fn decay_all(&mut self, elapsed_ms: u64) {
        let decay_factor = 0.999f64.powf(elapsed_ms as f64 / 1000.0);
        for stream in self.active_streams.values_mut() {
            stream.intensity *= decay_factor;
            stream.intensity = stream.intensity.max(0.1);
        }
    }

    pub fn get_streams_for_memory(&self, memory_id: &str) -> Vec<&ThoughtStream> {
        self.active_streams
            .values()
            .filter(|s| s.linked_memories.contains(&memory_id.to_string()))
            .collect()
    }

    pub fn get_summary(&self) -> StreamSummary {
        let active: Vec<_> = self
            .active_streams
            .values()
            .filter(|s| s.status == StreamStatus::Active)
            .map(|s| StreamSummaryItem {
                id: s.id,
                name: s.name.clone(),
                stream_type: s.stream_type,
                priority: s.priority,
                intensity: s.intensity,
                step_count: s.steps.len(),
            })
            .collect();

        StreamSummary {
            active_streams: active,
            total_streams: self.active_streams.len(),
            max_streams: self.max_concurrent_streams,
            total_thought_time_ms: self.total_thought_time_ms,
        }
    }
}

impl Default for ThoughtStreamManager {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone)]
pub struct StreamSummary {
    pub active_streams: Vec<StreamSummaryItem>,
    pub total_streams: usize,
    pub max_streams: usize,
    pub total_thought_time_ms: u64,
}

#[derive(Debug, Clone)]
pub struct StreamSummaryItem {
    pub id: ThoughtStreamId,
    pub name: String,
    pub stream_type: StreamType,
    pub priority: CognitivePriority,
    pub intensity: f64,
    pub step_count: usize,
}