//! Web cognition agents — collaborative web research within the cognitive loop.

mod github_agent;
mod research_agent;
mod search_agent;
mod verification_agent;
mod web_memory_agent;

pub use github_agent::GitHubAnalysisAgent;
pub use research_agent::ResearchAgent;
pub use search_agent::SearchAgent;
pub use verification_agent::VerificationAgent;
pub use web_memory_agent::WebMemoryAgent;