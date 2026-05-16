use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use shared_types::MemoryRecord;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineSummary {
    pub period: String,
    pub memory_count: usize,
    pub top_projects: Vec<String>,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecurringWork {
    pub theme: String,
    pub count: usize,
}

#[derive(Clone, Default)]
pub struct TemporalEngine;

impl TemporalEngine {
    pub fn summarize_period(&self, memories: &[MemoryRecord], since: DateTime<Utc>, label: &str) -> TimelineSummary {
        let filtered = memories
            .iter()
            .filter(|memory| memory.updated_at >= since)
            .collect::<Vec<_>>();
        let mut projects = BTreeMap::<String, usize>::new();
        for memory in &filtered {
            if let Some(project_id) = &memory.project_id {
                *projects.entry(project_id.clone()).or_default() += 1;
            }
        }
        let mut top_projects = projects.into_iter().collect::<Vec<_>>();
        top_projects.sort_by_key(|(_, count)| std::cmp::Reverse(*count));
        let themes = recurring_themes(memories, 2);
        TimelineSummary {
            period: label.to_string(),
            memory_count: filtered.len(),
            top_projects: top_projects.into_iter().take(5).map(|(project, _)| project).collect(),
            summary: format!(
                "{} memories since {}; strongest recurring theme: {}",
                filtered.len(),
                label,
                themes.first().map(|t| t.theme.as_str()).unwrap_or("none")
            ),
        }
    }

    pub fn daily_summary(&self, memories: &[MemoryRecord]) -> TimelineSummary {
        self.summarize_period(memories, Utc::now() - Duration::days(1), "last 24 hours")
    }

    pub fn weekly_summary(&self, memories: &[MemoryRecord]) -> TimelineSummary {
        self.summarize_period(memories, Utc::now() - Duration::days(7), "last 7 days")
    }

    pub fn decayed_importance(&self, memory: &MemoryRecord, now: DateTime<Utc>) -> f32 {
        let age_days = (now - memory.updated_at).num_seconds().max(0) as f32 / 86_400.0;
        let decay = 0.5_f32.powf(age_days / 21.0);
        (memory.importance * decay + memory.importance * 0.25).clamp(0.08, 1.0)
    }
}

pub fn recurring_themes(memories: &[MemoryRecord], min_count: usize) -> Vec<RecurringWork> {
    let mut counts = BTreeMap::<String, usize>::new();
    for memory in memories {
        for tag in &memory.tags {
            *counts.entry(tag.to_ascii_lowercase()).or_default() += 1;
        }
    }
    let mut out = counts
        .into_iter()
        .filter(|(_, count)| *count >= min_count)
        .map(|(theme, count)| RecurringWork { theme, count })
        .collect::<Vec<_>>();
    out.sort_by_key(|item| std::cmp::Reverse(item.count));
    out
}
