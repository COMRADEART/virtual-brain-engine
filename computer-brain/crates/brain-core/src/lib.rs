use agent_runtime::{Agent, AgentContext, AgentFuture, AgentRuntime};
use anyhow::{Context, Result};
use capability_system::{CapabilityDescriptor, CapabilityRegistry};
use chrono::Utc;
use cognitive_state::{CognitiveMode, CognitiveStateEngine, SystemBodyMap, SystemBodyScanner, WorldState};
use context_engine::ContextEngine;
use execution_graph::ExecutionGraphRuntime;
use knowledge_graph::KnowledgeGraph;
use memory_cortex::{memory, MemoryCortex};
use nervous_system::BrainBus;
use observability::{EventMetrics, ObservabilityHub, ReasoningTrace};
use personality_engine::{MoodInput, PersonalityEngine};
use planner_engine::PlannerEngine;
use safety_layer::SafetyLayer;
use semantic_memory::{SemanticHit, SemanticMemory};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use shared_types::{
    new_id, AgentCapability, AgentState, AgentTask, BrainConfig, BrainEvent, BrainEventEnvelope,
    GraphEdgeRecord, GraphNodeRecord, MemoryKind, MemoryRecord, PetState, ProjectRecord,
    SafetyDecisionKind, ToolProvider, ToolRequest,
};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;
use tool_cortex::{ToolCortex, ToolCortexConfig};
use workflow_engine::{new_task, WorkflowEngine};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrainDashboard {
    pub counts: Value,
    pub agents: Vec<shared_types::AgentDescriptor>,
    pub recent_memories: Vec<MemoryRecord>,
    pub recent_projects: Vec<ProjectRecord>,
    pub recent_tasks: Vec<AgentTask>,
    pub pet: PetState,
    pub events: Vec<BrainEventEnvelope>,
    pub cognitive_state: WorldState,
    pub body_map: SystemBodyMap,
    pub capabilities: Vec<CapabilityDescriptor>,
    pub recent_traces: Vec<ReasoningTrace>,
    pub event_metrics: EventMetrics,
}

#[derive(Clone)]
pub struct BrainServices {
    pub bus: BrainBus,
    pub memory: MemoryCortex,
    pub semantic: SemanticMemory,
    pub graph: KnowledgeGraph,
    pub context: ContextEngine,
    pub cognitive: CognitiveStateEngine,
    pub planner: PlannerEngine,
    pub execution: ExecutionGraphRuntime,
    pub capabilities: CapabilityRegistry,
    pub observability: ObservabilityHub,
    pub workflow: WorkflowEngine,
    pub tool_cortex: ToolCortex,
    pub safety: SafetyLayer,
    pub personality: Arc<Mutex<PersonalityEngine>>,
}

pub struct BrainCore {
    pub config: BrainConfig,
    pub services: BrainServices,
    runtime: AgentRuntime,
}

impl BrainCore {
    pub fn boot(config: BrainConfig) -> Result<Self> {
        let db_path = PathBuf::from(&config.sqlite_path);
        tracing::info!(path = %db_path.display(), "booting Computer Brain core");
        let memory = MemoryCortex::open(&db_path)
            .with_context(|| format!("failed to open SQLite memory at {}", db_path.display()))?;
        let bus = BrainBus::default();
        let safety = SafetyLayer::default();
        let semantic = SemanticMemory::new(config.embedding_dimensions);
        let graph = KnowledgeGraph::new(memory.clone());
        let cognitive = CognitiveStateEngine::default();
        let planner = PlannerEngine::default();
        let execution = ExecutionGraphRuntime::default();
        let capabilities = CapabilityRegistry::with_builtins();
        let observability = ObservabilityHub::default();
        let workflow = WorkflowEngine::default();
        let tool_cortex = ToolCortex::new(
            ToolCortexConfig {
                ollama_base_url: config.ollama_base_url.clone(),
                ollama_model: config.ollama_chat_model.clone(),
                ..ToolCortexConfig::default()
            },
            safety.clone(),
        );
        let services = BrainServices {
            bus: bus.clone(),
            memory: memory.clone(),
            semantic,
            graph,
            context: ContextEngine::default(),
            cognitive,
            planner,
            execution,
            capabilities,
            observability,
            workflow,
            tool_cortex,
            safety,
            personality: Arc::new(Mutex::new(PersonalityEngine::default())),
        };
        let runtime = AgentRuntime::new(bus);
        let core = Self {
            config,
            services,
            runtime,
        };
        core.register_agents();
        core.initialize_body_map()?;
        Ok(core)
    }

