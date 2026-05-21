use chrono::{DateTime, Utc};
use reflection_engine::ReflectionRecord;
use serde::{Deserialize, Serialize};
use shared_types::{new_id, BrainId};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Lesson {
    pub id: BrainId,
    pub reflection_id: BrainId,
    pub summary: String,
    pub tags: Vec<String>,
    pub confidence: f32,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearningSignal {
    pub id: BrainId,
    pub lesson_id: BrainId,
    pub skill_id: Option<BrainId>,
    pub memory_tags: Vec<String>,
    pub confidence_delta: f32,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Default)]
pub struct LearningEngine;

impl LearningEngine {
    pub fn learn_from_reflection(&self, reflection: &ReflectionRecord) -> (Lesson, LearningSignal) {
        let tags = reflection
            .patterns
            .iter()
            .cloned()
            .chain(reflection.inefficiencies.iter().cloned())
            .chain(reflection.skill_improved.iter().cloned())
            .chain(if reflection.failed.is_empty() {
                vec!["success".to_string()]
            } else {
                vec!["failure".to_string()]
            })
            .collect::<Vec<_>>();
        let lesson = Lesson {
            id: new_id("lesson"),
            reflection_id: reflection.id.clone(),
            summary: if reflection.failed.is_empty() {
                format!("Keep workflow pattern: {}", reflection.summary)
            } else {
                format!("Adjust workflow after failure: {}", reflection.summary)
            },
            tags: tags.clone(),
            confidence: (0.55 + reflection.confidence_delta).clamp(0.05, 0.95),
            created_at: Utc::now(),
        };
        let signal = LearningSignal {
            id: new_id("learning"),
            lesson_id: lesson.id.clone(),
            skill_id: reflection.skill_improved.clone(),
            memory_tags: tags,
            confidence_delta: reflection.confidence_delta,
            created_at: Utc::now(),
        };
        (lesson, signal)
    }
}
