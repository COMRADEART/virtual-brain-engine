//! # Cognitive Bandwidth System

use crate::{GlobalWorkspace, WorkingMemory};
use std::collections::VecDeque;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CognitiveLoad {
    Idle,
    Light,
    Moderate,
    Heavy,
    Overloaded,
    Critical,
}

impl CognitiveLoad {
    pub fn from_percentage(pct: f64) -> Self {
        if pct < 0.20 {
            CognitiveLoad::Idle
        } else if pct < 0.40 {
            CognitiveLoad::Light
        } else if pct < 0.60 {
            CognitiveLoad::Moderate
        } else if pct < 0.80 {
            CognitiveLoad::Heavy
        } else if pct < 0.95 {
            CognitiveLoad::Overloaded
        } else {
            CognitiveLoad::Critical
        }
    }

    pub fn throttle_factor(&self) -> f64 {
        match self {
            CognitiveLoad::Idle => 1.0,
            CognitiveLoad::Light => 1.0,
            CognitiveLoad::Moderate => 0.85,
            CognitiveLoad::Heavy => 0.65,
            CognitiveLoad::Overloaded => 0.4,
            CognitiveLoad::Critical => 0.2,
        }
    }

    pub fn reasoning_depth_factor(&self) -> f64 {
        match self {
            CognitiveLoad::Idle => 1.0,
            CognitiveLoad::Light => 0.95,
            CognitiveLoad::Moderate => 0.75,
            CognitiveLoad::Heavy => 0.5,
            CognitiveLoad::Overloaded => 0.3,
            CognitiveLoad::Critical => 0.1,
        }
    }

    pub fn description(&self) -> &'static str {
        match self {
            CognitiveLoad::Idle => "Idle - plenty of cognitive capacity available",
            CognitiveLoad::Light => "Light load - comfortable processing",
            CognitiveLoad::Moderate => "Moderate load - normal operation",
            CognitiveLoad::Heavy => "Heavy load - consider reducing tasks",
            CognitiveLoad::Overloaded => "Overloaded - prioritize critical tasks only",
            CognitiveLoad::Critical => "Critical - emergency throttling active",
        }
    }
}

pub struct BandwidthController {
    pub load_history: VecDeque<(chrono::DateTime<chrono::Utc>, f64)>,
    pub load_threshold: f64,
    pub throttle_active: bool,
    pub emergency_count: usize,
    pub capacity_percentage: f64,
}

impl BandwidthController {
    pub fn new() -> Self {
        Self {
            load_history: VecDeque::with_capacity(60),
            load_threshold: 0.85,
            throttle_active: false,
            emergency_count: 0,
            capacity_percentage: 0.0,
        }
    }

    pub fn calculate_load(
        &mut self,
        working_memory: &WorkingMemory,
        global_workspace: &GlobalWorkspace,
        _previous_load: &CognitiveLoad,
    ) -> CognitiveLoad {
        let memory_load = working_memory.current_load;

        let attention_count = global_workspace.candidates.len() as f64;
        let attention_load = (attention_count / 20.0).min(1.0);

        let stream_load = 0.0;

        let total_load = memory_load * 0.5 + attention_load * 0.35 + stream_load * 0.15;
        let total_load = total_load.clamp(0.0, 1.0);
        self.capacity_percentage = total_load;

        self.load_history.push_front((chrono::Utc::now(), total_load));
        if self.load_history.len() > 60 {
            self.load_history.pop_back();
        }

        let load = CognitiveLoad::from_percentage(total_load);

        if load == CognitiveLoad::Overloaded || load == CognitiveLoad::Critical {
            self.emergency_count += 1;
            if self.emergency_count > 3 {
                self.throttle_active = true;
            }
        } else {
            self.emergency_count = 0;
        }

        if self.emergency_count == 0 {
            self.throttle_active = false;
        }

        load
    }

