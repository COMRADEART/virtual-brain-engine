//! # Attention System

use crate::{
    AttentionFocus, CognitivePriority, FocusSource, FocusType, WorkingMemory,
    WorkingMemoryType,
};
use hashbrown::HashMap;
use rand::prelude::*;
use shared_types::BrainEvent;
use std::collections::{HashMap as StdHashMap, VecDeque};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct AttentionNode {
    pub id: Uuid,
    pub content: String,
    pub focus_type: FocusType,
    pub base_priority: CognitivePriority,
    pub urgency_score: f64,
    pub relevance_score: f64,
    pub novelty_score: f64,
    pub impact_score: f64,
    pub confidence: f64,
    pub source_agent: Option<String>,
    pub context_hints: Vec<String>,
}

impl AttentionNode {
    pub fn attention_score(&self) -> f64 {
        let priority_val = match self.base_priority {
            CognitivePriority::Critical => 0.40,
            CognitivePriority::Urgent => 0.25,
            CognitivePriority::High => 0.18,
            CognitivePriority::Normal => 0.10,
            CognitivePriority::Low => 0.05,
            CognitivePriority::Idle => 0.0,
        };

        let urgency_weight = 0.25;
        let relevance_weight = 0.20;
        let novelty_weight = 0.10;
        let impact_weight = 0.05;

        priority_val * self.urgency_score
            + urgency_weight * self.urgency_score
            + relevance_weight * self.relevance_score
            + novelty_weight * self.novelty_score
            + impact_weight * self.impact_score
    }
}

pub struct GlobalWorkspace {
    pub candidates: HashMap<Uuid, AttentionNode>,
    pub active_attention: Option<AttentionFocus>,
    pub attention_history: Vec<AttentionHistoryEntry>,
}

impl GlobalWorkspace {
    pub fn new() -> Self {
        Self {
            candidates: HashMap::new(),
            active_attention: None,
            attention_history: Vec::with_capacity(200),
        }
    }

