//! # Conscious Workspace Engine
//!
//! Synthetic conscious workspace implementing:
//! - **Working Memory**: Temporary, highly active storage for current cognition
//! - **Attention System**: Dynamic allocation of cognitive resources
//! - **Global Workspace**: Competition for consciousness
//! - **Thought Streams**: Parallel cognitive processing streams
//! - **Context Activation**: Automatic memory activation based on context
//! - **Cognitive Prioritization**: Urgency/risk/importance-based reasoning
//! - **Interruption Management**: Intelligent pause/resume of cognition
//! - **Cognitive Bandwidth**: Load management and throttling
//! - **Meta-Attention**: Self-regulation of attention
//! - **Consciousness Timeline**: Attention history and reasoning evolution

use hashbrown::HashMap;
use std::collections::VecDeque;
use uuid::Uuid;

pub mod attention;
pub mod bandwidth;
pub mod context_activation;
pub mod meta_attention;
pub mod thought_streams;
pub mod working_memory;

pub use attention::{AttentionNode, GlobalWorkspace};
pub use bandwidth::{BandwidthController, CognitiveLoad};
pub use context_activation::ContextActivator;
pub use meta_attention::MetaAttention;
pub use thought_streams::{ThoughtStream, ThoughtStreamId, ThoughtStreamManager};
pub use working_memory::{WorkingMemory, WorkingMemoryEntry, WorkingMemoryId, WorkingMemoryType};

// ============================================================================
// CORE TYPES
// ============================================================================

/// Priority level for cognitive processing
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum CognitivePriority {
    Critical = 5,
    Urgent = 4,
    High = 3,
    Normal = 2,
    Low = 1,
    Idle = 0,
}

impl CognitivePriority {
    pub fn from_score(score: f64) -> Self {
        if score >= 0.9 {
            CognitivePriority::Critical
        } else if score >= 0.7 {
            CognitivePriority::Urgent
        } else if score >= 0.5 {
            CognitivePriority::High
        } else if score >= 0.3 {
            CognitivePriority::Normal
        } else if score >= 0.1 {
            CognitivePriority::Low
        } else {
            CognitivePriority::Idle
        }
    }
}

