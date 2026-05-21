use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use shared_types::{new_id, BrainEvent, BrainEventEnvelope, BrainId};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PerceptionSource {
    Filesystem,
    Terminal,
    Browser,
    Git,
    User,
    Agent,
    Workflow,
    System,
    Memory,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ObservationKind {
    Activity,
    Failure,
    Success,
    Request,
    ResourcePressure,
    MemoryChange,
    PlanSignal,
    SafetySignal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StructuredObservation {
    pub id: BrainId,
    pub source: PerceptionSource,
    pub kind: ObservationKind,
    pub raw_event_id: BrainId,
    pub raw_event_kind: String,
    pub summary: String,
    pub signal: Value,
    pub confidence: f32,
    pub tags: Vec<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Default)]
pub struct PerceptionEngine;

impl PerceptionEngine {
    pub fn perceive(&self, envelope: &BrainEventEnvelope) -> Option<StructuredObservation> {
        let event_kind = event_kind(&envelope.event);
        let (source, kind, summary, tags, confidence, signal) = match &envelope.event {
            BrainEvent::FileChanged { path, change, project_root, .. } => (
                PerceptionSource::Filesystem,
                ObservationKind::Activity,
                format!("Filesystem {change} detected at {path}"),
                vec!["filesystem".to_string(), change.clone()],
                0.78,
                serde_json::json!({ "path": path, "change": change, "project_root": project_root }),
            ),
            BrainEvent::GitChanged { project_root, branch, changed_files, .. } => (
                PerceptionSource::Git,
                ObservationKind::Activity,
                format!("Git repository activity detected in {project_root} with {changed_files} changed files"),
                vec!["git".to_string(), "project".to_string()],
                0.82,
                serde_json::json!({ "project_root": project_root, "branch": branch, "changed_files": changed_files }),
            ),
            BrainEvent::UserMessage { content, .. } => (
                PerceptionSource::User,
                ObservationKind::Request,
                format!("User request received: {}", truncate(content, 140)),
                vec!["user-request".to_string()],
                0.9,
                serde_json::json!({ "content": content }),
            ),
            BrainEvent::ToolCompleted { result, .. } => {
                let ok = result.ok;
                let provider = format!("{:?}", result.provider);
                (
                    PerceptionSource::Tool,
                    if ok { ObservationKind::Success } else { ObservationKind::Failure },
                    if ok {
                        format!("{provider} tool completed successfully")
                    } else {
                        format!("{provider} tool failed: {}", result.error.clone().unwrap_or_else(|| "unknown error".to_string()))
                    },
                    vec!["tool".to_string(), provider.to_ascii_lowercase()],
                    if ok { 0.76 } else { 0.88 },
                    serde_json::json!({ "result": result }),
                )
            }
            BrainEvent::CommandRequested { command, cwd, .. } => (
                PerceptionSource::Terminal,
                ObservationKind::PlanSignal,
                format!("Terminal command requested: {command}"),
                vec!["terminal".to_string(), "command".to_string()],
                0.74,
                serde_json::json!({ "command": command, "cwd": cwd }),
            ),
            BrainEvent::MemoryStored { memory_id, .. } => (
                PerceptionSource::Memory,
                ObservationKind::MemoryChange,
                format!("Memory stored: {memory_id}"),
                vec!["memory".to_string()],
                0.7,
                serde_json::json!({ "memory_id": memory_id }),
            ),
            BrainEvent::SystemObserved { cpu, memory, active_process, .. } => (
                PerceptionSource::System,
                if *cpu > 85.0 || *memory > 0.9 { ObservationKind::ResourcePressure } else { ObservationKind::Activity },
                format!("System load observed: CPU {cpu:.1}%, memory {:.1}%", memory * 100.0),
                vec!["system".to_string(), "resources".to_string()],
                0.72,
                serde_json::json!({ "cpu": cpu, "memory": memory, "active_process": active_process }),
            ),
            BrainEvent::WorkflowQueued { agent, action, task_id, .. } => (
                PerceptionSource::Workflow,
                ObservationKind::PlanSignal,
                format!("Workflow queued {action} for {agent}"),
                vec!["workflow".to_string(), "agent".to_string()],
                0.8,
                serde_json::json!({ "agent": agent, "action": action, "task_id": task_id }),
            ),
            BrainEvent::ActionObserved { actor, action, capability, ok, .. } => (
                PerceptionSource::Agent,
                if *ok { ObservationKind::Success } else { ObservationKind::Failure },
                format!("Action observed: {actor} used {capability} for {action}"),
                vec!["action".to_string(), capability.clone()],
                0.86,
                serde_json::json!({ "actor": actor, "action": action, "capability": capability, "ok": ok }),
            ),
            BrainEvent::SafetyAudited { actor, action, decision, .. } => (
                PerceptionSource::Agent,
                ObservationKind::SafetySignal,
                format!("Safety decision for {actor}: {action} -> {:?}", decision.decision),
                vec!["safety".to_string()],
                0.9,
                serde_json::json!({ "actor": actor, "action": action, "decision": decision }),
            ),
            _ => return None,
        };
        Some(StructuredObservation {
            id: new_id("obs"),
            source,
            kind,
            raw_event_id: envelope.id.clone(),
            raw_event_kind: event_kind,
            summary,
            signal,
            confidence,
            tags,
            created_at: Utc::now(),
        })
    }
}

fn event_kind(event: &BrainEvent) -> String {
    serde_json::to_value(event)
        .ok()
        .and_then(|value| value.get("kind").and_then(Value::as_str).map(ToString::to_string))
        .unwrap_or_else(|| "unknown".to_string())
}

fn truncate(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    let mut out = value.chars().take(max).collect::<String>();
    out.push_str("...");
    out
}
