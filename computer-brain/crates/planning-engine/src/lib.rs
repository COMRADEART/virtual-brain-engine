use capability_system::{CapabilityDescriptor, RiskLevel};
use chrono::{DateTime, Utc};
use planner_engine::Plan;
use serde::{Deserialize, Serialize};
use shared_types::{new_id, BrainId};
use understanding_engine::SituationalUnderstanding;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CognitivePlanAssessment {
    pub id: BrainId,
    pub plan_id: BrainId,
    pub risk_score: f32,
    pub priority: u8,
    pub permission_required: bool,
    pub chosen_tools: Vec<String>,
    pub agent_assignments: Vec<String>,
    pub quality_score: f32,
    pub rationale: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Default)]
pub struct PlanningEngine;

impl PlanningEngine {
    pub fn assess(
        &self,
        plan: &Plan,
        understanding: &SituationalUnderstanding,
        capabilities: &[CapabilityDescriptor],
    ) -> CognitivePlanAssessment {
        let mut risk_score = 0.0_f32;
        let mut permission_required = false;
        let mut chosen_tools = Vec::new();
        for step in &plan.steps {
            chosen_tools.push(step.capability.clone());
            if let Some(capability) = capabilities.iter().find(|cap| cap.id == step.capability) {
                risk_score += risk_weight(&capability.risk);
                permission_required |= capability.approval_required;
            } else {
                risk_score += 0.25;
                permission_required = true;
            }
            permission_required |= step.requires_approval;
        }
        chosen_tools.sort();
        chosen_tools.dedup();
        let agent_assignments = plan.steps.iter().map(|step| step.agent.clone()).collect::<Vec<_>>();
        let risk_score = (risk_score / plan.steps.len().max(1) as f32).clamp(0.0, 1.0);
        let quality_score = (understanding.confidence * 0.55
            + (1.0 - risk_score) * 0.25
            + if plan.steps.is_empty() { 0.0 } else { 0.2 })
            .clamp(0.0, 1.0);
        CognitivePlanAssessment {
            id: new_id("plan-quality"),
            plan_id: plan.id.clone(),
            risk_score,
            priority: if risk_score > 0.65 { 90 } else if permission_required { 70 } else { 50 },
            permission_required,
            chosen_tools,
            agent_assignments,
            quality_score,
            rationale: format!(
                "Plan assessed with risk {:.2}, quality {:.2}, confidence {:.2}",
                risk_score, quality_score, understanding.confidence
            ),
            created_at: Utc::now(),
        }
    }
}

fn risk_weight(risk: &RiskLevel) -> f32 {
    match risk {
        RiskLevel::ReadOnly => 0.05,
        RiskLevel::LocalMutation => 0.35,
        RiskLevel::Network => 0.65,
        RiskLevel::Destructive => 1.0,
    }
}
