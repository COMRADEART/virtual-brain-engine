use chrono::{DateTime, Utc};
use cognitive_state::{CognitiveMode, WorldState};
use learning_engine::LearningSignal;
use reflection_engine::ReflectionRecord;
use serde::{Deserialize, Serialize};
use shared_types::{new_id, BrainId};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdaptationDecision {
    pub id: BrainId,
    pub trigger: String,
    pub behavior: String,
    pub rationale: String,
    pub priority_delta: i32,
    pub notification_policy: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Default)]
pub struct AdaptationEngine;

impl AdaptationEngine {
    pub fn adapt(
        &self,
        world: &WorldState,
        reflection: Option<&ReflectionRecord>,
        learning: Option<&LearningSignal>,
    ) -> Vec<AdaptationDecision> {
        let mut decisions = Vec::new();
        if matches!(&world.cognitive_mode, CognitiveMode::Focused) {
            decisions.push(decision(
                "focus-mode",
                "reduce-noncritical-notifications",
                "World state indicates focused project work.",
                -10,
                "quiet",
            ));
        }
        if world.system_load.memory > 0.9 || world.system_load.cpu > 85.0 {
            decisions.push(decision(
                "resource-pressure",
                "prefer-lightweight-local-actions",
                "System load is high, so expensive workflows should be delayed.",
                20,
                "only-critical",
            ));
        }
        if let Some(reflection) = reflection {
            if !reflection.failed.is_empty() {
                decisions.push(decision(
                    "recent-failure",
                    "increase-safety-and-reflection-before-retry",
                    "Reflection detected a failed execution outcome.",
                    25,
                    "surface-failure",
                ));
            }
        }
        if let Some(learning) = learning {
            if learning.confidence_delta > 0.0 {
                decisions.push(decision(
                    "positive-learning-signal",
                    "prefer-recent-successful-workflow",
                    "Learning signal improved confidence.",
                    -5,
                    "normal",
                ));
            }
        }
        decisions
    }
}

fn decision(trigger: &str, behavior: &str, rationale: &str, priority_delta: i32, notification_policy: &str) -> AdaptationDecision {
    AdaptationDecision {
        id: new_id("adaptation"),
        trigger: trigger.to_string(),
        behavior: behavior.to_string(),
        rationale: rationale.to_string(),
        priority_delta,
        notification_policy: notification_policy.to_string(),
        created_at: Utc::now(),
    }
}
