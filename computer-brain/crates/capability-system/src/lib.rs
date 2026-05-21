use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum RiskLevel {
    ReadOnly,
    LocalMutation,
    Network,
    Destructive,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapabilityDescriptor {
    pub id: String,
    pub label: String,
    pub description: String,
    pub risk: RiskLevel,
    pub approval_required: bool,
}

#[derive(Clone, Default)]
pub struct CapabilityRegistry {
    capabilities: Arc<RwLock<BTreeMap<String, CapabilityDescriptor>>>,
}

impl CapabilityRegistry {
    pub fn with_builtins() -> Self {
        let registry = Self::default();
        for capability in builtin_capabilities() {
            registry.register(capability);
        }
        registry
    }

    pub fn register(&self, capability: CapabilityDescriptor) {
        self.capabilities.write().insert(capability.id.clone(), capability);
    }

    pub fn get(&self, id: &str) -> Option<CapabilityDescriptor> {
        self.capabilities.read().get(id).cloned()
    }

    pub fn list(&self) -> Vec<CapabilityDescriptor> {
        self.capabilities.read().values().cloned().collect()
    }

    pub fn requires_approval(&self, id: &str) -> bool {
        self.get(id).map(|capability| capability.approval_required).unwrap_or(true)
    }
}

pub fn builtin_capabilities() -> Vec<CapabilityDescriptor> {
    vec![
        capability("filesystem.read", "Read Filesystem", "Inspect approved folders and files.", RiskLevel::ReadOnly, false),
        capability("filesystem.write", "Write Filesystem", "Create or edit files in approved project folders.", RiskLevel::LocalMutation, true),
        capability("context.load", "Load Context", "Load active project, goal, body map, and relevant memory context.", RiskLevel::ReadOnly, false),
        capability("terminal.execute", "Execute Terminal", "Run allowlisted terminal commands through CommandAgent.", RiskLevel::LocalMutation, false),
        capability("git.inspect", "Inspect Git", "Read git status, logs, branches, and diffs.", RiskLevel::ReadOnly, false),
        capability("browser.automate", "Automate Browser", "Operate an approved browser session for testing and inspection.", RiskLevel::LocalMutation, true),
        capability("memory.retrieve", "Retrieve Memory", "Search structured and semantic memory.", RiskLevel::ReadOnly, false),
        capability("memory.store", "Store Memory", "Persist new memories and summaries.", RiskLevel::LocalMutation, false),
        capability("summarize.code", "Summarize Code", "Create local summaries from project artifacts.", RiskLevel::ReadOnly, false),
        capability("graph.query", "Query Knowledge Graph", "Read project and concept relationships.", RiskLevel::ReadOnly, false),
        capability("project.inspect", "Inspect Project", "Map project structure and build systems.", RiskLevel::ReadOnly, false),
        capability("api.call", "Call API", "Call configured local or approved external APIs.", RiskLevel::Network, true),
        capability("script.run", "Run Local Script", "Execute approved local scripts through CommandAgent.", RiskLevel::LocalMutation, true),
        capability("schedule.task", "Schedule Task", "Create recurring safe workflow checks.", RiskLevel::LocalMutation, false),
        capability("network.cloud-model", "Cloud Model Call", "Use external AI providers.", RiskLevel::Network, true),
        capability("package.install", "Install Packages", "Install or upgrade dependencies.", RiskLevel::Network, true),
        capability("process.kill", "Stop Process", "Terminate a running process.", RiskLevel::Destructive, true),
    ]
}

fn capability(id: &str, label: &str, description: &str, risk: RiskLevel, approval_required: bool) -> CapabilityDescriptor {
    CapabilityDescriptor {
        id: id.to_string(),
        label: label.to_string(),
        description: description.to_string(),
        risk,
        approval_required,
    }
}