/// What the brain is currently focusing on
#[derive(Debug, Clone)]
pub struct AttentionFocus {
    pub id: Uuid,
    pub content: String,
    pub focus_type: FocusType,
    pub priority: CognitivePriority,
    pub intensity: f64,
    pub confidence: f64,
    pub source: FocusSource,
    pub activated_memories: Vec<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub last_updated: chrono::DateTime<chrono::Utc>,
    pub expected_duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocusType {
    Task,
    Memory,
    Simulation,
    Prediction,
    Planning,
    Analysis,
    Observation,
    Reflection,
    Interrupted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocusSource {
    UserRequest,
    SystemAlert,
    MemoryRecall,
    ContextShift,
    GoalPursuit,
    Interrupted,
    Heartbeat,
}

/// Self-aware state model
#[derive(Debug, Clone)]
pub struct SelfAwareState {
    pub current_focus: Option<AttentionFocus>,
    pub active_streams: Vec<ThoughtStreamId>,
    pub working_memory_load: f64,
    pub attention_bandwidth_used: f64,
    pub cognitive_load: CognitiveLoad,
    pub current_goals: Vec<String>,
    pub active_reasoning: Vec<ReasoningChain>,
    pub uncertainty_level: f64,
    pub meta_attention_feedback: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ReasoningChain {
    pub id: Uuid,
    pub steps: Vec<ReasoningStep>,
    pub conclusion_confidence: f64,
    pub is_complete: bool,
}

#[derive(Debug, Clone)]
pub struct ReasoningStep {
    pub description: String,
    pub evidence: Vec<String>,
    pub confidence: f64,
    pub timestamp: chrono::DateTime<chrono::Utc>,
}

/// Attention heatmap for visualization
#[derive(Debug, Clone)]
pub struct AttentionHeatmap {
    pub project_attention: HashMap<String, f64>,
    pub task_attention: HashMap<String, f64>,
    pub memory_attention: HashMap<String, f64>,
    pub stream_intensity: HashMap<ThoughtStreamId, f64>,
    pub total_attention: f64,
    pub timestamp: chrono::DateTime<chrono::Utc>,
}

/// Consciousness timeline entry
#[derive(Debug, Clone)]
pub struct ConsciousnessTimelineEntry {
    pub id: Uuid,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub focus: String,
    pub focus_type: FocusType,
    pub priority: CognitivePriority,
    pub reasoning_chains: Vec<Uuid>,
    pub interrupted: bool,
    pub interruption_restore_point: Option<Uuid>,
}

// ============================================================================
// CONSCIOUS WORKSPACE ENGINE
// ============================================================================

/// Main Conscious Workspace Engine
pub struct ConsciousWorkspace {
    pub working_memory: WorkingMemory,
    pub global_workspace: GlobalWorkspace,
    pub stream_manager: ThoughtStreamManager,
    pub context_activator: ContextActivator,
    pub bandwidth_controller: BandwidthController,
    pub meta_attention: MetaAttention,
    pub timeline: VecDeque<ConsciousnessTimelineEntry>,
    pub self_aware_state: parking_lot::RwLock<SelfAwareState>,
    pub attention_heatmap: parking_lot::RwLock<AttentionHeatmap>,
}

impl ConsciousWorkspace {
    pub fn new() -> Self {
        Self {
            working_memory: WorkingMemory::new(),
            global_workspace: GlobalWorkspace::new(),
            stream_manager: ThoughtStreamManager::new(),
            context_activator: ContextActivator::new(),
            bandwidth_controller: BandwidthController::new(),
            meta_attention: MetaAttention::new(),
            timeline: VecDeque::with_capacity(1000),
            self_aware_state: parking_lot::RwLock::new(SelfAwareState {
                current_focus: None,
                active_streams: Vec::new(),
                working_memory_load: 0.0,
                attention_bandwidth_used: 0.0,
                cognitive_load: CognitiveLoad::Idle,
                current_goals: Vec::new(),
                active_reasoning: Vec::new(),
                uncertainty_level: 0.5,
                meta_attention_feedback: None,
            }),
            attention_heatmap: parking_lot::RwLock::new(AttentionHeatmap {
                project_attention: HashMap::new(),
                task_attention: HashMap::new(),
                memory_attention: HashMap::new(),
                stream_intensity: HashMap::new(),
                total_attention: 0.0,
                timestamp: chrono::Utc::now(),
            }),
        }
    }

    /// Main entry point - process an event through the workspace
    pub fn process_event(&mut self, event: &shared_types::BrainEvent) -> Vec<WorkspaceBroadcast> {
        let mut broadcasts = Vec::new();

        // 1. Update working memory with new information
        self.working_memory.ingest_event(event);

        // 2. Run through global workspace competition
        let candidates = self.global_workspace.propose_candidates(event, &self.working_memory);

        // 3. Compete for attention
        if let Some(winner) = self.global_workspace.compete(candidates) {
            broadcasts.push(WorkspaceBroadcast::AttentionShift(winner.clone()));
            self.set_focus(winner);
        }

        // 4. Activate context if focus changed
        let current_focus = self.self_aware_state.read().current_focus.clone();
        if let Some(focus) = current_focus {
            let activated = self.context_activator.activate_context(&focus, &mut self.working_memory);
            broadcasts.push(WorkspaceBroadcast::ContextActivated(activated));
        }

        // 5. Update cognitive bandwidth
        let load = self.bandwidth_controller.calculate_load(
            &self.working_memory,
            &self.global_workspace,
            &self.self_aware_state.read().cognitive_load,
        );
        {
            let mut state = self.self_aware_state.write();
            state.cognitive_load = load.clone();
        }
        broadcasts.push(WorkspaceBroadcast::BandwidthUpdate(load));

        // 6. Meta-attention self-regulation
        let state = self.self_aware_state.read().clone();
        if let Some(feedback) = self.meta_attention.regulate(&state, &self.working_memory) {
            broadcasts.push(WorkspaceBroadcast::MetaAttentionFeedback(feedback.clone()));
            let mut s = self.self_aware_state.write();
            s.meta_attention_feedback = Some(feedback);
        }

        // 7. Update timeline
        self.record_to_timeline();

        // 8. Update heatmap
        self.update_heatmap();

        broadcasts
    }

    fn set_focus(&mut self, focus: AttentionFocus) {
        let mut state = self.self_aware_state.write();
        state.current_focus = Some(focus.clone());
        state.attention_bandwidth_used = (state.attention_bandwidth_used * 0.7)
            + (focus.intensity * 0.3);
    }

    fn record_to_timeline(&mut self) {
        let state = self.self_aware_state.read();
        if let Some(focus) = &state.current_focus {
            let entry = ConsciousnessTimelineEntry {
                id: Uuid::new_v4(),
                timestamp: chrono::Utc::now(),
                focus: focus.content.clone(),
                focus_type: focus.focus_type,
                priority: focus.priority,
                reasoning_chains: state.active_reasoning.iter().map(|r| r.id).collect(),
                interrupted: false,
                interruption_restore_point: None,
            };
            self.timeline.push_front(entry);
            if self.timeline.len() > 1000 {
                self.timeline.pop_back();
            }
        }
    }

    fn update_heatmap(&self) {
        let mut heatmap = self.attention_heatmap.write();
        let state = self.self_aware_state.read();

        heatmap.total_attention = state.attention_bandwidth_used;
        heatmap.timestamp = chrono::Utc::now();

        heatmap.stream_intensity.clear();
        for stream_id in &state.active_streams {
            heatmap.stream_intensity.insert(*stream_id, self.stream_manager.get_intensity(stream_id));
        }

        heatmap.project_attention.clear();
        if let Some(focus) = &state.current_focus {
            if let Some(colon_pos) = focus.content.find(':') {
                let key = focus.content[..colon_pos].to_string();
                *heatmap.project_attention.entry(key).or_insert(0.0) +=
                    focus.intensity * (focus.priority as u8 as f64) * 0.1;
            }
        }
    }

    /// Handle interruption
    pub fn handle_interrupt(&mut self, interrupt: Interrupt) -> Uuid {
        let state = self.self_aware_state.read();
        let restore_point = Uuid::new_v4();

        let entry = ConsciousnessTimelineEntry {
            id: restore_point,
            timestamp: chrono::Utc::now(),
            focus: format!("INTERRUPTED: {:?}", interrupt.reason),
            focus_type: FocusType::Interrupted,
            priority: CognitivePriority::Critical,
            reasoning_chains: state.active_reasoning.iter().map(|r| r.id).collect(),
            interrupted: true,
            interruption_restore_point: None,
        };
        drop(state);

        self.timeline.push_front(entry);

        // Collect stream IDs first to avoid borrow issues
        let stream_ids: Vec<ThoughtStreamId> = self.stream_manager.active_streams.keys().cloned().collect();
        for stream_id in &stream_ids {
            self.stream_manager.pause_stream(stream_id);
        }

        restore_point
    }

    /// Restore from interruption
    pub fn restore_from_interrupt(&mut self, _restore_point: Uuid) {
        let stream_ids: Vec<ThoughtStreamId> = self.stream_manager.active_streams.keys().cloned().collect();
        for stream_id in &stream_ids {
            self.stream_manager.resume_stream(stream_id);
        }
    }

    /// Get current self-aware state
    pub fn get_self_aware_state(&self) -> SelfAwareState {
        self.self_aware_state.read().clone()
    }

    /// Get attention heatmap
    pub fn get_attention_heatmap(&self) -> AttentionHeatmap {
        self.attention_heatmap.read().clone()
    }

    /// Get recent timeline
    pub fn get_timeline(&self, limit: usize) -> Vec<ConsciousnessTimelineEntry> {
        self.timeline.iter().take(limit).cloned().collect()
    }
}

impl Default for ConsciousWorkspace {
    fn default() -> Self {
        Self::new()
    }
}

/// Interrupt types
#[derive(Debug, Clone)]
pub struct Interrupt {
    pub reason: InterruptReason,
    pub priority: CognitivePriority,
    pub can_restore: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InterruptReason {
    CriticalError,
    UserUrgentRequest,
    SystemSafety,
    ResourceExhaustion,
    MemoryCorruption,
    DangerousCommand,
}

/// Broadcast messages from workspace
#[derive(Debug, Clone)]
pub enum WorkspaceBroadcast {
    AttentionShift(AttentionFocus),
    ContextActivated(Vec<String>),
    BandwidthUpdate(CognitiveLoad),
    MetaAttentionFeedback(String),
    WorkingMemoryUpdated(Vec<WorkingMemoryId>),
    ThoughtStreamUpdated(ThoughtStreamId),
}