    pub fn get_load_trend(&self) -> LoadTrend {
        if self.load_history.len() < 5 {
            return LoadTrend::InsufficientData;
        }

        let recent: Vec<_> = self.load_history.iter().take(10).collect();
        let older: Vec<_> = self.load_history.iter().skip(10).take(10).collect();

        if recent.is_empty() || older.is_empty() {
            return LoadTrend::Stable;
        }

        let recent_avg: f64 = recent.iter().map(|(_, v)| v).sum::<f64>() / recent.len() as f64;
        let older_avg: f64 = older.iter().map(|(_, v)| v).sum::<f64>() / older.len() as f64;

        let diff = recent_avg - older_avg;
        if diff > 0.1 {
            LoadTrend::Increasing
        } else if diff < -0.1 {
            LoadTrend::Decreasing
        } else {
            LoadTrend::Stable
        }
    }

    pub fn get_recommendation(&self, load: CognitiveLoad) -> BandwidthRecommendation {
        let trend = self.get_load_trend();
        let history_avg = if !self.load_history.is_empty() {
            self.load_history.iter().map(|(_, v)| v).sum::<f64>()
                / self.load_history.len() as f64
        } else {
            0.0
        };

        BandwidthRecommendation {
            current_load: load,
            current_load_pct: self.capacity_percentage,
            load_trend: trend,
            average_load: history_avg,
            should_throttle: self.throttle_active || load == CognitiveLoad::Critical,
            throttle_factor: load.throttle_factor(),
            reasoning_depth_factor: load.reasoning_depth_factor(),
            recommended_actions: self.suggest_actions(load, trend),
            warnings: self.get_warnings(load),
        }
    }

    fn suggest_actions(&self, load: CognitiveLoad, trend: LoadTrend) -> Vec<String> {
        let mut actions = Vec::new();

        match load {
            CognitiveLoad::Critical => {
                actions.push("EMERGENCY: Reduce all non-essential processing".to_string());
                actions.push("Consider pausing background simulations".to_string());
                actions.push("Queue non-urgent tasks for later".to_string());
            }
            CognitiveLoad::Overloaded => {
                actions.push("Reduce parallel thought streams".to_string());
                actions.push("Prioritize only high-importance memories".to_string());
                actions.push("Consider deferring learning tasks".to_string());
            }
            CognitiveLoad::Heavy => {
                if trend == LoadTrend::Increasing {
                    actions.push("Monitor load - trending up".to_string());
                }
                actions.push("Batch similar operations".to_string());
            }
            CognitiveLoad::Moderate => {
                if trend == LoadTrend::Increasing {
                    actions.push("Load increasing - prepare to throttle".to_string());
                }
            }
            _ => {}
        }

        actions
    }

    fn get_warnings(&self, load: CognitiveLoad) -> Vec<String> {
        let mut warnings = Vec::new();

        if load == CognitiveLoad::Critical {
            warnings.push("Cognitive capacity nearly exhausted".to_string());
        } else if load == CognitiveLoad::Overloaded {
            warnings.push("Processing capacity exceeded".to_string());
        }

        if self.emergency_count > 5 {
            warnings.push(format!(
                "Extended emergency state: {} consecutive high-load cycles",
                self.emergency_count
            ));
        }

        let trend = self.get_load_trend();
        if trend == LoadTrend::Increasing && load != CognitiveLoad::Idle {
            warnings.push("Load trending upward".to_string());
        }

        warnings
    }

    pub fn get_load_percentage(&self) -> f64 {
        self.capacity_percentage * 100.0
    }
}

impl Default for BandwidthController {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone)]
pub struct BandwidthRecommendation {
    pub current_load: CognitiveLoad,
    pub current_load_pct: f64,
    pub load_trend: LoadTrend,
    pub average_load: f64,
    pub should_throttle: bool,
    pub throttle_factor: f64,
    pub reasoning_depth_factor: f64,
    pub recommended_actions: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoadTrend {
    Increasing,
    Stable,
    Decreasing,
    InsufficientData,
}

pub fn is_dangerous_command(command: &str) -> bool {
    let dangerous_patterns = [
        "rm -rf",
        "del /f /s /q",
        "format",
        "shutdown",
        "reboot",
        "kill -9",
        "taskkill /f",
        "drop database",
        "truncate",
        "ALTER TABLE",
        "DROP TABLE",
        "mv /*",
        "dd if=",
    ];

    let cmd_lower = command.to_lowercase();
    dangerous_patterns
        .iter()
        .any(|p| cmd_lower.contains(&p.to_lowercase()))
}