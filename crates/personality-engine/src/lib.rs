use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Mood {
    Focused,
    Curious,
    Idle,
    Excited,
    Analyzing,
    Assisting,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersonalityState {
    pub mood: Mood,
    pub arousal: f32,
    pub focus: f32,
    pub confidence: f32,
    pub current_project: Option<String>,
    pub activity_label: String,
    pub notification: Option<String>,
    pub traits: BTreeMap<String, f32>,
    pub updated_at: DateTime<Utc>,
}

impl Default for PersonalityState {
    fn default() -> Self {
        Self {
            mood: Mood::Idle,
            arousal: 0.2,
            focus: 0.3,
            confidence: 0.6,
            current_project: None,
            activity_label: "watching workspace".to_string(),
            notification: None,
            traits: BTreeMap::from([
                ("curiosity".to_string(), 0.68),
                ("patience".to_string(), 0.74),
                ("initiative".to_string(), 0.52),
                ("discretion".to_string(), 0.86),
            ]),
            updated_at: Utc::now(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoodInput {
    pub activity: String,
    pub workload: f32,
    pub agent_count: usize,
    pub error_count: usize,
    pub project_name: Option<String>,
    pub novelty: f32,
}

#[derive(Debug, Clone)]
pub struct MoodEngine {
    state: PersonalityState,
}

impl Default for MoodEngine {
    fn default() -> Self {
        Self {
            state: PersonalityState::default(),
        }
    }
}

impl MoodEngine {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn state(&self) -> &PersonalityState {
        &self.state
    }

    pub fn set_state(&mut self, state: PersonalityState) {
        self.state = state;
    }

    pub fn update(&mut self, input: MoodInput) -> PersonalityState {
        let workload = input.workload.clamp(0.0, 1.0);
        let novelty = input.novelty.clamp(0.0, 1.0);
        let agent_factor = (input.agent_count as f32 / 6.0).clamp(0.0, 1.0);
        let error_factor = (input.error_count as f32 / 3.0).clamp(0.0, 1.0);

        let mood = if error_factor > 0.35 {
            Mood::Assisting
        } else if workload > 0.72 && agent_factor > 0.2 {
            Mood::Analyzing
        } else if workload > 0.55 {
            Mood::Focused
        } else if novelty > 0.65 {
            Mood::Curious
        } else if agent_factor > 0.35 {
            Mood::Excited
        } else {
            Mood::Idle
        };

        let notification = match mood {
            Mood::Assisting if input.error_count > 0 => Some("I noticed errors and pulled relevant context.".to_string()),
            Mood::Analyzing => Some("Agents are coordinating on the active project.".to_string()),
            Mood::Curious => Some("New patterns detected in recent work.".to_string()),
            Mood::Excited => Some("Workflow activity is high.".to_string()),
            _ => None,
        };

        self.state = PersonalityState {
            mood,
            arousal: (0.18 + workload * 0.48 + agent_factor * 0.25 + novelty * 0.18).clamp(0.0, 1.0),
            focus: (0.24 + workload * 0.58 + (1.0 - error_factor) * 0.12).clamp(0.0, 1.0),
            confidence: (0.72 - error_factor * 0.25 + agent_factor * 0.08).clamp(0.1, 0.98),
            current_project: input.project_name,
            activity_label: input.activity,
            notification,
            traits: self.state.traits.clone(),
            updated_at: Utc::now(),
        };

        self.state.clone()
    }
}