    pub fn propose_candidates(
        &mut self,
        event: &BrainEvent,
        working_memory: &WorkingMemory,
    ) -> Vec<AttentionNode> {
        let mut nodes = Vec::new();

        match event {
            BrainEvent::Error { source, message, at: _ } => {
                nodes.push(AttentionNode {
                    id: Uuid::new_v4(),
                    content: format!("Error: {} - {}", source, message),
                    focus_type: FocusType::Analysis,
                    base_priority: if message.contains("critical") || message.contains("fatal") {
                        CognitivePriority::Critical
                    } else {
                        CognitivePriority::Urgent
                    },
                    urgency_score: 0.95,
                    relevance_score: 0.9,
                    novelty_score: 0.8,
                    impact_score: 0.9,
                    confidence: 0.95,
                    source_agent: Some(source.clone()),
                    context_hints: vec!["error".to_string(), "failure".to_string()],
                });
            }

            BrainEvent::ToolRequested { request, at: _ } => {
                nodes.push(AttentionNode {
                    id: Uuid::new_v4(),
                    content: format!("Tool request: {}", request.tool),
                    focus_type: FocusType::Task,
                    base_priority: CognitivePriority::High,
                    urgency_score: 0.7,
                    relevance_score: 0.8,
                    novelty_score: 0.3,
                    impact_score: 0.6,
                    confidence: 0.8,
                    source_agent: Some(format!("{:?}", request.provider)),
                    context_hints: vec![request.tool.clone()],
                });
            }

            BrainEvent::CommandRequested { command, cwd: _, at: _ } => {
                let is_dangerous = command.contains("rm -rf")
                    || command.contains("del /f")
                    || command.contains("format")
                    || command.contains("shutdown");
                nodes.push(AttentionNode {
                    id: Uuid::new_v4(),
                    content: format!("Command: {}", command),
                    focus_type: FocusType::Task,
                    base_priority: if is_dangerous {
                        CognitivePriority::Urgent
                    } else {
                        CognitivePriority::Normal
                    },
                    urgency_score: 0.6,
                    relevance_score: 0.7,
                    novelty_score: 0.5,
                    impact_score: if is_dangerous { 0.9 } else { 0.4 },
                    confidence: 0.85,
                    source_agent: None,
                    context_hints: vec!["command".to_string()],
                });
            }

            BrainEvent::PerceptionCreated { observation_id: _, source, summary, at: _ } => {
                let priority = match source.as_str() {
                    "failure" => CognitivePriority::Urgent,
                    "request" => CognitivePriority::High,
                    "resource_pressure" => CognitivePriority::High,
                    "safety_signal" => CognitivePriority::Critical,
                    _ => CognitivePriority::Normal,
                };
                nodes.push(AttentionNode {
                    id: Uuid::new_v4(),
                    content: summary.clone(),
                    focus_type: FocusType::Observation,
                    base_priority: priority,
                    urgency_score: 0.7,
                    relevance_score: 0.8,
                    novelty_score: 0.6,
                    impact_score: 0.5,
                    confidence: 0.75,
                    source_agent: None,
                    context_hints: vec![source.clone()],
                });
            }

            BrainEvent::UnderstandingCreated { understanding_id: _, intent, confidence, at: _ } => {
                nodes.push(AttentionNode {
                    id: Uuid::new_v4(),
                    content: format!("Understanding: {}", intent),
                    focus_type: FocusType::Analysis,
                    base_priority: CognitivePriority::Normal,
                    urgency_score: 0.5,
                    relevance_score: *confidence as f64,
                    novelty_score: 0.4,
                    impact_score: 0.5,
                    confidence: *confidence as f64,
                    source_agent: None,
                    context_hints: vec![],
                });
            }

            BrainEvent::PlanCreated { plan_id: _, intent, step_count: _, at: _ } => {
                nodes.push(AttentionNode {
                    id: Uuid::new_v4(),
                    content: format!("Plan: {}", intent),
                    focus_type: FocusType::Planning,
                    base_priority: if intent.contains("critical") || intent.contains("urgent") {
                        CognitivePriority::High
                    } else {
                        CognitivePriority::Normal
                    },
                    urgency_score: 0.6,
                    relevance_score: 0.7,
                    novelty_score: 0.3,
                    impact_score: 0.7,
                    confidence: 0.8,
                    source_agent: None,
                    context_hints: vec!["planning".to_string()],
                });
            }

            BrainEvent::UserMessage { content, at: _ } => {
                nodes.push(AttentionNode {
                    id: Uuid::new_v4(),
                    content: format!("User: {}", content),
                    focus_type: FocusType::Task,
                    base_priority: CognitivePriority::High,
                    urgency_score: 0.8,
                    relevance_score: 0.9,
                    novelty_score: 0.7,
                    impact_score: 0.8,
                    confidence: 0.95,
                    source_agent: Some("user".to_string()),
                    context_hints: vec!["user_request".to_string()],
                });
            }

            BrainEvent::GoalStackUpdated { goal_id: _, title, status, at: _ } => {
                let priority = match status {
                    shared_types::GoalStatus::Paused | shared_types::GoalStatus::Failed => CognitivePriority::Urgent,
                    shared_types::GoalStatus::Active => CognitivePriority::High,
                    _ => CognitivePriority::Normal,
                };
                let status_str = match status {
                    shared_types::GoalStatus::Proposed => "proposed",
                    shared_types::GoalStatus::Active => "active",
                    shared_types::GoalStatus::WaitingApproval => "waiting",
                    shared_types::GoalStatus::Completed => "completed",
                    shared_types::GoalStatus::Failed => "failed",
                    shared_types::GoalStatus::Paused => "paused",
                };
                nodes.push(AttentionNode {
                    id: Uuid::new_v4(),
                    content: format!("Goal: {}", title),
                    focus_type: FocusType::Planning,
                    base_priority: priority,
                    urgency_score: 0.6,
                    relevance_score: 0.7,
                    novelty_score: 0.4,
                    impact_score: 0.7,
                    confidence: 0.85,
                    source_agent: None,
                    context_hints: vec!["goal".to_string(), status_str.to_string()],
                });
            }

            BrainEvent::SystemObserved { cpu, memory, active_process: _, at: _ } => {
                if *cpu > 80.0 || *memory > 85.0 {
                    nodes.push(AttentionNode {
                        id: Uuid::new_v4(),
                        content: format!("System overload: CPU {}%, Memory {}%", cpu, memory),
                        focus_type: FocusType::Observation,
                        base_priority: CognitivePriority::Urgent,
                        urgency_score: 0.9,
                        relevance_score: 0.9,
                        novelty_score: 0.5,
                        impact_score: 0.9,
                        confidence: 0.95,
                        source_agent: None,
                        context_hints: vec!["system".to_string(), "resource_pressure".to_string()],
                    });
                }
            }

            _ => {
                let relevant: Vec<_> = working_memory
                    .entries
                    .values()
                    .filter(|e| e.attention_weight > 0.7)
                    .map(|e| {
                        let focus_type = match e.entry_type {
                            WorkingMemoryType::Task => FocusType::Task,
                            WorkingMemoryType::Goal => FocusType::Planning,
                            WorkingMemoryType::Hypothesis => FocusType::Analysis,
                            WorkingMemoryType::Simulation => FocusType::Simulation,
                            WorkingMemoryType::Prediction => FocusType::Prediction,
                            WorkingMemoryType::Observation => FocusType::Observation,
                            _ => FocusType::Analysis,
                        };
                        AttentionNode {
                            id: Uuid::new_v4(),
                            content: e.content.clone(),
                            focus_type,
                            base_priority: CognitivePriority::from_score(e.importance),
                            urgency_score: e.importance * 0.5,
                            relevance_score: e.attention_weight,
                            novelty_score: 0.3,
                            impact_score: e.importance,
                            confidence: e.attention_weight,
                            source_agent: None,
                            context_hints: vec![],
                        }
                    })
                    .collect();
                nodes.extend(relevant);
            }
        }

        for node in &nodes {
            self.candidates.insert(node.id, node.clone());
        }

        nodes
    }

