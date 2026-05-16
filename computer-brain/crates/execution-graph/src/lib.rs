use chrono::{DateTime, Utc};
use planner_engine::Plan;
use serde::{Deserialize, Serialize};
use shared_types::{new_id, BrainId};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ExecutionNodeState {
    Pending,
    Ready,
    Running,
    WaitingApproval,
    Completed,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionNode {
    pub id: BrainId,
    pub plan_step_id: BrainId,
    pub label: String,
    pub capability: String,
    pub agent: String,
    pub state: ExecutionNodeState,
    pub attempts: u8,
    pub max_attempts: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionEdge {
    pub from_id: BrainId,
    pub to_id: BrainId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionGraph {
    pub id: BrainId,
    pub plan_id: BrainId,
    pub nodes: Vec<ExecutionNode>,
    pub edges: Vec<ExecutionEdge>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Default)]
pub struct ExecutionGraphRuntime;

impl ExecutionGraphRuntime {
    pub fn from_plan(&self, plan: &Plan) -> ExecutionGraph {
        let mut step_to_node = BTreeMap::new();
        let mut nodes = Vec::new();
        for step in &plan.steps {
            let node_id = new_id("node");
            step_to_node.insert(step.id.clone(), node_id.clone());
            nodes.push(ExecutionNode {
                id: node_id,
                plan_step_id: step.id.clone(),
                label: step.label.clone(),
                capability: step.capability.clone(),
                agent: step.agent.clone(),
                state: if step.depends_on.is_empty() {
                    ExecutionNodeState::Ready
                } else if step.requires_approval {
                    ExecutionNodeState::WaitingApproval
                } else {
                    ExecutionNodeState::Pending
                },
                attempts: 0,
                max_attempts: 2,
            });
        }
        let mut edges = Vec::new();
        for step in &plan.steps {
            let Some(to_id) = step_to_node.get(&step.id) else {
                continue;
            };
            for dep in &step.depends_on {
                if let Some(from_id) = step_to_node.get(dep) {
                    edges.push(ExecutionEdge {
                        from_id: from_id.clone(),
                        to_id: to_id.clone(),
                    });
                }
            }
        }
        let now = Utc::now();
        ExecutionGraph {
            id: new_id("exec"),
            plan_id: plan.id.clone(),
            nodes,
            edges,
            created_at: now,
            updated_at: now,
        }
    }

    pub fn ready_nodes(&self, graph: &ExecutionGraph) -> Vec<ExecutionNode> {
        graph
            .nodes
            .iter()
            .filter(|node| matches!(node.state, ExecutionNodeState::Ready))
            .cloned()
            .collect()
    }

    pub fn replay_summary(&self, graph: &ExecutionGraph) -> String {
        let complete = graph.nodes.iter().filter(|n| matches!(n.state, ExecutionNodeState::Completed)).count();
        let failed = graph.nodes.iter().filter(|n| matches!(n.state, ExecutionNodeState::Failed)).count();
        format!(
            "Execution graph {} for plan {} has {} nodes, {} edges, {} complete, {} failed.",
            graph.id,
            graph.plan_id,
            graph.nodes.len(),
            graph.edges.len(),
            complete,
            failed
        )
    }
}
