use anyhow::Result;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use shared_types::{new_id, AgentTask, BrainId, TaskState};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowStep {
    pub agent: String,
    pub action: String,
    pub priority: u8,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowDefinition {
    pub id: BrainId,
    pub name: String,
    pub trigger_kind: String,
    pub steps: Vec<WorkflowStep>,
}

#[derive(Clone)]
pub struct WorkflowEngine {
    definitions: Vec<WorkflowDefinition>,
}

impl Default for WorkflowEngine {
    fn default() -> Self {
        Self {
            definitions: vec![observer_pipeline()],
        }
    }
}

impl WorkflowEngine {
    pub fn register(&mut self, definition: WorkflowDefinition) {
        self.definitions.push(definition);
    }

    pub fn definitions(&self) -> &[WorkflowDefinition] {
        &self.definitions
    }

    pub fn trigger(&self, trigger_kind: &str, payload: Value) -> Result<Vec<AgentTask>> {
        let mut tasks = Vec::new();
        for definition in self.definitions.iter().filter(|d| d.trigger_kind == trigger_kind) {
            for step in &definition.steps {
                tasks.push(new_task(
                    Some(definition.id.clone()),
                    &step.agent,
                    &step.action,
                    step.priority,
                    merge(&step.payload, &payload),
                ));
            }
        }
        Ok(tasks)
    }
}

pub fn new_task(
    workflow_id: Option<BrainId>,
    agent: &str,
    action: &str,
    priority: u8,
    payload: Value,
) -> AgentTask {
    let now = Utc::now();
    AgentTask {
        id: new_id("task"),
        workflow_id,
        agent: agent.to_string(),
        action: action.to_string(),
        state: TaskState::Pending,
        priority,
        payload,
        result: None,
        created_at: now,
        updated_at: now,
    }
}

pub fn observer_pipeline() -> WorkflowDefinition {
    WorkflowDefinition {
        id: "workflow-observer-summary-memory-project-pet".to_string(),
        name: "Observer to summary to memory to project to pet".to_string(),
        trigger_kind: "file-changed".to_string(),
        steps: vec![
            WorkflowStep {
                agent: "SummaryAgent".to_string(),
                action: "summarize-change".to_string(),
                priority: 80,
                payload: serde_json::json!({}),
            },
            WorkflowStep {
                agent: "MemoryAgent".to_string(),
                action: "persist-observation".to_string(),
                priority: 75,
                payload: serde_json::json!({}),
            },
            WorkflowStep {
                agent: "SemanticMemoryAgent".to_string(),
                action: "index-memory".to_string(),
                priority: 70,
                payload: serde_json::json!({}),
            },
            WorkflowStep {
                agent: "ProjectAgent".to_string(),
                action: "refresh-project-graph".to_string(),
                priority: 60,
                payload: serde_json::json!({}),
            },
            WorkflowStep {
                agent: "PetAgent".to_string(),
                action: "notify-activity".to_string(),
                priority: 40,
                payload: serde_json::json!({}),
            },
        ],
    }
}

fn merge(base: &Value, overlay: &Value) -> Value {
    match (base, overlay) {
        (Value::Object(a), Value::Object(b)) => {
            let mut merged = a.clone();
            for (key, value) in b {
                merged.insert(key.clone(), value.clone());
            }
            Value::Object(merged)
        }
        (_, Value::Null) => base.clone(),
        (_, other) => other.clone(),
    }
}
