use chrono::{DateTime, Utc};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use shared_types::{new_id, BrainEventEnvelope};
use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReasoningTrace {
    pub id: String,
    pub kind: String,
    pub summary: String,
    pub metadata: Value,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EventMetrics {
    pub total_events: usize,
    pub by_kind: BTreeMap<String, usize>,
}

#[derive(Clone)]
pub struct ObservabilityHub {
    traces: Arc<RwLock<VecDeque<ReasoningTrace>>>,
    metrics: Arc<RwLock<EventMetrics>>,
    limit: usize,
}

impl Default for ObservabilityHub {
    fn default() -> Self {
        Self {
            traces: Arc::new(RwLock::new(VecDeque::with_capacity(512))),
            metrics: Arc::new(RwLock::new(EventMetrics::default())),
            limit: 512,
        }
    }
}

impl ObservabilityHub {
    pub fn trace(&self, kind: impl Into<String>, summary: impl Into<String>, metadata: Value) -> ReasoningTrace {
        let trace = ReasoningTrace {
            id: new_id("trace"),
            kind: kind.into(),
            summary: summary.into(),
            metadata,
            created_at: Utc::now(),
        };
        let mut traces = self.traces.write();
        if traces.len() >= self.limit {
            traces.pop_front();
        }
        traces.push_back(trace.clone());
        trace
    }

    pub fn record_event(&self, envelope: &BrainEventEnvelope) {
        let mut metrics = self.metrics.write();
        metrics.total_events += 1;
        let kind = serde_json::to_value(&envelope.event)
            .ok()
            .and_then(|value| value.get("kind").and_then(Value::as_str).map(ToString::to_string))
            .unwrap_or_else(|| "unknown".to_string());
        *metrics.by_kind.entry(kind).or_insert(0) += 1;
    }

    pub fn recent_traces(&self, limit: usize) -> Vec<ReasoningTrace> {
        self.traces.read().iter().rev().take(limit).cloned().collect()
    }

    pub fn metrics(&self) -> EventMetrics {
        self.metrics.read().clone()
    }
}
