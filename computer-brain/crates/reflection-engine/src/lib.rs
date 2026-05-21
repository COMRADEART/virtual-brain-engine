use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use shared_types::{new_id, BrainId, ToolResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionOutcome {
    pub id: BrainId,
    pub action: String,
    pub ok: bool,
    pub duration_ms: Option<u64>,
    pub output_summary: String,
    pub error_summary: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReflectionRecord {
    pub id: BrainId,
    pub outcome_id: BrainId,
    pub attempted: String,
    pub summary: String,
    pub succeeded: Vec<String>,
    pub failed: Vec<String>,
    pub inefficiencies: Vec<String>,
    pub patterns: Vec<String>,
    pub should_remember: Vec<String>,
    pub skill_improved: Option<String>,
    pub avoid_next_time: Vec<String>,
    pub confidence_delta: f32,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowEfficiency {
    pub id: BrainId,
    pub workflow: String,
    pub score: f32,
    pub bottlenecks: Vec<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanningQuality {
    pub id: BrainId,
    pub plan_id: Option<BrainId>,
    pub score: f32,
    pub issues: Vec<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Default)]
pub struct ReflectionEngine;

impl ReflectionEngine {
    pub fn reflect_tool_result(&self, tool: &str, result: &ToolResult) -> (ExecutionOutcome, ReflectionRecord, WorkflowEfficiency, PlanningQuality) {
        let output = &result.output;
        let duration_ms = output.get("duration_ms").and_then(Value::as_u64);
        let stdout = output.get("stdout").and_then(Value::as_str).unwrap_or_default();
        let stderr = output.get("stderr").and_then(Value::as_str).unwrap_or_default();
        let output_summary = if result.ok {
            summarize(stdout).unwrap_or_else(|| "Tool completed without stdout.".to_string())
        } else {
            summarize(stderr)
                .or_else(|| result.error.clone())
                .unwrap_or_else(|| "Tool failed without diagnostic output.".to_string())
        };
        let outcome = ExecutionOutcome {
            id: new_id("outcome"),
            action: tool.to_string(),
            ok: result.ok,
            duration_ms,
            output_summary: output_summary.clone(),
            error_summary: if result.ok { None } else { Some(output_summary.clone()) },
            created_at: Utc::now(),
        };
        let mut succeeded = Vec::new();
        let mut failed = Vec::new();
        let mut inefficiencies = Vec::new();
        let mut patterns = Vec::new();
        if result.ok {
            succeeded.push(format!("{tool} completed successfully"));
        } else {
            failed.push(output_summary.clone());
            patterns.push("failure-needs-memory".to_string());
        }
        if duration_ms.unwrap_or(0) > 30_000 {
            inefficiencies.push("slow-tool-execution".to_string());
        }
        if stdout.contains("test") || stderr.contains("test") {
            patterns.push("test-workflow".to_string());
        }
        let reflection = ReflectionRecord {
            id: new_id("reflection"),
            outcome_id: outcome.id.clone(),
            attempted: format!("Run {tool} and capture its result."),
            summary: if result.ok {
                format!("Execution succeeded for {tool}.")
            } else {
                format!("Execution failed for {tool}: {output_summary}")
            },
            succeeded,
            failed: failed.clone(),
            inefficiencies: inefficiencies.clone(),
            patterns: patterns.clone(),
            should_remember: if result.ok {
                vec![format!("{tool} succeeded with current context.")]
            } else {
                vec![format!("{tool} failed with diagnostic: {output_summary}")]
            },
            skill_improved: if result.ok && (stdout.contains("cargo") || stdout.contains("test")) {
                Some("rust-validation-workflow".to_string())
            } else if !result.ok && (stderr.contains("cargo") || stderr.contains("test")) {
                Some("rust-failure-recovery-workflow".to_string())
            } else {
                None
            },
            avoid_next_time: if failed.is_empty() {
                Vec::new()
            } else {
                vec!["Do not retry the same failing action without inspecting diagnostics and relevant memory first.".to_string()]
            },
            confidence_delta: if result.ok { 0.03 } else { -0.07 },
            created_at: Utc::now(),
        };
        let efficiency = WorkflowEfficiency {
            id: new_id("efficiency"),
            workflow: tool.to_string(),
            score: if result.ok && inefficiencies.is_empty() { 0.82 } else if result.ok { 0.62 } else { 0.35 },
            bottlenecks: inefficiencies,
            created_at: Utc::now(),
        };
        let planning_quality = PlanningQuality {
            id: new_id("planning-quality"),
            plan_id: None,
            score: if result.ok { 0.75 } else { 0.45 },
            issues: if result.ok { Vec::new() } else { vec!["execution-failed".to_string()] },
            created_at: Utc::now(),
        };
        (outcome, reflection, efficiency, planning_quality)
    }

    pub fn reflect_workflow_checkpoint(
        &self,
        workflow: &str,
        attempted: &str,
        ok: bool,
        note: &str,
    ) -> (ExecutionOutcome, ReflectionRecord, WorkflowEfficiency, PlanningQuality) {
        let outcome = ExecutionOutcome {
            id: new_id("outcome"),
            action: workflow.to_string(),
            ok,
            duration_ms: None,
            output_summary: note.to_string(),
            error_summary: if ok { None } else { Some(note.to_string()) },
            created_at: Utc::now(),
        };
        let reflection = ReflectionRecord {
            id: new_id("reflection"),
            outcome_id: outcome.id.clone(),
            attempted: attempted.to_string(),
            summary: if ok {
                format!("Workflow checkpoint succeeded for {workflow}: {note}")
            } else {
                format!("Workflow checkpoint failed for {workflow}: {note}")
            },
            succeeded: if ok { vec![note.to_string()] } else { Vec::new() },
            failed: if ok { Vec::new() } else { vec![note.to_string()] },
            inefficiencies: Vec::new(),
            patterns: vec!["workflow-checkpoint".to_string()],
            should_remember: vec![format!("{workflow}: {note}")],
            skill_improved: if ok { Some(format!("{workflow}-workflow")) } else { None },
            avoid_next_time: if ok {
                Vec::new()
            } else {
                vec!["Do not advance this workflow without inspecting the failed checkpoint.".to_string()]
            },
            confidence_delta: if ok { 0.02 } else { -0.05 },
            created_at: Utc::now(),
        };
        let efficiency = WorkflowEfficiency {
            id: new_id("efficiency"),
            workflow: workflow.to_string(),
            score: if ok { 0.72 } else { 0.35 },
            bottlenecks: if ok { Vec::new() } else { vec!["workflow-checkpoint-failed".to_string()] },
            created_at: Utc::now(),
        };
        let planning_quality = PlanningQuality {
            id: new_id("planning-quality"),
            plan_id: None,
            score: if ok { 0.68 } else { 0.42 },
            issues: if ok { Vec::new() } else { vec!["workflow-checkpoint-failed".to_string()] },
            created_at: Utc::now(),
        };
        (outcome, reflection, efficiency, planning_quality)
    }
}

fn summarize(value: &str) -> Option<String> {
    let line = value.lines().find(|line| !line.trim().is_empty())?.trim();
    Some(if line.len() > 180 {
        format!("{}...", line.chars().take(180).collect::<String>())
    } else {
        line.to_string()
    })
}