    fn register_agents(&self) {
        self.runtime.register(ObserverAgent::new(self.services.clone()));
        self.runtime.register(SummaryAgent::new(self.services.clone()));
        self.runtime.register(MemoryAgent::new(self.services.clone()));
        self.runtime.register(SemanticMemoryAgent::new(self.services.clone()));
        self.runtime.register(PlannerAgent::new(self.services.clone()));
        self.runtime.register(ProjectAgent::new(self.services.clone()));
        self.runtime.register(ToolRouterAgent::new(self.services.clone()));
        self.runtime.register(CommandAgent::new(self.services.clone()));
        self.runtime.register(SchedulerAgent::new(self.services.clone()));
        self.runtime.register(ContextAgent::new(self.services.clone()));
        self.runtime.register(WorkflowAgent::new(self.services.clone()));
        self.runtime.register(PetAgent::new(self.services.clone()));
        self.runtime.register(SafetyAgent::new(self.services.clone()));
    }

    pub async fn start(&mut self) -> Result<()> {
        self.persist_events();
        tracing::info!(agent_count = self.runtime.registry().descriptors().len(), "starting agent runtime");
        for agent in self.runtime.registry().descriptors() {
            self.services.memory.upsert_agent(&agent)?;
        }
        self.services.cognitive.set_agents(&self.runtime.registry().descriptors());
        self.runtime.start().await?;
        self.services
            .bus
            .emit(BrainEvent::SystemStarted { at: Utc::now() }, Some("BrainCore".to_string()))?;
        for capability in self.services.capabilities.list() {
            self.services.bus.emit(
                BrainEvent::CapabilityRegistered {
                    capability: capability.id,
                    at: Utc::now(),
                },
                Some("BrainCore".to_string()),
            )?;
        }
        Ok(())
    }

    fn initialize_body_map(&self) -> Result<()> {
        let projects = self.services.memory.recent_projects(100)?;
        let agents = self.runtime.registry().descriptors();
        let body_map = SystemBodyScanner::scan(&projects, &agents);
        self.services.cognitive.install_body_map(body_map.clone());
        self.services.memory.store_system_body_map(&body_map.identity_profile, &body_map)?;
        self.services.bus.emit(
            BrainEvent::BodyMapUpdated {
                summary: body_map.identity_profile,
                at: Utc::now(),
            },
            Some("BrainCore".to_string()),
        )?;
        Ok(())
    }

    fn persist_events(&self) {
        let memory = self.services.memory.clone();
        let cognitive = self.services.cognitive.clone();
        let observability = self.services.observability.clone();
        let mut rx = self.services.bus.subscribe();
        tokio::spawn(async move {
            loop {
                let Ok(event) = rx.recv().await else {
                    continue;
                };
                observability.record_event(&event);
                let world = cognitive.observe_event(&event.event);
                let _ = memory.store_event(&event);
                let _ = memory.store_world_state(&world);
            }
        });
    }

    pub async fn user_message(&self, content: String) -> Result<Vec<SemanticHit>> {
        self.services
            .bus
            .emit(BrainEvent::UserMessage { content: content.clone(), at: Utc::now() }, Some("User".to_string()))?;
        self.semantic_search(&content, 8).await
    }

    pub async fn semantic_search(&self, query: &str, limit: usize) -> Result<Vec<SemanticHit>> {
        let vectors = self.services.memory.vectors()?;
        self.services.semantic.search(query, vectors, limit, 0.16)
    }

    pub fn ingest_memory(&self, content: String, tags: Vec<String>, source_path: Option<String>) -> Result<MemoryRecord> {
        let record = memory(
            MemoryKind::LongTerm,
            Some("manual memory".to_string()),
            content,
            None,
            tags,
            source_path,
            0.65,
        );
        let record = self.services.memory.store_memory(record)?;
        self.services
            .bus
            .emit(BrainEvent::MemoryStored { memory_id: record.id.clone(), at: Utc::now() }, Some("MemoryAgent".to_string()))?;
        Ok(record)
    }

