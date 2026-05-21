use chrono::{DateTime, Utc};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use shared_types::{new_id, BrainId};
use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObservedAction {
    pub id: BrainId,
    pub actor: String,
    pub action: String,
    pub capability: String,
    pub project_id: Option<BrainId>,
    pub ok: bool,
    pub metadata: Value,
    pub occurred_at: DateTime<Utc>,
}

impl ObservedAction {
    pub fn new(actor: impl Into<String>, action: impl Into<String>, capability: impl Into<String>, ok: bool, metadata: Value) -> Self {
        Self {
            id: new_id("action"),
            actor: actor.into(),
            action: action.into(),
            capability: capability.into(),
            project_id: None,
            ok,
            metadata,
            occurred_at: Utc::now(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearnedSkill {
    pub id: BrainId,
    pub name: String,
    pub description: String,
    pub trigger_conditions: Vec<String>,
    pub required_tools: Vec<String>,
    pub required_permissions: Vec<String>,
    pub execution_graph: Value,
    pub failure_handling: Vec<String>,
    pub memory_refs: Vec<BrainId>,
    pub confidence: f32,
    pub usage_count: u64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillVersion {
    pub id: BrainId,
    pub skill_id: BrainId,
    pub version: u32,
    pub definition: Value,
    pub change_summary: String,
    pub confidence: f32,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillRun {
    pub id: BrainId,
    pub skill_id: BrainId,
    pub ok: bool,
    pub input: Value,
    pub output: Value,
    pub started_at: DateTime<Utc>,
    pub finished_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillFailure {
    pub id: BrainId,
    pub skill_id: BrainId,
    pub reason: String,
    pub recovery_hint: String,
    pub metadata: Value,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillImprovement {
    pub id: BrainId,
    pub skill_id: BrainId,
    pub summary: String,
    pub before_confidence: f32,
    pub after_confidence: f32,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillCandidate {
    pub skill: LearnedSkill,
    pub version: SkillVersion,
    pub supporting_actions: Vec<ObservedAction>,
}

#[derive(Clone)]
pub struct SkillLearningEngine {
    recent_actions: Arc<RwLock<VecDeque<ObservedAction>>>,
    min_repetitions: usize,
    window: usize,
}

impl Default for SkillLearningEngine {
    fn default() -> Self {
        Self {
            recent_actions: Arc::new(RwLock::new(VecDeque::with_capacity(256))),
            min_repetitions: 3,
            window: 128,
        }
    }
}

impl SkillLearningEngine {
    pub fn observe(&self, action: ObservedAction) -> Option<SkillCandidate> {
        let mut actions = self.recent_actions.write();
        if actions.len() >= self.window {
            actions.pop_front();
        }
        actions.push_back(action);
        self.detect_locked(&actions)
    }

    pub fn recent_actions(&self, limit: usize) -> Vec<ObservedAction> {
        self.recent_actions.read().iter().rev().take(limit).cloned().collect()
    }

    pub fn confidence_after_run(&self, current: f32, ok: bool) -> f32 {
        if ok {
            (current + 0.04).clamp(0.0, 0.98)
        } else {
            (current - 0.08).clamp(0.05, 0.98)
        }
    }

    fn detect_locked(&self, actions: &VecDeque<ObservedAction>) -> Option<SkillCandidate> {
        let mut groups: BTreeMap<String, Vec<ObservedAction>> = BTreeMap::new();
        for action in actions.iter().rev().take(self.window).filter(|action| action.ok) {
            let key = workflow_key(action);
            groups.entry(key).or_default().push(action.clone());
        }
        let (_, supporting_actions) = groups
            .into_iter()
            .find(|(_, actions)| actions.len() >= self.min_repetitions)?;
        let representative = supporting_actions.first()?;
        let now = Utc::now();
        let skill_id = stable_skill_id(&representative.capability, &representative.action);
        let name = skill_name(&representative.capability, &representative.action);
        let execution_graph = serde_json::json!({
            "nodes": supporting_actions.iter().rev().map(|action| serde_json::json!({
                "agent": action.actor,
                "action": action.action,
                "capability": action.capability,
            })).collect::<Vec<_>>(),
            "edges": "sequential-observed-pattern",
        });
        let skill = LearnedSkill {
            id: skill_id.clone(),
            name,
            description: format!(
                "Learned from {} repeated successful uses of {}.",
                supporting_actions.len(),
                representative.capability
            ),
            trigger_conditions: vec![
                format!("capability={}", representative.capability),
                format!("action={}", representative.action),
            ],
            required_tools: tools_for_capability(&representative.capability),
            required_permissions: permissions_for_capability(&representative.capability),
            execution_graph: execution_graph.clone(),
            failure_handling: vec![
                "pause on safety denial".to_string(),
                "store failure memory".to_string(),
                "ask user before retrying risky actions".to_string(),
            ],
            memory_refs: Vec::new(),
            confidence: (0.45 + supporting_actions.len() as f32 * 0.08).clamp(0.0, 0.9),
            usage_count: supporting_actions.len() as u64,
            created_at: now,
            updated_at: now,
        };
        let version = SkillVersion {
            id: new_id("skill-version"),
            skill_id,
            version: 1,
            definition: execution_graph,
            change_summary: "Initial abstraction from repeated action pattern".to_string(),
            confidence: skill.confidence,
            created_at: now,
        };
        Some(SkillCandidate {
            skill,
            version,
            supporting_actions,
        })
    }
}

fn workflow_key(action: &ObservedAction) -> String {
    format!("{}::{}", action.capability, normalize_action(&action.action))
}

fn normalize_action(action: &str) -> String {
    action
        .to_ascii_lowercase()
        .split_whitespace()
        .take(4)
        .collect::<Vec<_>>()
        .join(" ")
}

fn stable_skill_id(capability: &str, action: &str) -> BrainId {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in format!("{capability}:{action}").as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("skill-{hash:016x}")
}

fn skill_name(capability: &str, action: &str) -> String {
    if capability == "terminal.execute" && action.contains("cargo") {
        "Rust Project Validation Workflow".to_string()
    } else if capability == "terminal.execute" && action.contains("npm") {
        "Node Project Validation Workflow".to_string()
    } else {
        format!("{} Skill", title_case(action))
    }
}

fn title_case(value: &str) -> String {
    value
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .take(5)
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn tools_for_capability(capability: &str) -> Vec<String> {
    match capability {
        "terminal.execute" => vec!["CommandAgent".to_string(), "SafetyLayer".to_string()],
        "browser.automate" => vec!["BrowserAutomation".to_string(), "SafetyLayer".to_string()],
        "memory.retrieve" | "memory.store" => vec!["MemoryCortex".to_string()],
        _ => vec!["BrainCore".to_string()],
    }
}

fn permissions_for_capability(capability: &str) -> Vec<String> {
    match capability {
        "terminal.execute" => vec!["command-allowlist".to_string()],
        "filesystem.write" => vec!["folder-write-approval".to_string()],
        "browser.automate" => vec!["browser-session-approval".to_string()],
        "network.api-call" => vec!["network-approval".to_string()],
        _ => vec!["local-read".to_string()],
    }
}
