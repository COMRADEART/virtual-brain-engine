use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TemporalEventKind {
    SessionStarted,
    SessionEnded,
    FileModified,
    SummaryCreated,
    MemoryCreated,
    WorkflowRan,
    BugObserved,
    CommitCreated,
    MilestoneReached,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemporalEvent {
    pub id: String,
    pub project_name: Option<String>,
    pub kind: TemporalEventKind,
    pub title: String,
    pub detail: String,
    pub related_path: Option<String>,
    pub related_memory_id: Option<String>,
    pub importance: f32,
    pub occurred_at: DateTime<Utc>,
}

impl TemporalEvent {
    pub fn new(
        project_name: Option<String>,
        kind: TemporalEventKind,
        title: impl Into<String>,
        detail: impl Into<String>,
        importance: f32,
    ) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            project_name,
            kind,
            title: title.into(),
            detail: detail.into(),
            related_path: None,
            related_memory_id: None,
            importance: importance.clamp(0.0, 1.0),
            occurred_at: Utc::now(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineWindow {
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectFocus {
    pub project_name: String,
    pub event_count: usize,
    pub weighted_focus: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecurringPattern {
    pub key: String,
    pub event_count: usize,
    pub last_seen: DateTime<Utc>,
    pub average_importance: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryDecayConfig {
    pub half_life_days: f32,
    pub floor: f32,
    pub importance_boost: f32,
}

impl Default for MemoryDecayConfig {
    fn default() -> Self {
        Self {
            half_life_days: 21.0,
            floor: 0.12,
            importance_boost: 0.35,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct TemporalEngine {
    events: Vec<TemporalEvent>,
}

impl TemporalEngine {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_event(&mut self, event: TemporalEvent) {
        self.events.push(event);
        self.events.sort_by_key(|e| e.occurred_at);
    }

    pub fn events(&self) -> &[TemporalEvent] {
        &self.events
    }

    pub fn between(&self, window: TimelineWindow) -> Vec<TemporalEvent> {
        self.events
            .iter()
            .filter(|event| event.occurred_at >= window.start && event.occurred_at <= window.end)
            .cloned()
            .collect()
    }

    pub fn recent(&self, duration: Duration) -> Vec<TemporalEvent> {
        let start = Utc::now() - duration;
        self.between(TimelineWindow {
            start,
            end: Utc::now(),
        })
    }

    pub fn focus_by_project(&self, window: TimelineWindow) -> Vec<ProjectFocus> {
        let mut scores = BTreeMap::<String, (usize, f32)>::new();
        for event in self.between(window) {
            let Some(project) = event.project_name else {
                continue;
            };
            let entry = scores.entry(project).or_insert((0, 0.0));
            entry.0 += 1;
            entry.1 += event.importance.clamp(0.0, 1.0);
        }
        let mut focus = scores
            .into_iter()
            .map(|(project_name, (event_count, weighted_focus))| ProjectFocus {
                project_name,
                event_count,
                weighted_focus,
            })
            .collect::<Vec<_>>();
        focus.sort_by(|a, b| b.weighted_focus.partial_cmp(&a.weighted_focus).unwrap_or(std::cmp::Ordering::Equal));
        focus
    }

    pub fn recurring_patterns(&self, min_count: usize) -> Vec<RecurringPattern> {
        let mut groups = BTreeMap::<String, Vec<&TemporalEvent>>::new();
        for event in &self.events {
            let key = format!(
                "{}::{}",
                event.project_name.as_deref().unwrap_or("global"),
                normalize_title(&event.title)
            );
            groups.entry(key).or_default().push(event);
        }
        let mut patterns = groups
            .into_iter()
            .filter_map(|(key, events)| {
                if events.len() < min_count {
                    return None;
                }
                Some(RecurringPattern {
                    key,
                    event_count: events.len(),
                    last_seen: events.iter().map(|e| e.occurred_at).max().unwrap_or_else(Utc::now),
                    average_importance: events.iter().map(|e| e.importance).sum::<f32>() / events.len() as f32,
                })
            })
            .collect::<Vec<_>>();
        patterns.sort_by_key(|p| std::cmp::Reverse(p.last_seen));
        patterns
    }
}

pub fn decayed_importance(
    original_importance: f32,
    last_accessed: DateTime<Utc>,
    now: DateTime<Utc>,
    config: &MemoryDecayConfig,
) -> f32 {
    let age_days = (now - last_accessed).num_seconds().max(0) as f32 / 86_400.0;
    let half_life = config.half_life_days.max(1.0);
    let decay = 0.5_f32.powf(age_days / half_life);
    let boosted = original_importance.clamp(0.0, 1.0) * decay + config.importance_boost * original_importance;
    boosted.max(config.floor).clamp(0.0, 1.0)
}

fn normalize_title(title: &str) -> String {
    title
        .to_ascii_lowercase()
        .split_whitespace()
        .filter(|word| word.len() > 2)
        .take(6)
        .collect::<Vec<_>>()
        .join("-")
}