    pub fn observe_project(&self, root: impl AsRef<Path>) -> Result<ProjectRecord> {
        let root = root.as_ref();
        let name = root
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("workspace")
            .to_string();
        let project = self
            .services
            .memory
            .upsert_project(&name, &root.to_string_lossy(), serde_json::json!({}))?;
        self.services.bus.emit(
            BrainEvent::GitChanged {
                project_root: project.root_path.clone(),
                branch: None,
                changed_files: 0,
                at: Utc::now(),
            },
            Some("ObserverAgent".to_string()),
        )?;
        Ok(project)
    }

    pub async fn run_command(&self, command: String, cwd: Option<String>) -> Result<()> {
        self.services.bus.emit(
            BrainEvent::CommandRequested {
                command,
                cwd,
                at: Utc::now(),
            },
            Some("CommandAgent".to_string()),
        )?;
        Ok(())
    }

    pub fn dashboard(&self) -> Result<BrainDashboard> {
        Ok(BrainDashboard {
            counts: self.services.memory.counts()?,
            agents: self.runtime.registry().descriptors(),
            recent_memories: self.services.memory.recent_memories(20)?,
            recent_projects: self.services.memory.recent_projects(12)?,
            recent_tasks: self.services.memory.recent_tasks(20)?,
            pet: self.services.memory.latest_pet_state()?,
            events: self.services.bus.recent(80),
            cognitive_state: self.services.cognitive.snapshot(),
            body_map: self.services.cognitive.body_map(),
            capabilities: self.services.capabilities.list(),
            recent_traces: self.services.observability.recent_traces(20),
            event_metrics: self.services.observability.metrics(),
        })
    }

    pub fn graph_snapshot(&self) -> Result<(Vec<GraphNodeRecord>, Vec<GraphEdgeRecord>)> {
        self.services.graph.snapshot(300)
    }
}

macro_rules! boxed {
    ($body:expr) => {
        Box::pin(async move { $body })
    };
}

#[derive(Clone)]
struct ObserverAgent {
    services: BrainServices,
}

impl ObserverAgent {
    fn new(services: BrainServices) -> Self {
        Self { services }
    }
}

impl Agent for ObserverAgent {
    fn name(&self) -> String { "ObserverAgent".to_string() }
    fn capabilities(&self) -> Vec<AgentCapability> { vec![AgentCapability::ObserveFiles] }
    fn init<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> {
        boxed!(ctx.status(&self.name(), AgentState::Idle, Some("observer ready".to_string())))
    }
    fn handle_event<'a>(&'a self, _ctx: &'a AgentContext, event: BrainEventEnvelope) -> AgentFuture<'a> {
        boxed!({
            if let BrainEvent::GitChanged { project_root, .. } = event.event {
                let name = Path::new(&project_root)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("workspace");
                self.services.memory.upsert_project(name, &project_root, serde_json::json!({}))?;
            }
            Ok(())
        })
    }
    fn run_task<'a>(&'a self, _ctx: &'a AgentContext, _task: AgentTask) -> AgentFuture<'a> { boxed!(Ok(())) }
    fn shutdown<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> {
        boxed!(ctx.status(&self.name(), AgentState::Stopped, None))
    }
}

