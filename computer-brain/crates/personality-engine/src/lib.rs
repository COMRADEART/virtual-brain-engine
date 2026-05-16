use chrono::Utc;
use shared_types::{PetMood, PetState};

#[derive(Debug, Clone)]
pub struct MoodInput {
    pub workload: f32,
    pub agent_activity: usize,
    pub errors: usize,
    pub novelty: f32,
    pub project: Option<String>,
    pub brief: String,
}

#[derive(Clone, Default)]
pub struct PersonalityEngine {
    state: PetState,
}

impl PersonalityEngine {
    pub fn state(&self) -> PetState {
        self.state.clone()
    }

    pub fn update(&mut self, input: MoodInput) -> PetState {
        let workload = input.workload.clamp(0.0, 1.0);
        let novelty = input.novelty.clamp(0.0, 1.0);
        let mood = if input.errors > 0 {
            PetMood::Assisting
        } else if workload > 0.7 {
            PetMood::Analyzing
        } else if input.agent_activity > 2 {
            PetMood::Thinking
        } else if novelty > 0.62 {
            PetMood::Curious
        } else if workload > 0.35 {
            PetMood::Focused
        } else {
            PetMood::Idle
        };
        self.state = PetState {
            mood,
            focus: (0.24 + workload * 0.6).clamp(0.0, 1.0),
            arousal: (0.18 + workload * 0.38 + novelty * 0.22 + input.agent_activity as f32 * 0.04)
                .clamp(0.0, 1.0),
            current_project: input.project,
            recent_brief: input.brief,
            notification: if input.errors > 0 {
                Some("I found activity that may need attention.".to_string())
            } else if novelty > 0.62 {
                Some("New project pattern detected.".to_string())
            } else {
                None
            },
            updated_at: Utc::now(),
        };
        self.state.clone()
    }
}
