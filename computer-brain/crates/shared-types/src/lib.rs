use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub type BrainId = String;
pub type AgentName = String;

pub fn new_id(prefix: &str) -> BrainId {
    format!("{prefix}-{}", Uuid::new_v4())
}

pub fn now() -> DateTime<Utc> {
    Utc::now()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AgentState {
    Init,
    Idle,
    Thinking,
    Acting,
    WaitingPermission,
    Error,
    Stopped,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum AgentCapability {
    ObserveFiles,
    Summarize,
    ReadMemory,
    WriteMemory,
    SemanticSearch,
    UpdateProjectGraph,
    RouteTools,
    ExecuteSafeCommands,
    ScheduleWorkflows,
    InferContext,
    PlanTasks,
    BuildExecutionGraph,
    ManageCapabilities,
    ObserveRuntime,
    LearnSkills,
    Perceive,
    Understand,
    Reflect,
    Learn,
    Adapt,
    UpdatePet,
    EnforceSafety,
    BrowseWeb,
    SearchWeb,
    Research,
    VerifySources,
    AnalyzeGitHub,
    StoreWebKnowledge,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDescriptor {
    pub name: AgentName,
    pub state: AgentState,
    pub capabilities: Vec<AgentCapability>,
    pub last_seen_at: DateTime<Utc>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MemoryKind {
    RawEvent,
    Session,
    Daily,
    Project,
    System,
    Skill,
    Temporal,
    LongTerm,
    Tool,
    Summary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryRecord {
    pub id: BrainId,
    pub session_id: Option<BrainId>,
    pub project_id: Option<BrainId>,
    pub kind: MemoryKind,
    pub title: Option<String>,
    pub content: String,
    pub importance: f32,
    pub tags: Vec<String>,
    pub source_path: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectRecord {
    pub id: BrainId,
    pub name: String,
    pub root_path: String,
    pub language_stats: Value,
    pub last_seen_at: DateTime<Utc>,
    pub summary: Option<String>,
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GraphNodeKind {
    Project,
    File,
    System,
    Concept,
    Agent,
    Summary,
    Memory,
    Bug,
    Fix,
    Commit,
    Discussion,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphNodeRecord {
    pub id: BrainId,
    pub kind: GraphNodeKind,
    pub label: String,
    pub project_id: Option<BrainId>,
    pub metadata: Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GraphEdgeKind {
    Contains,
    DependsOn,
    Mentions,
    Implements,
    FixedBy,
    EvolvesInto,
    RelatedTo,
    ProducedBy,
    TriggeredBy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphEdgeRecord {
    pub id: BrainId,
    pub from_id: BrainId,
    pub to_id: BrainId,
    pub kind: GraphEdgeKind,
    pub weight: f32,
    pub metadata: Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolProvider {
    Ollama,
    OpenAI,
    Claude,
    Gemini,
    Shell,
    Python,
    GitHub,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolRequest {
    pub id: BrainId,
    pub provider: ToolProvider,
    pub tool: String,
    pub input: Value,
    pub local_only: bool,
    pub requires_confirmation: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub request_id: BrainId,
    pub provider: ToolProvider,
    pub ok: bool,
    pub output: Value,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WebRequestKind {
    Search { query: String, engine: Option<String> },
    Fetch { url: String },
    Research { query: String, depth: Option<u8> },
    AnalyzeGitHub { repo: String },
}

impl WebRequestKind {
    pub fn query(&self) -> Option<String> {
        match self {
            WebRequestKind::Search { query, .. } => Some(query.clone()),
            WebRequestKind::Research { query, .. } => Some(query.clone()),
            _ => None,
        }
    }
    pub fn url(&self) -> Option<String> {
        match self { WebRequestKind::Fetch { url } => Some(url.clone()), _ => None }
    }
    pub fn repo(&self) -> Option<String> {
        match self { WebRequestKind::AnalyzeGitHub { repo } => Some(repo.clone()), _ => None }
    }
    pub fn research_depth(&self) -> Option<u8> {
        match self { WebRequestKind::Research { depth, .. } => *depth, _ => None }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebRequest {
    pub id: BrainId,
    pub kind: WebRequestKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WebResponseKind {
    SearchResults { results: Vec<WebSearchResult> },
    PageContent { url: String, title: String, content: String, word_count: usize },
    ResearchSummary { summary: String, sources: Vec<String> },
    GitHubInfo { repo: String, stars: Option<u64>, language: Option<String>, description: Option<String> },
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub domain: String,
    pub position: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebResponse {
    pub request_id: BrainId,
    pub ok: bool,
    pub kind: WebResponseKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskState {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTask {
    pub id: BrainId,
    pub workflow_id: Option<BrainId>,
    pub agent: AgentName,
    pub action: String,
    pub state: TaskState,
    pub priority: u8,
    pub payload: Value,
    pub result: Option<Value>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum OperatingMode {
    Passive,
    Assisted,
    Active,
    Autonomous,
}

impl Default for OperatingMode {
    fn default() -> Self {
        Self::Passive
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum GoalStatus {
    Proposed,
    Active,
    WaitingApproval,
    Completed,
    Failed,
    Paused,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum GoalRisk {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoalRecord {
    pub id: BrainId,
    pub parent_id: Option<BrainId>,
    pub title: String,
    pub priority: u8,
    pub status: GoalStatus,
    pub owner_agent: AgentName,
    pub required_tools: Vec<String>,
    pub risk_level: GoalRisk,
    pub memory_links: Vec<BrainId>,
    pub deadline: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsciousnessCycleRecord {
    pub id: BrainId,
    pub mode: OperatingMode,
    pub world_state: Value,
    pub recalled_memory_ids: Vec<BrainId>,
    pub detected_goal_ids: Vec<BrainId>,
    pub available_tools: Vec<String>,
    pub available_skills: Vec<String>,
    pub risk_score: f32,
    pub plan_ids: Vec<BrainId>,
    pub actions_taken: Vec<String>,
    pub reflection_ids: Vec<BrainId>,
    pub summary: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PetMood {
    Idle,
    Focused,
    Thinking,
    Analyzing,
    Curious,
    Assisting,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PetState {
    pub mood: PetMood,
    pub focus: f32,
    pub arousal: f32,
    pub current_project: Option<String>,
    pub recent_brief: String,
    pub notification: Option<String>,
    pub updated_at: DateTime<Utc>,
}

impl Default for PetState {
    fn default() -> Self {
        Self {
            mood: PetMood::Idle,
            focus: 0.25,
            arousal: 0.2,
            current_project: None,
            recent_brief: "Watching the local system".to_string(),
            notification: None,
            updated_at: now(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SafetyDecisionKind {
    Allow,
    Confirm,
    Deny,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SafetyDecision {
    pub decision: SafetyDecisionKind,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum BrainEvent {
    SystemStarted { at: DateTime<Utc> },
    AgentStatus { agent: AgentName, state: AgentState, detail: Option<String>, at: DateTime<Utc> },
    FileChanged { path: String, change: String, project_root: Option<String>, at: DateTime<Utc> },
    SystemObserved { cpu: f32, memory: f32, active_process: Option<String>, at: DateTime<Utc> },
    GitChanged { project_root: String, branch: Option<String>, changed_files: usize, at: DateTime<Utc> },
    UserMessage { content: String, at: DateTime<Utc> },
    BodyMapUpdated { summary: String, at: DateTime<Utc> },
    CognitiveStateChanged { state: String, reason: String, at: DateTime<Utc> },
    PerceptionCreated { observation_id: BrainId, source: String, summary: String, at: DateTime<Utc> },
    UnderstandingCreated { understanding_id: BrainId, intent: String, confidence: f32, at: DateTime<Utc> },
    ContextUpdated { summary: String, project_id: Option<BrainId>, at: DateTime<Utc> },
    PlanCreated { plan_id: BrainId, intent: String, step_count: usize, at: DateTime<Utc> },
    PlanAssessed { assessment_id: BrainId, plan_id: BrainId, risk_score: f32, quality_score: f32, at: DateTime<Utc> },
    ExecutionGraphCreated { graph_id: BrainId, plan_id: BrainId, node_count: usize, at: DateTime<Utc> },
    ExecutionOutcomeRecorded { outcome_id: BrainId, ok: bool, at: DateTime<Utc> },
    ReflectionCreated { reflection_id: BrainId, summary: String, at: DateTime<Utc> },
    LessonLearned { lesson_id: BrainId, summary: String, at: DateTime<Utc> },
    AdaptationApplied { adaptation_id: BrainId, behavior: String, at: DateTime<Utc> },
    CapabilityRegistered { capability: String, at: DateTime<Utc> },
    ReasoningTraced { trace_id: BrainId, summary: String, at: DateTime<Utc> },
    SummaryCreated { memory_id: BrainId, summary: String, project_id: Option<BrainId>, at: DateTime<Utc> },
    MemoryStored { memory_id: BrainId, at: DateTime<Utc> },
    SemanticIndexed { memory_id: BrainId, cluster_id: Option<BrainId>, at: DateTime<Utc> },
    GraphUpdated { node_count: usize, edge_count: usize, at: DateTime<Utc> },
    WorkflowQueued { task_id: BrainId, agent: AgentName, action: String, at: DateTime<Utc> },
    ToolRequested { request: ToolRequest, at: DateTime<Utc> },
    ToolCompleted { result: ToolResult, at: DateTime<Utc> },
    CommandRequested { command: String, cwd: Option<String>, at: DateTime<Utc> },
    ActionObserved { actor: String, action: String, capability: String, ok: bool, at: DateTime<Utc> },
    SkillLearned { skill_id: BrainId, name: String, confidence: f32, at: DateTime<Utc> },
    SkillRunRecorded { skill_id: BrainId, ok: bool, at: DateTime<Utc> },
    OperatingModeChanged { mode: OperatingMode, at: DateTime<Utc> },
    GoalStackUpdated { goal_id: BrainId, title: String, status: GoalStatus, at: DateTime<Utc> },
    ConsciousnessCycleCompleted { cycle_id: BrainId, mode: OperatingMode, summary: String, at: DateTime<Utc> },
    Heartbeat { summary: String, at: DateTime<Utc> },
    SafetyAudited { actor: String, action: String, decision: SafetyDecision, at: DateTime<Utc> },
    PetUpdated { state: PetState, at: DateTime<Utc> },
    EvolutionGenerationCompleted {
        generation_id: BrainId,
        genome_kind: String,
        index: u32,
        champion_id: BrainId,
        champion_fitness: f32,
        summary: String,
        at: DateTime<Utc>,
    },
    EvolutionPromoted {
        candidate_id: BrainId,
        genome_kind: String,
        margin: f32,
        reason: String,
        at: DateTime<Utc>,
    },
    WebSearchPerformed {
        query: String,
        result_count: usize,
        sources: Vec<String>,
        at: DateTime<Utc>,
    },
    WebPageFetched {
        url: String,
        title: String,
        word_count: usize,
        sanitized: bool,
        at: DateTime<Utc>,
    },
    WebResearchCompleted {
        topic: String,
        source_count: usize,
        credibility_avg: f32,
        summary: String,
        knowledge_stored: bool,
        at: DateTime<Utc>,
    },
    WebSourceVerified {
        url: String,
        credible: bool,
        confidence: f32,
        reason: String,
        at: DateTime<Utc>,
    },
    WebContentSanitized {
        url: String,
        threats_removed: Vec<String>,
        at: DateTime<Utc>,
    },
    GitHubAnalyzed {
        repo: String,
        stars: Option<u64>,
        language: Option<String>,
        summary: String,
        at: DateTime<Utc>,
    },
    WebSearchRequested { request: WebRequest, at: DateTime<Utc> },
    WebFetchRequested { request: WebRequest, at: DateTime<Utc> },
    WebResearchRequested { request: WebRequest, at: DateTime<Utc> },
    GitHubAnalysisRequested { request: WebRequest, at: DateTime<Utc> },
    Error { source: String, message: String, at: DateTime<Utc> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrainEventEnvelope {
    pub id: BrainId,
    pub event: BrainEvent,
    pub occurred_at: DateTime<Utc>,
    pub source_agent: Option<AgentName>,
    pub correlation_id: Option<BrainId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrainConfig {
    pub data_dir: String,
    pub sqlite_path: String,
    pub local_first: bool,
    pub ollama_base_url: String,
    pub ollama_chat_model: String,
    pub embedding_dimensions: usize,
}

impl Default for BrainConfig {
    fn default() -> Self {
        Self {
            data_dir: "data".to_string(),
            sqlite_path: "data/computer-brain.sqlite".to_string(),
            local_first: true,
            ollama_base_url: "http://127.0.0.1:11434".to_string(),
            ollama_chat_model: "llama3.1".to_string(),
            embedding_dimensions: 384,
        }
    }
}