#[derive(Clone)]
struct SummaryAgent { services: BrainServices }
impl SummaryAgent { fn new(services: BrainServices) -> Self { Self { services } } }
impl Agent for SummaryAgent {
    fn name(&self) -> String { "SummaryAgent".to_string() }
    fn capabilities(&self) -> Vec<AgentCapability> { vec![AgentCapability::Summarize, AgentCapability::WriteMemory] }
    fn init<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> { boxed!(ctx.status(&self.name(), AgentState::Idle, None)) }
    fn handle_event<'a>(&'a self, ctx: &'a AgentContext, event: BrainEventEnvelope) -> AgentFuture<'a> {
        boxed!({
            if let BrainEvent::FileChanged { path, change, project_root, .. } = event.event {
                ctx.status(&self.name(), AgentState::Thinking, Some("summarizing file activity".to_string()))?;
                let project = if let Some(root) = project_root {
                    let name = Path::new(&root).file_name().and_then(|s| s.to_str()).unwrap_or("workspace");
                    Some(self.services.memory.upsert_project(name, &root, serde_json::json!({}))?.id)
                } else { None };
                let summary = format!("{change} observed at {path}");
                let record = self.services.memory.store_memory(memory(
                    MemoryKind::Summary,
                    Some("File activity summary".to_string()),
                    summary.clone(),
                    project.clone(),
                    vec!["file-activity".to_string(), "summary".to_string()],
                    Some(path),
                    0.58,
                ))?;
                self.services.bus.emit(BrainEvent::SummaryCreated {
                    memory_id: record.id,
                    summary,
                    project_id: project,
                    at: Utc::now(),
                }, Some(self.name()))?;
                ctx.status(&self.name(), AgentState::Idle, None)?;
            }
            Ok(())
        })
    }
    fn run_task<'a>(&'a self, _ctx: &'a AgentContext, task: AgentTask) -> AgentFuture<'a> {
        boxed!({
            let content = format!("Workflow task {} requested summary: {}", task.id, task.payload);
            self.services.memory.store_memory(memory(MemoryKind::Summary, Some(task.action), content, None, vec!["workflow".to_string()], None, 0.55))?;
            Ok(())
        })
    }
    fn shutdown<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> { boxed!(ctx.status(&self.name(), AgentState::Stopped, None)) }
}

#[derive(Clone)]
struct MemoryAgent { services: BrainServices }
impl MemoryAgent { fn new(services: BrainServices) -> Self { Self { services } } }
impl Agent for MemoryAgent {
    fn name(&self) -> String { "MemoryAgent".to_string() }
    fn capabilities(&self) -> Vec<AgentCapability> { vec![AgentCapability::ReadMemory, AgentCapability::WriteMemory] }
    fn init<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> { boxed!(ctx.status(&self.name(), AgentState::Idle, None)) }
    fn handle_event<'a>(&'a self, _ctx: &'a AgentContext, event: BrainEventEnvelope) -> AgentFuture<'a> {
        boxed!({
            match event.event {
                BrainEvent::UserMessage { content, .. } => {
                    let record = self.services.memory.store_memory(memory(
                        MemoryKind::Session,
                        Some("User message".to_string()),
                        content,
                        None,
                        vec!["conversation".to_string()],
                        None,
                        0.5,
                    ))?;
                    self.services.bus.emit(BrainEvent::MemoryStored { memory_id: record.id, at: Utc::now() }, Some(self.name()))?;
                }
                BrainEvent::SummaryCreated { memory_id, .. } => {
                    self.services.bus.emit(BrainEvent::MemoryStored { memory_id, at: Utc::now() }, Some(self.name()))?;
                }
                _ => {}
            }
            Ok(())
        })
    }
    fn run_task<'a>(&'a self, _ctx: &'a AgentContext, task: AgentTask) -> AgentFuture<'a> {
        boxed!({
            self.services.memory.store_memory(memory(
                MemoryKind::LongTerm,
                Some(task.action),
                format!("Task payload persisted: {}", task.payload),
                None,
                vec!["workflow".to_string()],
                None,
                0.52,
            ))?;
            Ok(())
        })
    }
    fn shutdown<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> { boxed!(ctx.status(&self.name(), AgentState::Stopped, None)) }
}

#[derive(Clone)]
struct SemanticMemoryAgent { services: BrainServices }
impl SemanticMemoryAgent { fn new(services: BrainServices) -> Self { Self { services } } }
impl Agent for SemanticMemoryAgent {
    fn name(&self) -> String { "SemanticMemoryAgent".to_string() }
    fn capabilities(&self) -> Vec<AgentCapability> { vec![AgentCapability::SemanticSearch, AgentCapability::ReadMemory] }
    fn init<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> { boxed!(ctx.status(&self.name(), AgentState::Idle, None)) }
    fn handle_event<'a>(&'a self, _ctx: &'a AgentContext, event: BrainEventEnvelope) -> AgentFuture<'a> {
        boxed!({
            if let BrainEvent::MemoryStored { memory_id, .. } = event.event {
                if let Some(memory) = self.services.memory.memory_by_id(&memory_id)? {
                    let vector = self.services.semantic.embed(&format!("{} {}", memory.tags.join(" "), memory.content));
                    self.services.memory.store_vector(&memory_id, self.services.semantic.model_name(), &vector, None)?;
                    self.services.bus.emit(BrainEvent::SemanticIndexed { memory_id, cluster_id: None, at: Utc::now() }, Some(self.name()))?;
                }
            }
            Ok(())
        })
    }
    fn run_task<'a>(&'a self, _ctx: &'a AgentContext, _task: AgentTask) -> AgentFuture<'a> { boxed!(Ok(())) }
    fn shutdown<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> { boxed!(ctx.status(&self.name(), AgentState::Stopped, None)) }
}

