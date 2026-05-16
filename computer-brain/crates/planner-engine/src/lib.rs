use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use shared_types::{new_id, BrainId, MemoryRecord};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum IntentKind {
    InspectProject,
    FixProject,
    RunTests,
    BuildProject,
    SearchMemory,
    Explain,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanStep {
    pub id: BrainId,
    pub label: String,
    pub capability: String,
    pub agent: String,
    pub requires_approval: bool,
    pub depends_on: Vec<BrainId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plan {
    pub id: BrainId,
    pub intent: IntentKind,
    pub request: String,
    pub context_summary: String,
    pub memory_ids: Vec<BrainId>,
    pub steps: Vec<PlanStep>,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Default)]
pub struct PlannerEngine;

impl PlannerEngine {
    pub fn plan(&self, request: impl Into<String>, context_summary: impl Into<String>, memories: &[MemoryRecord]) -> Plan {
        let request = request.into();
        let context_summary = context_summary.into();
        let intent = parse_intent(&request);
        let mut steps = Vec::new();

        let load_context = push_step(&mut steps, "Load project context", "context.load", "ContextAgent", false, Vec::new());
        let recall = push_step(
            &mut steps,
            "Retrieve related memories",
            "memory.retrieve",
            "SemanticMemoryAgent",
            false,
            vec![load_context.clone()],
        );

        match intent {
            IntentKind::FixProject => {
                let inspect = push_step(&mut steps, "Inspect project structure", "filesystem.read", "ObserverAgent", false, vec![recall.clone()]);
                let check = push_step(&mut steps, "Run safe build diagnostics", "terminal.execute", "CommandAgent", false, vec![inspect.clone()]);
                let analyze = push_step(&mut steps, "Analyze diagnostics", "summarize.code", "SummaryAgent", false, vec![check.clone()]);
                push_step(&mut steps, "Store fix plan memory", "memory.store", "MemoryAgent", false, vec![analyze]);
            }
            IntentKind::RunTests => {
                let command = push_step(&mut steps, "Run approved test command", "terminal.execute", "CommandAgent", false, vec![recall.clone()]);
                push_step(&mut steps, "Summarize test output", "summarize.code", "SummaryAgent", false, vec![command]);
            }
            IntentKind::BuildProject => {
                let command = push_step(&mut steps, "Run approved build command", "terminal.execute", "CommandAgent", false, vec![recall.clone()]);
                push_step(&mut steps, "Summarize build output", "summarize.code", "SummaryAgent", false, vec![command]);
            }
            IntentKind::SearchMemory => {
                push_step(&mut steps, "Rank semantic memory matches", "memory.retrieve", "MemoryAgent", false, vec![recall.clone()]);
            }
            IntentKind::InspectProject => {
                push_step(&mut steps, "Map project files and build systems", "project.inspect", "ProjectAgent", false, vec![recall.clone()]);
            }
            IntentKind::Explain | IntentKind::Unknown => {
                push_step(&mut steps, "Create grounded response summary", "summarize.code", "SummaryAgent", false, vec![recall.clone()]);
            }
        }

        Plan {
            id: new_id("plan"),
            intent,
            request,
            context_summary,
            memory_ids: memories.iter().take(12).map(|memory| memory.id.clone()).collect(),
            steps,
            created_at: Utc::now(),
        }
    }
}

fn parse_intent(request: &str) -> IntentKind {
    let request = request.to_ascii_lowercase();
    if request.contains("fix") || request.contains("repair") {
        IntentKind::FixProject
    } else if request.contains("test") {
        IntentKind::RunTests
    } else if request.contains("build") || request.contains("compile") {
        IntentKind::BuildProject
    } else if request.contains("find") || request.contains("search") || request.contains("recall") {
        IntentKind::SearchMemory
    } else if request.contains("inspect") || request.contains("scan") || request.contains("map") {
        IntentKind::InspectProject
    } else if request.contains("explain") || request.contains("why") {
        IntentKind::Explain
    } else {
        IntentKind::Unknown
    }
}

fn push_step(
    steps: &mut Vec<PlanStep>,
    label: &str,
    capability: &str,
    agent: &str,
    requires_approval: bool,
    depends_on: Vec<BrainId>,
) -> BrainId {
    let id = new_id("step");
    steps.push(PlanStep {
        id: id.clone(),
        label: label.to_string(),
        capability: capability.to_string(),
        agent: agent.to_string(),
        requires_approval,
        depends_on,
    });
    id
}
