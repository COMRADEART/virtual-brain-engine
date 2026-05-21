use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TaskState {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowTask {
    pub id: String,
    pub workflow_id: Option<String>,
    pub agent: String,
    pub action: String,
    pub priority: u8,
    pub state: TaskState,
    pub payload: serde_json::Value,
    pub attempts: u32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowStep {
    pub agent: String,
    pub action: String,
    pub priority: u8,
    pub payload_template: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowDefinition {
    pub id: String,
    pub name: String,
    pub trigger: String,
    pub steps: Vec<WorkflowStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowLog {
    pub id: String,
    pub task_id: String,
    pub agent: String,
    pub event: String,
    pub detail: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default)]
pub struct WorkflowEngine {
    definitions: BTreeMap<String, WorkflowDefinition>,
    tasks: BTreeMap<String, WorkflowTask>,
    logs: Vec<WorkflowLog>,
}

impl WorkflowEngine {
    pub fn new() -> Self {
        let mut engine = Self::default();
        engine.register(default_observer_pipeline());
        engine
    }

    pub fn register(&mut self, definition: WorkflowDefinition) {
        self.definitions.insert(definition.id.clone(), definition);
    }

    pub fn definitions(&self) -> impl Iterator<Item = &WorkflowDefinition> {
        self.definitions.values()
    }

    pub fn tasks(&self) -> impl Iterator<Item = &WorkflowTask> {
        self.tasks.values()
    }

    pub fn logs(&self) -> &[WorkflowLog] {
        &self.logs
    }

    pub fn enqueue(
        &mut self,
        workflow_id: Option<String>,
        agent: impl Into<String>,
        action: impl Into<String>,
        priority: u8,
        payload: serde_json::Value,
    ) -> WorkflowTask {
        let now = Utc::now();
        let task = WorkflowTask {
            id: Uuid::new_v4().to_string(),
            workflow_id,
            agent: agent.into(),
            action: action.into(),
            priority: priority.min(100),
            state: TaskState::Pending,
            payload,
            attempts: 0,
            created_at: now,
            updated_at: now,
        };
        self.log(&task, "queued", "Task queued");
        self.tasks.insert(task.id.clone(), task.clone());
        task
    }

    pub fn trigger(&mut self, trigger: &str, payload: serde_json::Value) -> Vec<WorkflowTask> {
        let definitions = self
            .definitions
            .values()
            .filter(|definition| definition.trigger == trigger)
            .cloned()
            .collect::<Vec<_>>();
        let mut queued = Vec::new();
        for definition in definitions {
            for step in definition.steps {
                let merged = merge_payload(&step.payload_template, &payload);
                queued.push(self.enqueue(
                    Some(definition.id.clone()),
                    step.agent,
                    step.action,
                    step.priority,
                    merged,
                ));
            }
        }
        queued
    }

    pub fn next_task(&mut self) -> Option<WorkflowTask> {
        let task_id = self
            .tasks
            .values()
            .filter(|task| task.state == TaskState::Pending)
            .max_by(|a, b| {
                a.priority
                    .cmp(&b.priority)
                    .then_with(|| b.created_at.cmp(&a.created_at))
            })
            .map(|task| task.id.clone())?;
        let mut task = self.tasks.get(&task_id)?.clone();
        task.state = TaskState::Running;
        task.attempts += 1;
        task.updated_at = Utc::now();
        self.log(&task, "started", "Task started");
        self.tasks.insert(task.id.clone(), task.clone());
        Some(task)
    }

    pub fn complete(&mut self, task_id: &str, detail: impl Into<String>) -> Option<WorkflowTask> {
        self.transition(task_id, TaskState::Completed, "completed", detail)
    }

    pub fn fail(&mut self, task_id: &str, detail: impl Into<String>) -> Option<WorkflowTask> {
        self.transition(task_id, TaskState::Failed, "failed", detail)
    }

    fn transition(
        &mut self,
        task_id: &str,
        state: TaskState,
        event: &str,
        detail: impl Into<String>,
    ) -> Option<WorkflowTask> {
        let mut task = self.tasks.get(task_id)?.clone();
        task.state = state;
        task.updated_at = Utc::now();
        self.log(&task, event, detail);
        self.tasks.insert(task.id.clone(), task.clone());
        Some(task)
    }

    fn log(&mut self, task: &WorkflowTask, event: &str, detail: impl Into<String>) {
        self.logs.push(WorkflowLog {
            id: Uuid::new_v4().to_string(),
            task_id: task.id.clone(),
            agent: task.agent.clone(),
            event: event.to_string(),
            detail: detail.into(),
            created_at: Utc::now(),
        });
    }
}

pub fn default_observer_pipeline() -> WorkflowDefinition {
    WorkflowDefinition {
        id: "observer-summary-memory-project-pet".to_string(),
        name: "Observer to memory to pet notification".to_string(),
        trigger: "activity-observed".to_string(),
        steps: vec![
            WorkflowStep {
                agent: "SummaryAgent".to_string(),
                action: "summarize-activity".to_string(),
                priority: 74,
                payload_template: serde_json::json!({ "mode": "rolling" }),
            },
            WorkflowStep {
                agent: "MemoryAgent".to_string(),
                action: "semantic-index".to_string(),
                priority: 68,
                payload_template: serde_json::json!({ "index": "memory" }),
            },
            WorkflowStep {
                agent: "ProjectAgent".to_string(),
                action: "update-project-graph".to_string(),
                priority: 62,
                payload_template: serde_json::json!({ "graph": "project" }),
            },
            WorkflowStep {
                agent: "PetAgent".to_string(),
                action: "notify-user".to_string(),
                priority: 45,
                payload_template: serde_json::json!({ "notification": "contextual" }),
            },
        ],
    }
}

fn merge_payload(base: &serde_json::Value, overlay: &serde_json::Value) -> serde_json::Value {
    match (base, overlay) {
        (serde_json::Value::Object(a), serde_json::Value::Object(b)) => {
            let mut merged = a.clone();
            for (key, value) in b {
                merged.insert(key.clone(), value.clone());
            }
            serde_json::Value::Object(merged)
        }
        (_, serde_json::Value::Null) => base.clone(),
        (_, other) => other.clone(),
    }
}