#[derive(Clone)]
struct PlannerAgent { services: BrainServices }
impl PlannerAgent { fn new(services: BrainServices) -> Self { Self { services } } }
impl Agent for PlannerAgent {
    fn name(&self) -> String { "PlannerAgent".to_string() }
    fn capabilities(&self) -> Vec<AgentCapability> { vec![AgentCapability::PlanTasks, AgentCapability::BuildExecutionGraph] }
    fn init<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> {
        boxed!(ctx.status(&self.name(), AgentState::Idle, Some("planner ready".to_string())))
    }
    fn handle_event<'a>(&'a self, ctx: &'a AgentContext, event: BrainEventEnvelope) -> AgentFuture<'a> {
        boxed!({
            if let BrainEvent::UserMessage { content, .. } = event.event {
                ctx.status(&self.name(), AgentState::Thinking, Some("planning requested action".to_string()))?;
                self.services.cognitive.transition(CognitiveMode::Planning, "building execution graph");
                let projects = self.services.memory.recent_projects(1)?;
                let memories = self.services.memory.recent_memories(20)?;
                let context = self.services.context.infer(Some(&content), &projects, &memories, Vec::new());
                let plan = self.services.planner.plan(content.clone(), context.summary, &memories);
                let graph = self.services.execution.from_plan(&plan);
                let trace = self.services.observability.trace(
                    "planning",
                    format!("Created {:?} plan with {} steps", plan.intent, plan.steps.len()),
                    serde_json::json!({
                        "plan_id": plan.id.clone(),
                        "execution_graph_id": graph.id.clone(),
                        "ready_nodes": self.services.execution.ready_nodes(&graph).len(),
                    }),
                );
                self.services.memory.store_reasoning_trace(&trace)?;
                self.services.memory.store_memory(memory(
                    MemoryKind::LongTerm,
                    Some("Execution plan".to_string()),
                    self.services.execution.replay_summary(&graph),
                    projects.first().map(|project| project.id.clone()),
                    vec!["plan".to_string(), "execution-graph".to_string()],
                    None,
                    0.62,
                ))?;
                self.services.bus.emit(BrainEvent::PlanCreated {
                    plan_id: plan.id.clone(),
                    intent: format!("{:?}", plan.intent),
                    step_count: plan.steps.len(),
                    at: Utc::now(),
                }, Some(self.name()))?;
                self.services.bus.emit(BrainEvent::ExecutionGraphCreated {
                    graph_id: graph.id,
                    plan_id: plan.id,
                    node_count: graph.nodes.len(),
                    at: Utc::now(),
                }, Some(self.name()))?;
                self.services.bus.emit(BrainEvent::ReasoningTraced {
                    trace_id: trace.id,
                    summary: trace.summary,
                    at: Utc::now(),
                }, Some(self.name()))?;
                ctx.status(&self.name(), AgentState::Idle, None)?;
            }
            Ok(())
        })
    }
    fn run_task<'a>(&'a self, _ctx: &'a AgentContext, task: AgentTask) -> AgentFuture<'a> {
        boxed!({
            let memories = self.services.memory.recent_memories(12)?;
            let plan = self.services.planner.plan(task.action, "workflow task", &memories);
            let graph = self.services.execution.from_plan(&plan);
            self.services.memory.store_reasoning_trace(&self.services.observability.trace(
                "workflow-planning",
                self.services.execution.replay_summary(&graph),
                serde_json::json!({ "plan_id": plan.id.clone(), "graph_id": graph.id.clone() }),
            ))?;
            Ok(())
        })
    }
    fn shutdown<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> { boxed!(ctx.status(&self.name(), AgentState::Stopped, None)) }
}

