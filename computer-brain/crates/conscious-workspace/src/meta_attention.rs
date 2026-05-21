//! # Meta-Attention System

use crate::{CognitiveLoad, SelfAwareState, WorkingMemory};
use std::collections::VecDeque;

pub struct MetaAttention {
    pub attention_cycle_count: usize,
    pub focus_stability_history: VecDeque<(chrono::DateTime<chrono::Utc>, f64)>,
    pub attention_switches: usize,
    pub regulation_history: VecDeque<MetaAttentionRecord>,
}

impl MetaAttention {
    pub fn new() -> Self {
        Self {
            attention_cycle_count: 0,
            focus_stability_history: VecDeque::with_capacity(50),
            attention_switches: 0,
            regulation_history: VecDeque::with_capacity(100),
        }
    }

    pub fn regulate(
        &mut self,
        state: &SelfAwareState,
        working_memory: &WorkingMemory,
    ) -> Option<String> {
        self.attention_cycle_count += 1;

        let stability = self.calculate_stability(state);
        self.focus_stability_history
            .push_front((chrono::Utc::now(), stability));
        if self.focus_stability_history.len() > 50 {
            self.focus_stability_history.pop_back();
        }

        let feedback = self.analyze_and_regulate(state, working_memory, stability);

        if let Some(ref f) = feedback {
            self.regulation_history.push_front(MetaAttentionRecord {
                timestamp: chrono::Utc::now(),
                cycle: self.attention_cycle_count,
                issue: f.clone(),
                stability,
                current_focus: state.current_focus.as_ref().map(|c| c.content.clone()),
            });
            if self.regulation_history.len() > 100 {
                self.regulation_history.pop_back();
            }
        }

        feedback
    }

    fn calculate_stability(&self, state: &SelfAwareState) -> f64 {
        let mut stability = 1.0;

        let stream_penalty = (state.active_streams.len() as f64 * 0.05).min(0.3);
        stability -= stream_penalty;

        stability -= state.uncertainty_level * 0.3;

        if state.attention_bandwidth_used < 0.2 {
            stability -= 0.1;
        }

        if state.working_memory_load < 0.1 && state.current_focus.is_some() {
            stability -= 0.15;
        }

        stability.clamp(0.0, 1.0)
    }

    fn analyze_and_regulate(
        &mut self,
        state: &SelfAwareState,
        working_memory: &WorkingMemory,
        stability: f64,
    ) -> Option<String> {
        let prev_focus = self.focus_stability_history.get(1).map(|(_, s)| *s);

        if let Some(prev) = prev_focus {
            if stability < prev - 0.2 {
                self.attention_switches += 1;
            }
        }

        match state.cognitive_load {
            CognitiveLoad::Critical => {
                self.attention_switches = 0;
                return Some("CRITICAL: Reduce all cognitive activity".to_string());
            }
            CognitiveLoad::Overloaded => {
                self.attention_switches = 0;
                return Some("Reduce parallel processing - too many active streams".to_string());
            }
            _ => {}
        }

        if stability < 0.4 {
            return Some("Attention fragmented - consider focusing on fewer tasks".to_string());
        }

        if let (Some(current), Some(prev)) = (&state.current_focus, prev_focus) {
            if stability > 0.9 && prev > 0.9 {
                let age_ms = (chrono::Utc::now() - current.created_at).num_milliseconds() as u64;
                if age_ms > 120000 {
                    return Some("Rumination detected - consider shifting focus".to_string());
                }
            }
        }

        if state.working_memory_load < 0.15 && state.current_focus.is_some() {
            return Some("Low cognitive engagement - add detail to current reasoning".to_string());
        }

        if working_memory.entries.len() > 50 {
            return Some("Working memory nearly full - consider processing some items".to_string());
        }

        if self.attention_switches > 5 {
            self.attention_switches = 0;
            return Some("Too many attention switches - maintain focus longer".to_string());
        }

        if state.cognitive_load == CognitiveLoad::Heavy {
            return Some("Heavy cognitive load - prioritize carefully".to_string());
        }

        None
    }

    pub fn get_stats(&self) -> MetaAttentionStats {
        let avg_stability = if !self.focus_stability_history.is_empty() {
            self.focus_stability_history
                .iter()
                .map(|(_, s)| s)
                .sum::<f64>()
                / self.focus_stability_history.len() as f64
        } else {
            0.0
        };

        let recent_switches = self
            .regulation_history
            .iter()
            .filter(|r| r.timestamp > chrono::Utc::now() - chrono::Duration::minutes(5))
            .count();

        MetaAttentionStats {
            cycle_count: self.attention_cycle_count,
            avg_stability,
            recent_issue_count: self.regulation_history.len(),
            recent_switches,
        }
    }

    pub fn get_recommendation(&self, state: &SelfAwareState) -> MetaAttentionRecommendation {
        let stats = self.get_stats();

        let mut adjustments = Vec::new();
        let mut warnings = Vec::new();

        if stats.avg_stability < 0.5 {
            adjustments.push("Consider reducing task complexity".to_string());
            warnings.push("Low attention stability detected".to_string());
        }

        match state.cognitive_load {
            CognitiveLoad::Critical => {
                adjustments.push("Reduce to minimal viable processing".to_string());
            }
            CognitiveLoad::Overloaded => {
                adjustments.push("Prioritize single-threaded processing".to_string());
            }
            _ => {}
        }

        if state.working_memory_load > 0.9 {
            adjustments.push("Process and consolidate working memory".to_string());
        } else if state.working_memory_load < 0.1 {
            adjustments.push("Increase engagement with current task".to_string());
        }

        if state.uncertainty_level > 0.7 {
            adjustments.push("Seek more context for uncertain areas".to_string());
            warnings.push(format!("High uncertainty: {:.0}%", state.uncertainty_level * 100.0));
        }

        MetaAttentionRecommendation {
            stats,
            recommended_adjustments: adjustments,
            warnings,
        }
    }
}

impl Default for MetaAttention {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone)]
pub struct MetaAttentionRecord {
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub cycle: usize,
    pub issue: String,
    pub stability: f64,
    pub current_focus: Option<String>,
}

#[derive(Debug, Clone)]
pub struct MetaAttentionStats {
    pub cycle_count: usize,
    pub avg_stability: f64,
    pub recent_issue_count: usize,
    pub recent_switches: usize,
}

#[derive(Debug, Clone)]
pub struct MetaAttentionRecommendation {
    pub stats: MetaAttentionStats,
    pub recommended_adjustments: Vec<String>,
    pub warnings: Vec<String>,
}