    pub fn compete(&mut self, mut candidates: Vec<AttentionNode>) -> Option<AttentionFocus> {
        if candidates.is_empty() {
            return self.active_attention.clone();
        }

        let mut rng = rand::thread_rng();

        for candidate in &mut candidates {
            let noise: f64 = rng.gen_range(-0.05..0.05);
            let _score = (candidate.attention_score() + noise).clamp(0.0, 1.0);

            if let Some(current) = &self.active_attention {
                if candidate.content != current.content {
                    candidate.novelty_score = (candidate.novelty_score + 0.2).min(1.0);
                }
            }
        }

        candidates.sort_by(|a, b| {
            b.attention_score()
                .partial_cmp(&a.attention_score())
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        let winner = candidates.first()?;

        let should_switch = if let Some(current) = &self.active_attention {
            let score_diff = winner.attention_score() - self.get_active_score(current);
            score_diff > 0.15 || (winner.base_priority as u8) > (current.priority as u8)
        } else {
            true
        };

        if should_switch {
            let focus = self.create_focus(winner);
            self.record_history(&focus);
            self.active_attention = Some(focus.clone());
            Some(focus)
        } else {
            self.active_attention.clone()
        }
    }

    fn get_active_score(&self, focus: &AttentionFocus) -> f64 {
        focus.intensity * (focus.priority as u8 as f64) * 0.3 + focus.confidence * 0.5
    }

    fn create_focus(&self, node: &AttentionNode) -> AttentionFocus {
        let now = chrono::Utc::now();
        AttentionFocus {
            id: Uuid::new_v4(),
            content: node.content.clone(),
            focus_type: node.focus_type,
            priority: node.base_priority,
            intensity: node.attention_score(),
            confidence: node.confidence,
            source: FocusSource::from_node(&node.source_agent),
            activated_memories: Vec::new(),
            created_at: now,
            last_updated: now,
            expected_duration_ms: Self::estimate_duration(&node.focus_type),
        }
    }

    fn estimate_duration(focus_type: &FocusType) -> Option<u64> {
        match focus_type {
            FocusType::Task => Some(30000),
            FocusType::Analysis => Some(60000),
            FocusType::Planning => Some(90000),
            FocusType::Simulation => Some(120000),
            FocusType::Observation => Some(10000),
            _ => Some(30000),
        }
    }

    fn record_history(&mut self, focus: &AttentionFocus) {
        let entry = AttentionHistoryEntry {
            timestamp: chrono::Utc::now(),
            content: focus.content.clone(),
            focus_type: focus.focus_type,
            priority: focus.priority,
            intensity: focus.intensity,
            duration_ms: focus.expected_duration_ms.unwrap_or(30000),
        };
        self.attention_history.push(entry);
        if self.attention_history.len() > 200 {
            self.attention_history.remove(0);
        }
    }

    pub fn get_history(&self, limit: usize) -> Vec<AttentionHistoryEntry> {
        self.attention_history
            .iter()
            .rev()
            .take(limit)
            .cloned()
            .collect()
    }
}

impl Default for GlobalWorkspace {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone)]
pub struct AttentionHistoryEntry {
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub content: String,
    pub focus_type: FocusType,
    pub priority: CognitivePriority,
    pub intensity: f64,
    pub duration_ms: u64,
}

impl FocusSource {
    fn from_node(agent: &Option<String>) -> FocusSource {
        match agent.as_deref() {
            Some("user") => FocusSource::UserRequest,
            Some(_) => FocusSource::GoalPursuit,
            None => FocusSource::ContextShift,
        }
    }
}