#[derive(Clone)]
struct ProjectAgent { services: BrainServices }
impl ProjectAgent { fn new(services: BrainServices) -> Self { Self { services } } }
impl Agent for ProjectAgent {
    fn name(&self) -> String { "ProjectAgent".to_string() }
    fn capabilities(&self) -> Vec<AgentCapability> { vec![AgentCapability::UpdateProjectGraph] }
    fn init<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> { boxed!(ctx.status(&self.name(), AgentState::Idle, None)) }
    fn handle_event<'a>(&'a self, _ctx: &'a AgentContext, event: BrainEventEnvelope) -> AgentFuture<'a> {
        boxed!({
            if let BrainEvent::MemoryStored { memory_id, .. } = event.event {
                if let Some(memory) = self.services.memory.memory_by_id(&memory_id)? {
                    let (nodes, edges) = self.services.graph.ingest_memory(&memory)?;
                    self.services.bus.emit(BrainEvent::GraphUpdated { node_count: nodes, edge_count: edges, at: Utc::now() }, Some(self.name()))?;
                }
            }
            Ok(())
        })
    }
    fn run_task<'a>(&'a self, _ctx: &'a AgentContext, _task: AgentTask) -> AgentFuture<'a> { boxed!(Ok(())) }
    fn shutdown<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> { boxed!(ctx.status(&self.name(), AgentState::Stopped, None)) }
}

#[derive(Clone)]
struct ToolRouterAgent { services: BrainServices }
impl ToolRouterAgent { fn new(services: BrainServices) -> Self { Self { services } } }
impl Agent for ToolRouterAgent {
    fn name(&self) -> String { "ToolRouterAgent".to_string() }
    fn capabilities(&self) -> Vec<AgentCapability> { vec![AgentCapability::RouteTools] }
    fn init<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> { boxed!(ctx.status(&self.name(), AgentState::Idle, None)) }
    fn handle_event<'a>(&'a self, _ctx: &'a AgentContext, event: BrainEventEnvelope) -> AgentFuture<'a> {
        boxed!({
            if let BrainEvent::ToolRequested { request, .. } = event.event {
                let tool_name = request.tool.clone();
                let provider = format!("{:?}", request.provider);
                let prompt = request.input.get("prompt").and_then(Value::as_str).map(ToString::to_string);
                let result = self.services.tool_cortex.route(request).await;
                self.services.memory.store_tool_result(&tool_name, &provider, prompt.as_deref(), &result)?;
                self.services.bus.emit(BrainEvent::ToolCompleted { result, at: Utc::now() }, Some(self.name()))?;
            }
            Ok(())
        })
    }
    fn run_task<'a>(&'a self, _ctx: &'a AgentContext, _task: AgentTask) -> AgentFuture<'a> { boxed!(Ok(())) }
    fn shutdown<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> { boxed!(ctx.status(&self.name(), AgentState::Stopped, None)) }
}

#[derive(Clone)]
struct CommandAgent { services: BrainServices }
impl CommandAgent { fn new(services: BrainServices) -> Self { Self { services } } }
impl Agent for CommandAgent {
    fn name(&self) -> String { "CommandAgent".to_string() }
    fn capabilities(&self) -> Vec<AgentCapability> { vec![AgentCapability::ExecuteSafeCommands] }
    fn init<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> { boxed!(ctx.status(&self.name(), AgentState::Idle, None)) }
    fn handle_event<'a>(&'a self, _ctx: &'a AgentContext, event: BrainEventEnvelope) -> AgentFuture<'a> {
        boxed!({
            if let BrainEvent::CommandRequested { command, cwd, .. } = event.event {
                let request = ToolRequest {
                    id: new_id("tool"),
                    provider: ToolProvider::Shell,
                    tool: "shell".to_string(),
                    input: serde_json::json!({ "command": command, "cwd": cwd }),
                    local_only: true,
                    requires_confirmation: false,
                };
                self.services.bus.emit(BrainEvent::ToolRequested { request, at: Utc::now() }, Some(self.name()))?;
            }
            Ok(())
        })
    }
    fn run_task<'a>(&'a self, _ctx: &'a AgentContext, _task: AgentTask) -> AgentFuture<'a> { boxed!(Ok(())) }
    fn shutdown<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> { boxed!(ctx.status(&self.name(), AgentState::Stopped, None)) }
}

