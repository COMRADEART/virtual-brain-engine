use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use shared_types::{SafetyDecision, SafetyDecisionKind};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SafetyPolicy {
    pub allow_cloud: bool,
    pub allow_shell: bool,
    pub command_allowlist: BTreeSet<String>,
    pub dangerous_terms: BTreeSet<String>,
}

impl Default for SafetyPolicy {
    fn default() -> Self {
        Self {
            allow_cloud: false,
            allow_shell: true,
            command_allowlist: ["git", "cargo", "npm", "node", "python", "ollama"]
                .into_iter()
                .map(ToString::to_string)
                .collect(),
            dangerous_terms: ["rm", "del", "format", "shutdown", "reg", "reset", "checkout", "clean"]
                .into_iter()
                .map(ToString::to_string)
                .collect(),
        }
    }
}

#[derive(Clone)]
pub struct SafetyLayer {
    policy: SafetyPolicy,
}

impl SafetyLayer {
    pub fn new(policy: SafetyPolicy) -> Self {
        Self { policy }
    }

    pub fn policy(&self) -> &SafetyPolicy {
        &self.policy
    }

    pub fn check_cloud(&self, provider: &str, local_only: bool) -> SafetyDecision {
        if local_only {
            return SafetyDecision {
                decision: SafetyDecisionKind::Deny,
                reason: format!("{provider} blocked because request is marked local-only"),
            };
        }
        if self.policy.allow_cloud {
            SafetyDecision {
                decision: SafetyDecisionKind::Confirm,
                reason: format!("{provider} cloud call requires explicit confirmation"),
            }
        } else {
            SafetyDecision {
                decision: SafetyDecisionKind::Deny,
                reason: "cloud providers are disabled by local-first policy".to_string(),
            }
        }
    }

    pub fn check_command(&self, command: &str) -> SafetyDecision {
        let program = command.split_whitespace().next().unwrap_or_default().to_ascii_lowercase();
        if !self.policy.allow_shell {
            return deny("shell execution is disabled");
        }
        if !self.policy.command_allowlist.contains(&program) {
            return deny(format!("{program} is not on the command allowlist"));
        }
        let lowered = command.to_ascii_lowercase();
        if self.policy.dangerous_terms.iter().any(|term| lowered.contains(term)) {
            return SafetyDecision {
                decision: SafetyDecisionKind::Confirm,
                reason: "command contains a dangerous operation and needs confirmation".to_string(),
            };
        }
        SafetyDecision {
            decision: SafetyDecisionKind::Allow,
            reason: "command allowed by local safety policy".to_string(),
        }
    }

    pub fn audit_metadata(&self, value: Value) -> Result<Value> {
        Ok(value)
    }
}

impl Default for SafetyLayer {
    fn default() -> Self {
        Self::new(SafetyPolicy::default())
    }
}

fn deny(reason: impl Into<String>) -> SafetyDecision {
    SafetyDecision {
        decision: SafetyDecisionKind::Deny,
        reason: reason.into(),
    }
}