#[derive(Clone)]
struct SchedulerAgent { services: BrainServices }
impl SchedulerAgent { fn new(services: BrainServices) -> Self { Self { services } } }
impl Agent for SchedulerAgent {
    fn name(&self) -> String { "SchedulerAgent".to_string() }
    fn capabilities(&self) -> Vec<AgentCapability> { vec![AgentCapability::ScheduleWorkflows] }
    fn init<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> { boxed!(ctx.status(&self.name(), AgentState::Idle, None)) }
    fn handle_event<'a>(&'a self, _ctx: &'a AgentContext, event: BrainEventEnvelope) -> AgentFuture<'a> {
        boxed!({
            if matches!(event.event, BrainEvent::SystemStarted { .. }) {
                let task = new_task(None, "WorkflowAgent", "nightly-summary-check", 45, serde_json::json!({ "schedule": "nightly" }));
                self.services.memory.store_task(&task)?;
                self.services.bus.emit(BrainEvent::WorkflowQueued { task_id: task.id, agent: task.agent, action: task.action, at: Utc::now() }, Some(self.name()))?;
            }
            Ok(())
        })
    }
    fn run_task<'a>(&'a self, _ctx: &'a AgentContext, _task: AgentTask) -> AgentFuture<'a> { boxed!(Ok(())) }
    fn shutdown<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> { boxed!(ctx.status(&self.name(), AgentState::Stopped, None)) }
}

#[derive(Clone)]
struct ContextAgent { services: BrainServices }
impl ContextAgent { fn new(services: BrainServices) -> Self { Self { services } } }
impl Agent for ContextAgent {
    fn name(&self) -> String { "ContextAgent".to_string() }
    fn capabilities(&self) -> Vec<AgentCapability> { vec![AgentCapability::InferContext, AgentCapability::ReadMemory] }
    fn init<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> { boxed!(ctx.status(&self.name(), AgentState::Idle, None)) }
    fn handle_event<'a>(&'a self, _ctx: &'a AgentContext, event: BrainEventEnvelope) -> AgentFuture<'a> {
        boxed!({
            if let BrainEvent::UserMessage { content, .. } = event.event {
                let projects = self.services.memory.recent_projects(1)?;
                let memories = self.services.memory.recent_memories(30)?;
                let snapshot = self.services.context.infer(Some(&content), &projects, &memories, Vec::new());
                self.services.memory.store_context_snapshot(
                    &snapshot.id,
                    snapshot.project_id.as_deref(),
                    &snapshot.active_files,
                    &snapshot.relevant_memory_ids,
                    &snapshot.likely_intent,
                    snapshot.confidence,
                    &snapshot.summary,
                )?;
                self.services.bus.emit(BrainEvent::ContextUpdated {
                    summary: snapshot.summary,
                    project_id: snapshot.project_id,
                    at: Utc::now(),
                }, Some(self.name()))?;
            }
            Ok(())
        })
    }
    fn run_task<'a>(&'a self, _ctx: &'a AgentContext, _task: AgentTask) -> AgentFuture<'a> { boxed!(Ok(())) }
    fn shutdown<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> { boxed!(ctx.status(&self.name(), AgentState::Stopped, None)) }
}

#[derive(Clone)]
struct WorkflowAgent { services: BrainServices }
impl WorkflowAgent { fn new(services: BrainServices) -> Self { Self { services } } }
impl Agent for WorkflowAgent {
    fn name(&self) -> String { "WorkflowAgent".to_string() }
    fn capabilities(&self) -> Vec<AgentCapability> { vec![AgentCapability::ScheduleWorkflows] }
    fn init<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> { boxed!(ctx.status(&self.name(), AgentState::Idle, None)) }
    fn handle_event<'a>(&'a self, _ctx: &'a AgentContext, event: BrainEventEnvelope) -> AgentFuture<'a> {
        boxed!({
            if let BrainEvent::FileChanged { path, change, project_root, .. } = event.event {
                for task in self.services.workflow.trigger("file-changed", serde_json::json!({ "path": path, "change": change, "projectRoot": project_root }))? {
                    self.services.memory.store_task(&task)?;
                    self.services.bus.emit(BrainEvent::WorkflowQueued {
                        task_id: task.id,
                        agent: task.agent,
                        action: task.action,
                        at: Utc::now(),
                    }, Some(self.name()))?;
                }
            }
            Ok(())
        })
    }
    fn run_task<'a>(&'a self, _ctx: &'a AgentContext, task: AgentTask) -> AgentFuture<'a> {
        boxed!({
            self.services.memory.store_memory(memory(MemoryKind::Daily, Some(task.action), "Scheduled workflow checkpoint".to_string(), None, vec!["schedule".to_string()], None, 0.45))?;
            Ok(())
        })
    }
    fn shutdown<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> { boxed!(ctx.status(&self.name(), AgentState::Stopped, None)) }
}

#[derive(Clone)]
struct PetAgent { services: BrainServices }
impl PetAgent { fn new(services: BrainServices) -> Self { Self { services } } }
impl Agent for PetAgent {
    fn name(&self) -> String { "PetAgent".to_string() }
    fn capabilities(&self) -> Vec<AgentCapability> { vec![AgentCapability::UpdatePet] }
    fn init<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> { boxed!(ctx.status(&self.name(), AgentState::Idle, None)) }
    fn handle_event<'a>(&'a self, _ctx: &'a AgentContext, event: BrainEventEnvelope) -> AgentFuture<'a> {
        boxed!({
            let mut update = None;
            match event.event {
                BrainEvent::SummaryCreated { summary, .. } => update = Some((0.45, 1, 0, 0.35, summary)),
                BrainEvent::FileChanged { path, .. } => update = Some((0.55, 2, 0, 0.45, format!("Observed {path}"))),
                BrainEvent::Error { message, .. } => update = Some((0.7, 1, 1, 0.2, message)),
                _ => {}
            }
            if let Some((workload, agents, errors, novelty, brief)) = update {
                let mut engine = self.services.personality.lock().await;
                let state = engine.update(MoodInput {
                    workload,
                    agent_activity: agents,
                    errors,
                    novelty,
                    project: None,
                    brief,
                });
                self.services.memory.store_pet_state(&state)?;
                self.services.bus.emit(BrainEvent::PetUpdated { state, at: Utc::now() }, Some(self.name()))?;
            }
            Ok(())
        })
    }
    fn run_task<'a>(&'a self, _ctx: &'a AgentContext, _task: AgentTask) -> AgentFuture<'a> { boxed!(Ok(())) }
    fn shutdown<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> { boxed!(ctx.status(&self.name(), AgentState::Stopped, None)) }
}

#[derive(Clone)]
struct SafetyAgent { services: BrainServices }
impl SafetyAgent { fn new(services: BrainServices) -> Self { Self { services } } }
impl Agent for SafetyAgent {
    fn name(&self) -> String { "SafetyAgent".to_string() }
    fn capabilities(&self) -> Vec<AgentCapability> { vec![AgentCapability::EnforceSafety] }
    fn init<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> { boxed!(ctx.status(&self.name(), AgentState::Idle, None)) }
    fn handle_event<'a>(&'a self, _ctx: &'a AgentContext, event: BrainEventEnvelope) -> AgentFuture<'a> {
        boxed!({
            if let BrainEvent::CommandRequested { command, .. } = event.event {
                let decision = self.services.safety.check_command(&command);
                self.services.memory.audit("CommandAgent", &command, &decision, serde_json::json!({}))?;
                if !matches!(decision.decision, SafetyDecisionKind::Allow) {
                    self.services.bus.emit(BrainEvent::SafetyAudited {
                        actor: "CommandAgent".to_string(),
                        action: command,
                        decision,
                        at: Utc::now(),
                    }, Some(self.name()))?;
                }
            }
            Ok(())
        })
    }
    fn run_task<'a>(&'a self, _ctx: &'a AgentContext, _task: AgentTask) -> AgentFuture<'a> { boxed!(Ok(())) }
    fn shutdown<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> { boxed!(ctx.status(&self.name(), AgentState::Stopped, None)) }
}
