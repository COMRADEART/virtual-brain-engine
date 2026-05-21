use agent_runtime::{Agent, AgentContext, AgentFuture, AgentRuntime};
use adaptation_engine::AdaptationEngine;
use anyhow::{Context, Result};
use capability_system::{CapabilityDescriptor, CapabilityRegistry};
use chrono::Utc;
use cognitive_state::{CognitiveMode, CognitiveStateEngine, SystemBodyMap, SystemBodyScanner, WorldState};
use context_engine::ContextEngine;
use evolution_engine::{
    GenomeKind, PerformanceSignals, RecursiveEvolutionEngine,
    DEFAULT_POPULATION,
};
use execution_graph::ExecutionGraphRuntime;
use knowledge_graph::KnowledgeGraph;
use learning_engine::LearningEngine;
use memory_cortex::{memory, MemoryCortex};
use nervous_system::BrainBus;
use observability::{EventMetrics, ObservabilityHub, ReasoningTrace};
use perception_engine::{ObservationKind, PerceptionEngine, StructuredObservation};
use personality_engine::{MoodInput, PersonalityEngine};
use planning_engine::PlanningEngine as CognitivePlanningEngine;
use planner_engine::PlannerEngine;
use reflection_engine::{ExecutionOutcome, PlanningQuality, ReflectionEngine, ReflectionRecord, WorkflowEfficiency};
use safety_layer::SafetyLayer;
use semantic_memory::{SemanticHit, SemanticMemory};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use shared_types::{
    new_id, AgentCapability, AgentState, AgentTask, BrainConfig, BrainEvent, BrainEventEnvelope,
    ConsciousnessCycleRecord, GoalRecord, GoalRisk, GoalStatus, GraphEdgeRecord, GraphNodeRecord,
    MemoryKind, MemoryRecord, OperatingMode, PetState, ProjectRecord,
    SafetyDecisionKind, ToolProvider, ToolRequest,
};
use skill_learning::{ObservedAction, SkillFailure, SkillLearningEngine, SkillRun};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::time::{sleep, Duration};
use tool_cortex::{ToolCortex, ToolCortexConfig};
use web_cortex::{WebCortex, WebCortexConfig};
use understanding_engine::{SituationalIntent, SituationalUnderstanding, UnderstandingEngine};
use workflow_engine::{new_task, WorkflowEngine};
use conscious_workspace::ConsciousWorkspace;

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
    pub operating_mode: OperatingMode,
    pub goals: Vec<GoalRecord>,
    pub body_map: SystemBodyMap,
    pub capabilities: Vec<CapabilityDescriptor>,
    pub recent_traces: Vec<ReasoningTrace>,
    pub event_metrics: EventMetrics,
    pub workspace_state: WorkspaceDashboardState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceDashboardState {
    pub current_focus: Option<String>,
    pub focus_intensity: f64,
    pub active_stream_count: usize,
    pub working_memory_load: f64,
    pub cognitive_load: String,
    pub cognitive_load_pct: f64,
    pub attention_bandwidth_used: f64,
    pub total_attention: f64,
    pub uncertainty_level: f64,
}

#[derive(Clone)]
pub struct BrainServices {
    pub bus: BrainBus,
    pub memory: MemoryCortex,
    pub semantic: SemanticMemory,
    pub graph: KnowledgeGraph,
    pub context: ContextEngine,
    pub cognitive: CognitiveStateEngine,
    pub perception: PerceptionEngine,
    pub understanding: UnderstandingEngine,
    pub planner: PlannerEngine,
    pub planning: CognitivePlanningEngine,
    pub execution: ExecutionGraphRuntime,
    pub reflection: ReflectionEngine,
    pub learning: LearningEngine,
    pub adaptation: AdaptationEngine,
    pub evolution: RecursiveEvolutionEngine,
    pub capabilities: CapabilityRegistry,
    pub observability: ObservabilityHub,
    pub skill_learning: SkillLearningEngine,
    pub workflow: WorkflowEngine,
    pub tool_cortex: ToolCortex,
    pub safety: SafetyLayer,
    pub personality: Arc<Mutex<PersonalityEngine>>,
    pub web_cortex: WebCortex,
    pub workspace: Arc<ConsciousWorkspace>,
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
        let operating_mode = memory.latest_operating_mode()?;
        cognitive.set_operating_mode(operating_mode.clone());
        memory.store_operating_mode(&operating_mode)?;
        cognitive.replace_goals(memory.recent_goals(64)?);
        let perception = PerceptionEngine::default();
        let understanding = UnderstandingEngine::default();
        let planner = PlannerEngine::default();
        let planning = CognitivePlanningEngine::default();
        let execution = ExecutionGraphRuntime::default();
        let reflection = ReflectionEngine::default();
        let learning = LearningEngine::default();
        let adaptation = AdaptationEngine::default();
        let evolution = RecursiveEvolutionEngine::default();
        let capabilities = CapabilityRegistry::with_builtins();
        let observability = ObservabilityHub::default();
        let skill_learning = SkillLearningEngine::default();
        let workflow = WorkflowEngine::default();
        let tool_cortex = ToolCortex::new(
            ToolCortexConfig {
                ollama_base_url: config.ollama_base_url.clone(),
                ollama_model: config.ollama_chat_model.clone(),
                ..ToolCortexConfig::default()
            },
            safety.clone(),
        );
        let web_cortex = WebCortex::new(WebCortexConfig::default());
        let workspace = Arc::new(ConsciousWorkspace::new());
        let services = BrainServices {
            bus: bus.clone(),
            memory: memory.clone(),
            semantic,
            graph,
            context: ContextEngine::default(),
            cognitive,
            perception,
            understanding,
            planner,
            planning,
            execution,
            reflection,
            learning,
            adaptation,
            evolution,
            capabilities,
            observability,
            skill_learning,
            workflow,
            tool_cortex,
            safety,
            personality: Arc::new(Mutex::new(PersonalityEngine::default())),
            web_cortex,
            workspace,
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
        self.runtime.register(SkillAgent::new(self.services.clone()));
        self.runtime.register(ProjectAgent::new(self.services.clone()));
        self.runtime.register(ToolRouterAgent::new(self.services.clone()));
        self.runtime.register(CommandAgent::new(self.services.clone()));
        self.runtime.register(SchedulerAgent::new(self.services.clone()));
        self.runtime.register(ContextAgent::new(self.services.clone()));
        self.runtime.register(WorkflowAgent::new(self.services.clone()));
        self.runtime.register(PetAgent::new(self.services.clone()));
        self.runtime.register(SafetyAgent::new(self.services.clone()));
        self.runtime.register(WebAgent::new(self.services.clone()));
    }

    pub async fn start(&mut self) -> Result<()> {
        self.persist_events();
        self.start_heartbeat();
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

    fn start_heartbeat(&self) {
        let services = self.services.clone();
        tokio::spawn(async move {
            let mut tick: u64 = 0;
            loop {
                sleep(Duration::from_secs(60)).await;
                tick = tick.wrapping_add(1);
                let world = services.cognitive.snapshot();
                let summary = format!(
                    "heartbeat: cognitive={:?}, operating={:?}, focus={}, pending_tasks={}, active_agents={}",
                    world.cognitive_mode,
                    world.operating_mode,
                    world.current_focus,
                    world.pending_tasks,
                    world.active_agents.len()
                );
                let trace = services.observability.trace(
                    "heartbeat",
                    summary.clone(),
                    serde_json::json!({
                        "world_state": world,
                        "recent_action_count": services.skill_learning.recent_actions(16).len(),
                    }),
                );
                let _ = services.memory.store_reasoning_trace(&trace);
                run_consciousness_cycle(&services, world);
                // Recursive cognitive evolution runs on its own slow cadence
                // (~240s), not per cognitive-loop event, so a single tool
                // result never triggers a full population search.
                if tick % 4 == 0 {
                    if let Err(error) = run_evolution(&services) {
                        tracing::warn!(%error, "recursive evolution generation failed");
                    }
                }
                let _ = services.bus.emit(
                    BrainEvent::Heartbeat {
                        summary,
                        at: Utc::now(),
                    },
                    Some("BrainCore".to_string()),
                );
            }
        });
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
        let services = self.services.clone();
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
                run_cognitive_loop(&services, &event, &world);
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

    pub fn set_operating_mode(&self, mode: OperatingMode) -> Result<WorldState> {
        let world = self.services.cognitive.set_operating_mode(mode.clone());
        self.services.memory.store_operating_mode(&mode)?;
        self.services.bus.emit(
            BrainEvent::OperatingModeChanged {
                mode,
                at: Utc::now(),
            },
            Some("BrainCore".to_string()),
        )?;
        Ok(world)
    }

    pub fn run_consciousness_once(&self) {
        run_consciousness_cycle(&self.services, self.services.cognitive.snapshot());
    }

    pub fn dashboard(&self) -> Result<BrainDashboard> {
        let cognitive_state = self.services.cognitive.snapshot();
        let workspace_state = self.services.workspace.get_self_aware_state();
        let heatmap = self.services.workspace.get_attention_heatmap();
        Ok(BrainDashboard {
            counts: self.services.memory.counts()?,
            agents: self.runtime.registry().descriptors(),
            recent_memories: self.services.memory.recent_memories(20)?,
            recent_projects: self.services.memory.recent_projects(12)?,
            recent_tasks: self.services.memory.recent_tasks(20)?,
            pet: self.services.memory.latest_pet_state()?,
            events: self.services.bus.recent(80),
            operating_mode: cognitive_state.operating_mode.clone(),
            goals: self.services.memory.recent_goals(32)?,
            cognitive_state,
            body_map: self.services.cognitive.body_map(),
            capabilities: self.services.capabilities.list(),
            recent_traces: self.services.observability.recent_traces(20),
            event_metrics: self.services.observability.metrics(),
            workspace_state: WorkspaceDashboardState {
                current_focus: workspace_state.current_focus.as_ref().map(|f| f.content.clone()),
                focus_intensity: workspace_state.current_focus.as_ref().map(|f| f.intensity).unwrap_or(0.0),
                active_stream_count: workspace_state.active_streams.len(),
                working_memory_load: workspace_state.working_memory_load,
                cognitive_load: format!("{:?}", workspace_state.cognitive_load),
                cognitive_load_pct: workspace_state.cognitive_load as i32 as f64 * 16.67,
                attention_bandwidth_used: workspace_state.attention_bandwidth_used,
                total_attention: heatmap.total_attention,
                uncertainty_level: workspace_state.uncertainty_level,
            },
        })
    }

    pub fn graph_snapshot(&self) -> Result<(Vec<GraphNodeRecord>, Vec<GraphEdgeRecord>)> {
        self.services.graph.snapshot(300)
    }
}

fn run_cognitive_loop(services: &BrainServices, event: &BrainEventEnvelope, world: &WorldState) {
    if let Some(observation) = services.perception.perceive(event) {
        if let Err(error) = services.memory.store_observation(&observation) {
            tracing::warn!(%error, "failed to persist cognitive observation");
        }
        emit_cognitive(
            services,
            BrainEvent::PerceptionCreated {
                observation_id: observation.id.clone(),
                source: format!("{:?}", &observation.source),
                summary: observation.summary.clone(),
                at: Utc::now(),
            },
            "PerceptionEngine",
        );

        let projects = services.memory.recent_projects(5).unwrap_or_default();
        let memories = services.memory.recent_memories(20).unwrap_or_default();
        let understanding = services.understanding.understand(&observation, &projects, &memories);
        if let Err(error) = services.memory.store_understanding(&understanding) {
            tracing::warn!(%error, "failed to persist situational understanding");
        }
        emit_cognitive(
            services,
            BrainEvent::UnderstandingCreated {
                understanding_id: understanding.id.clone(),
                intent: format!("{:?}", &understanding.intent),
                confidence: understanding.confidence,
                at: Utc::now(),
            },
            "UnderstandingEngine",
        );

        create_goal_stack_entries(services, &observation, &understanding);

        if matches!(
            &observation.kind,
            ObservationKind::Request | ObservationKind::Failure | ObservationKind::PlanSignal
        ) {
            let plan = services
                .planner
                .plan(observation.summary.clone(), understanding.summary.clone(), &memories);
            let assessment = services
                .planning
                .assess(&plan, &understanding, &services.capabilities.list());
            if let Err(error) = services.memory.store_plan_assessment(&assessment) {
                tracing::warn!(%error, "failed to persist cognitive plan assessment");
            }
            let trace = services.observability.trace(
                "cognitive-planning",
                assessment.rationale.clone(),
                serde_json::json!({
                    "observation_id": observation.id,
                    "understanding_id": understanding.id,
                    "plan_id": plan.id,
                    "risk_score": assessment.risk_score,
                    "quality_score": assessment.quality_score,
                    "permission_required": assessment.permission_required,
                    "chosen_tools": assessment.chosen_tools,
                    "agent_assignments": assessment.agent_assignments,
                }),
            );
            if let Err(error) = services.memory.store_reasoning_trace(&trace) {
                tracing::warn!(%error, "failed to persist cognitive planning trace");
            }
            emit_cognitive(
                services,
                BrainEvent::PlanAssessed {
                    assessment_id: assessment.id,
                    plan_id: assessment.plan_id,
                    risk_score: assessment.risk_score,
                    quality_score: assessment.quality_score,
                    at: Utc::now(),
                },
                "PlanningEngine",
            );
            emit_cognitive(
                services,
                BrainEvent::ReasoningTraced {
                    trace_id: trace.id,
                    summary: trace.summary,
                    at: Utc::now(),
                },
                "PlanningEngine",
            );
        }
    }

    if let BrainEvent::ToolCompleted { result, .. } = &event.event {
        let tool = format!("{:?}:{}", &result.provider, result.request_id);
        let (outcome, reflection, efficiency, planning_quality) = services.reflection.reflect_tool_result(&tool, result);
        persist_reflection_learning(services, world, outcome, reflection, efficiency, planning_quality);
    }

    if let BrainEvent::WorkflowQueued { task_id, agent, action, .. } = &event.event {
        let workflow = format!("{agent}:{action}");
        let (outcome, reflection, efficiency, planning_quality) = services.reflection.reflect_workflow_checkpoint(
            &workflow,
            &format!("Queue workflow task {task_id} for {agent}."),
            true,
            "Workflow entered the bounded execution path through the event bus.",
        );
        persist_reflection_learning(services, world, outcome, reflection, efficiency, planning_quality);
    }
}

fn persist_reflection_learning(
    services: &BrainServices,
    world: &WorldState,
    outcome: ExecutionOutcome,
    reflection: ReflectionRecord,
    efficiency: WorkflowEfficiency,
    planning_quality: PlanningQuality,
) {
    if let Err(error) = services.memory.store_execution_outcome(&outcome) {
        tracing::warn!(%error, "failed to persist execution outcome");
    }
    if let Err(error) = services.memory.store_reflection(&reflection) {
        tracing::warn!(%error, "failed to persist reflection");
    }
    if let Err(error) = services.memory.store_workflow_efficiency(&efficiency) {
        tracing::warn!(%error, "failed to persist workflow efficiency");
    }
    if let Err(error) = services.memory.store_planning_quality(&planning_quality) {
        tracing::warn!(%error, "failed to persist planning quality");
    }
    emit_cognitive(
        services,
        BrainEvent::ExecutionOutcomeRecorded {
            outcome_id: outcome.id,
            ok: outcome.ok,
            at: Utc::now(),
        },
        "ReflectionEngine",
    );
    emit_cognitive(
        services,
        BrainEvent::ReflectionCreated {
            reflection_id: reflection.id.clone(),
            summary: reflection.summary.clone(),
            at: Utc::now(),
        },
        "ReflectionEngine",
    );

    let (lesson, signal) = services.learning.learn_from_reflection(&reflection);
    if let Err(error) = services.memory.store_lesson(&lesson, &signal) {
        tracing::warn!(%error, "failed to persist learned lesson");
    }
    emit_cognitive(
        services,
        BrainEvent::LessonLearned {
            lesson_id: lesson.id,
            summary: lesson.summary,
            at: Utc::now(),
        },
        "LearningEngine",
    );

    for decision in services.adaptation.adapt(world, Some(&reflection), Some(&signal)) {
        if let Err(error) = services.memory.store_adaptation(&decision) {
            tracing::warn!(%error, "failed to persist adaptation decision");
        }
        emit_cognitive(
            services,
            BrainEvent::AdaptationApplied {
                adaptation_id: decision.id,
                behavior: decision.behavior,
                at: Utc::now(),
            },
            "AdaptationEngine",
        );
    }
}

fn create_goal_stack_entries(
    services: &BrainServices,
    observation: &StructuredObservation,
    understanding: &SituationalUnderstanding,
) {
    if !matches!(&observation.kind, ObservationKind::Request) {
        return;
    }
    let title = observation
        .signal
        .get("content")
        .and_then(Value::as_str)
        .map(clean_goal_title)
        .unwrap_or_else(|| clean_goal_title(&observation.summary));
    if title.is_empty() {
        return;
    }

    let mode = services.cognitive.operating_mode();
    let risk = infer_goal_risk(&title);
    let status = goal_status_for_mode(&mode, &risk);
    let now = Utc::now();
    let parent = GoalRecord {
        id: new_id("goal"),
        parent_id: None,
        title,
        priority: goal_priority(&risk),
        status,
        owner_agent: "PlannerAgent".to_string(),
        required_tools: vec!["context.load".to_string(), "memory.retrieve".to_string(), "schedule.task".to_string()],
        risk_level: risk,
        memory_links: understanding.related_memory_ids.clone(),
        deadline: None,
        created_at: now,
        updated_at: now,
    };
    store_goal_and_emit(services, parent.clone());

    for (label, owner, tools) in subgoals_for_intent(&understanding.intent) {
        let subgoal = GoalRecord {
            id: new_id("goal"),
            parent_id: Some(parent.id.clone()),
            title: label,
            priority: parent.priority.saturating_sub(8).max(10),
            status: parent.status.clone(),
            owner_agent: owner,
            required_tools: tools,
            risk_level: parent.risk_level.clone(),
            memory_links: parent.memory_links.clone(),
            deadline: None,
            created_at: now,
            updated_at: now,
        };
        store_goal_and_emit(services, subgoal);
    }
}

fn run_consciousness_cycle(services: &BrainServices, world: WorldState) {
    let mode = world.operating_mode.clone();
    let memories = services.memory.recent_memories(12).unwrap_or_default();
    let mut goals = services.memory.recent_goals(16).unwrap_or_default();
    if goals.is_empty() {
        goals = services.cognitive.goals();
    } else {
        services.cognitive.replace_goals(goals.clone());
    }

    let capabilities = services.capabilities.list();
    let available_tools = capabilities
        .iter()
        .filter(|capability| !capability.approval_required)
        .map(|capability| capability.id.clone())
        .collect::<Vec<_>>();
    let available_skills = services.cognitive.body_map().skill_map.known_skills;
    let recalled_memory_ids = memories.iter().map(|memory| memory.id.clone()).collect::<Vec<_>>();
    let detected_goal_ids = goals.iter().take(8).map(|goal| goal.id.clone()).collect::<Vec<_>>();
    let mut plan_ids = Vec::new();
    let mut actions_taken = Vec::new();

    if let Some(goal) = goals.iter().find(|goal| matches!(goal.status, GoalStatus::Active | GoalStatus::Proposed)) {
        let plan = services.planner.plan(goal.title.clone(), world.current_focus.clone(), &memories);
        let assessment = services.planning.assess(&plan, &services.understanding.understand(
            &StructuredObservation {
                id: new_id("obs"),
                source: perception_engine::PerceptionSource::System,
                kind: ObservationKind::PlanSignal,
                raw_event_id: new_id("evt"),
                raw_event_kind: "consciousness-cycle".to_string(),
                summary: goal.title.clone(),
                signal: serde_json::json!({ "goal_id": goal.id, "mode": format!("{:?}", &mode) }),
                confidence: 0.72,
                tags: vec!["consciousness-loop".to_string(), "goal-stack".to_string()],
                created_at: Utc::now(),
            },
            &services.memory.recent_projects(5).unwrap_or_default(),
            &memories,
        ), &capabilities);
        plan_ids.push(plan.id.clone());
        if let Err(error) = services.memory.store_plan_assessment(&assessment) {
            tracing::warn!(%error, "failed to persist consciousness plan assessment");
        }
        actions_taken.push(format!(
            "assessed goal '{}' with risk {:.2} and quality {:.2}",
            goal.title, assessment.risk_score, assessment.quality_score
        ));
    }

    match mode {
        OperatingMode::Passive => {
            actions_taken.push("observed world state, recalled memory, and stored a cycle summary only".to_string());
        }
        OperatingMode::Assisted => {
            actions_taken.push("prepared plan context and waited for user approval before execution".to_string());
        }
        OperatingMode::Active => {
            if world.pending_tasks == 0 && goals.iter().any(is_low_risk_active_goal) {
                queue_consciousness_task(services, "active-safe-checkpoint", &mut actions_taken);
            } else {
                actions_taken.push("no low-risk approved task was ready for active execution".to_string());
            }
        }
        OperatingMode::Autonomous => {
            if world.pending_tasks == 0 && goals.iter().any(is_low_risk_active_goal) {
                queue_consciousness_task(services, "autonomous-trusted-checkpoint", &mut actions_taken);
            } else {
                actions_taken.push("autonomous mode found no pre-approved trusted workflow to run".to_string());
            }
        }
    }

    let risk_score = estimate_cycle_risk(&mode, &goals);
    let summary = format!(
        "Consciousness cycle in {:?}: recalled {} memories, tracked {} goals, risk {:.2}.",
        mode,
        recalled_memory_ids.len(),
        detected_goal_ids.len(),
        risk_score
    );
    let cycle = ConsciousnessCycleRecord {
        id: new_id("cycle"),
        mode: mode.clone(),
        world_state: serde_json::json!(world),
        recalled_memory_ids,
        detected_goal_ids,
        available_tools,
        available_skills,
        risk_score,
        plan_ids,
        actions_taken,
        reflection_ids: Vec::new(),
        summary: summary.clone(),
        created_at: Utc::now(),
    };
    if let Err(error) = services.memory.store_consciousness_cycle(&cycle) {
        tracing::warn!(%error, "failed to persist consciousness cycle");
    }
    let _ = services.memory.store_memory(memory(
        MemoryKind::Temporal,
        Some("Consciousness loop cycle".to_string()),
        summary.clone(),
        None,
        vec!["consciousness-loop".to_string(), "temporal-memory".to_string()],
        None,
        0.42,
    ));
    emit_cognitive(
        services,
        BrainEvent::ConsciousnessCycleCompleted {
            cycle_id: cycle.id,
            mode,
            summary,
            at: Utc::now(),
        },
        "ConsciousnessLoop",
    );
}

fn store_goal_and_emit(services: &BrainServices, goal: GoalRecord) {
    services.cognitive.push_goal(goal.clone());
    if let Err(error) = services.memory.store_goal(&goal) {
        tracing::warn!(%error, "failed to persist goal");
    }
    emit_cognitive(
        services,
        BrainEvent::GoalStackUpdated {
            goal_id: goal.id,
            title: goal.title,
            status: goal.status,
            at: Utc::now(),
        },
        "ConsciousnessLoop",
    );
}

fn queue_consciousness_task(services: &BrainServices, action: &str, actions_taken: &mut Vec<String>) {
    let task = new_task(
        None,
        "WorkflowAgent",
        action,
        35,
        serde_json::json!({ "source": "consciousness-loop", "risk": "low" }),
    );
    if let Err(error) = services.memory.store_task(&task) {
        tracing::warn!(%error, "failed to persist consciousness task");
        return;
    }
    let task_id = task.id.clone();
    let task_agent = task.agent.clone();
    let task_action = task.action.clone();
    emit_cognitive(
        services,
        BrainEvent::WorkflowQueued {
            task_id,
            agent: task_agent,
            action: task_action.clone(),
            at: Utc::now(),
        },
        "ConsciousnessLoop",
    );
    actions_taken.push(format!("queued low-risk workflow task '{}'", task_action));
}

fn clean_goal_title(value: &str) -> String {
    value
        .trim()
        .trim_start_matches("User request received:")
        .trim()
        .chars()
        .take(180)
        .collect::<String>()
}

fn subgoals_for_intent(intent: &SituationalIntent) -> Vec<(String, String, Vec<String>)> {
    match intent {
        SituationalIntent::Debug => vec![
            subgoal("Inspect project context", "ContextAgent", &["context.load", "memory.retrieve"]),
            subgoal("Run safe diagnostics when approved", "CommandAgent", &["terminal.execute"]),
            subgoal("Analyze failure output", "SummaryAgent", &["summarize.code"]),
            subgoal("Store reflection and lessons", "MemoryAgent", &["memory.store"]),
        ],
        SituationalIntent::Build => vec![
            subgoal("Load build context", "ContextAgent", &["context.load"]),
            subgoal("Assess build command risk", "SafetyAgent", &["terminal.execute"]),
            subgoal("Summarize build result", "SummaryAgent", &["summarize.code"]),
        ],
        SituationalIntent::Test => vec![
            subgoal("Recall previous test failures", "SemanticMemoryAgent", &["memory.retrieve"]),
            subgoal("Run approved test workflow", "CommandAgent", &["terminal.execute"]),
            subgoal("Reflect on test result", "MemoryAgent", &["memory.store"]),
        ],
        SituationalIntent::Recall => vec![
            subgoal("Search semantic memory", "SemanticMemoryAgent", &["memory.retrieve"]),
            subgoal("Rank relevant memories", "MemoryAgent", &["memory.retrieve"]),
        ],
        SituationalIntent::Learn => vec![
            subgoal("Detect repeated workflow", "SkillAgent", &["memory.retrieve"]),
            subgoal("Update skill memory", "SkillAgent", &["memory.store"]),
        ],
        SituationalIntent::SafetyReview => vec![subgoal("Review safety constraints", "SafetyAgent", &["memory.retrieve"])],
        SituationalIntent::Observe | SituationalIntent::Unknown => {
            vec![subgoal("Observe and summarize context", "SummaryAgent", &["memory.store"])]
        }
    }
}

fn subgoal(label: &str, owner: &str, tools: &[&str]) -> (String, String, Vec<String>) {
    (label.to_string(), owner.to_string(), tools.iter().map(|tool| (*tool).to_string()).collect())
}

fn infer_goal_risk(title: &str) -> GoalRisk {
    let text = title.to_ascii_lowercase();
    if text.contains("delete") || text.contains("push") || text.contains("install") || text.contains("kill") {
        GoalRisk::High
    } else if text.contains("fix") || text.contains("run") || text.contains("command") || text.contains("write") {
        GoalRisk::Medium
    } else {
        GoalRisk::Low
    }
}

fn goal_status_for_mode(mode: &OperatingMode, risk: &GoalRisk) -> GoalStatus {
    match mode {
        OperatingMode::Passive | OperatingMode::Assisted => GoalStatus::Proposed,
        OperatingMode::Active => {
            if matches!(risk, GoalRisk::Low) {
                GoalStatus::Active
            } else {
                GoalStatus::WaitingApproval
            }
        }
        OperatingMode::Autonomous => {
            if matches!(risk, GoalRisk::Low) {
                GoalStatus::Active
            } else {
                GoalStatus::WaitingApproval
            }
        }
    }
}

fn goal_priority(risk: &GoalRisk) -> u8 {
    match risk {
        GoalRisk::Low => 45,
        GoalRisk::Medium => 65,
        GoalRisk::High => 85,
        GoalRisk::Critical => 95,
    }
}

fn is_low_risk_active_goal(goal: &GoalRecord) -> bool {
    matches!(&goal.status, GoalStatus::Active) && matches!(&goal.risk_level, GoalRisk::Low)
}

fn estimate_cycle_risk(mode: &OperatingMode, goals: &[GoalRecord]) -> f32 {
    let goal_risk = goals
        .iter()
        .take(8)
        .map(|goal| match &goal.risk_level {
            GoalRisk::Low => 0.15,
            GoalRisk::Medium => 0.45,
            GoalRisk::High => 0.75,
            GoalRisk::Critical => 1.0,
        })
        .fold(0.0_f32, f32::max);
    let mode_risk: f32 = match mode {
        OperatingMode::Passive => 0.05,
        OperatingMode::Assisted => 0.18,
        OperatingMode::Active => 0.38,
        OperatingMode::Autonomous => 0.55,
    };
    goal_risk.max(mode_risk).clamp(0.0, 1.0)
}

fn emit_cognitive(services: &BrainServices, event: BrainEvent, source: &str) {
    if let Err(error) = services.bus.emit(event, Some(source.to_string())) {
        tracing::warn!(%error, source, "failed to emit cognitive event");
    }
}

fn build_performance_signals(memory: &MemoryCortex) -> Result<PerformanceSignals> {
    let stats = memory.execution_stats()?;
    let prediction_accuracy = memory.recent_workflow_efficiency_avg(16).unwrap_or(0.62);
    let memory_quality = memory.recent_planning_quality_avg(16).unwrap_or(0.55);
    Ok(PerformanceSignals {
        runs: stats.runs,
        completed: stats.completed,
        failed: stats.failed,
        avg_latency_ms: stats.avg_latency_ms,
        prediction_accuracy,
        memory_quality,
        blocked_actions: stats.blocked_actions,
    })
}

fn run_evolution(services: &BrainServices) -> Result<()> {
    let engine = &services.evolution;
    let signals = build_performance_signals(&services.memory)?;

    for kind in GenomeKind::ALL {
        let incumbent = match services.memory.evolution_champion(kind)? {
            Some(c) => c,
            None => {
                let champion = engine.initial_champion(kind, &signals);
                services.memory.store_evolution_candidate(&champion)?;
                champion
            }
        };

        let gen_index = services.memory.next_evolution_generation_index(kind)?;
        let seed = ((kind as u32 as u64) << 32) | (gen_index as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);

        let generation = engine.evolve_generation(
            &incumbent,
            &signals,
            seed,
            gen_index,
            DEFAULT_POPULATION,
        );

        services.memory.store_evolution_generation(&generation)?;

        for candidate in &generation.population {
            services.memory.store_evolution_candidate(candidate)?;
        }

        let champion = generation
            .population
            .iter()
            .find(|c| c.id == generation.champion_id)
            .expect("champion must exist in population");

        let decision = engine.promote(champion, Some(&incumbent), &services.safety);

        if decision.promoted {
            let promoted = engine.apply_promotion(champion);
            services.memory.store_evolution_candidate(&promoted)?;
            emit_cognitive(
                services,
                BrainEvent::EvolutionPromoted {
                    candidate_id: promoted.id.clone(),
                    genome_kind: kind.as_str().to_string(),
                    margin: decision.margin,
                    reason: decision.reason.clone(),
                    at: Utc::now(),
                },
                "EvolutionEngine",
            );
        }

        emit_cognitive(
            services,
            BrainEvent::EvolutionGenerationCompleted {
                generation_id: generation.id.clone(),
                genome_kind: kind.as_str().to_string(),
                index: generation.index,
                champion_id: champion.id.clone(),
                champion_fitness: champion.fitness.overall,
                summary: generation.summary.clone(),
                at: Utc::now(),
            },
            "EvolutionEngine",
        );

        tracing::debug!(
            kind = %kind.as_str(),
            gen = gen_index,
            champion_fitness = champion.fitness.overall,
            promoted = decision.promoted,
            margin = decision.margin,
            "evolution cycle complete",
        );
    }

    Ok(())
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
struct SkillAgent { services: BrainServices }
impl SkillAgent { fn new(services: BrainServices) -> Self { Self { services } } }
impl Agent for SkillAgent {
    fn name(&self) -> String { "SkillAgent".to_string() }
    fn capabilities(&self) -> Vec<AgentCapability> { vec![AgentCapability::LearnSkills, AgentCapability::WriteMemory] }
    fn init<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> {
        boxed!(ctx.status(&self.name(), AgentState::Idle, Some("skill learning loop ready".to_string())))
    }
    fn handle_event<'a>(&'a self, _ctx: &'a AgentContext, event: BrainEventEnvelope) -> AgentFuture<'a> {
        boxed!({
            match event.event {
                BrainEvent::ActionObserved { actor, action, capability, ok, .. } => {
                    let observed = ObservedAction::new(
                        actor,
                        action,
                        capability,
                        ok,
                        serde_json::json!({ "event_id": event.id }),
                    );
                    self.learn_from_observation(observed)?;
                }
                BrainEvent::WorkflowQueued { agent, action, task_id, .. } => {
                    let observed = ObservedAction::new(
                        agent,
                        action,
                        "schedule.task",
                        true,
                        serde_json::json!({ "task_id": task_id }),
                    );
                    self.learn_from_observation(observed)?;
                }
                _ => {}
            }
            Ok(())
        })
    }
    fn run_task<'a>(&'a self, _ctx: &'a AgentContext, task: AgentTask) -> AgentFuture<'a> {
        boxed!({
            let observed = ObservedAction::new(
                "SkillAgent",
                task.action,
                "memory.store",
                true,
                task.payload,
            );
            self.learn_from_observation(observed)?;
            Ok(())
        })
    }
    fn shutdown<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> { boxed!(ctx.status(&self.name(), AgentState::Stopped, None)) }
}

impl SkillAgent {
    fn learn_from_observation(&self, observed: ObservedAction) -> Result<()> {
        if let Some(candidate) = self.services.skill_learning.observe(observed.clone()) {
            self.services.memory.upsert_learned_skill(&candidate.skill)?;
            self.services.memory.store_skill_version(&candidate.version)?;
            self.services.memory.store_skill_run(&SkillRun {
                id: new_id("skill-run"),
                skill_id: candidate.skill.id.clone(),
                ok: observed.ok,
                input: observed.metadata.clone(),
                output: serde_json::json!({
                    "action": observed.action,
                    "capability": observed.capability,
                    "supporting_actions": candidate.supporting_actions.len(),
                }),
                started_at: observed.occurred_at,
                finished_at: Utc::now(),
            })?;
            if !observed.ok {
                self.services.memory.store_skill_failure(&SkillFailure {
                    id: new_id("skill-failure"),
                    skill_id: candidate.skill.id.clone(),
                    reason: "observed action failed".to_string(),
                    recovery_hint: "pause skill reuse and ask for permission before retry".to_string(),
                    metadata: observed.metadata,
                    created_at: Utc::now(),
                })?;
            }
            self.services.memory.store_memory(memory(
                MemoryKind::Skill,
                Some(candidate.skill.name.clone()),
                format!(
                    "Learned reusable skill '{}' from {} repeated successful actions.",
                    candidate.skill.name,
                    candidate.supporting_actions.len()
                ),
                None,
                vec!["skill-learning".to_string(), "hermes-style".to_string()],
                None,
                candidate.skill.confidence,
            ))?;
            self.services.bus.emit(BrainEvent::SkillLearned {
                skill_id: candidate.skill.id,
                name: candidate.skill.name,
                confidence: candidate.skill.confidence,
                at: Utc::now(),
            }, Some(self.name()))?;
        }
        Ok(())
    }
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
                self.services.bus.emit(BrainEvent::ActionObserved {
                    actor: self.name(),
                    action: tool_name,
                    capability: capability_for_provider(&provider),
                    ok: result.ok,
                    at: Utc::now(),
                }, Some(self.name()))?;
                self.services.bus.emit(BrainEvent::ToolCompleted { result, at: Utc::now() }, Some(self.name()))?;
            }
            Ok(())
        })
    }
    fn run_task<'a>(&'a self, _ctx: &'a AgentContext, _task: AgentTask) -> AgentFuture<'a> { boxed!(Ok(())) }
    fn shutdown<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> { boxed!(ctx.status(&self.name(), AgentState::Stopped, None)) }
}

fn capability_for_provider(provider: &str) -> String {
    match provider {
        "Shell" => "terminal.execute",
        "Python" => "script.run",
        "GitHub" => "api.call",
        "OpenAI" | "Claude" | "Gemini" => "network.cloud-model",
        "Ollama" => "local-ai.call",
        _ => "tool.route",
    }
    .to_string()
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

#[derive(Clone)]
struct WebAgent { services: BrainServices }

impl WebAgent { fn new(services: BrainServices) -> Self { Self { services } } }

impl Agent for WebAgent {
    fn name(&self) -> String { "WebAgent".to_string() }
    fn capabilities(&self) -> Vec<AgentCapability> {
        vec![
            AgentCapability::BrowseWeb,
            AgentCapability::SearchWeb,
            AgentCapability::Research,
            AgentCapability::VerifySources,
            AgentCapability::AnalyzeGitHub,
            AgentCapability::StoreWebKnowledge,
        ]
    }
    fn init<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> { boxed!(ctx.status(&self.name(), AgentState::Idle, None)) }
    fn handle_event<'a>(&'a self, _ctx: &'a AgentContext, event: BrainEventEnvelope) -> AgentFuture<'a> {
        let services = self.services.clone();
        let agent_name = self.name();
        let ev = event.event;
        Box::pin(async move {
            match ev {
                BrainEvent::WebSearchRequested { request, at } => {
                    let query = match request.kind.query() {
                        Some(q) => q,
                        None => return Ok(()),
                    };
                    match services.web_cortex.search(&query).await {
                        Ok(resp) => {
                            let sources: Vec<String> = resp.results.iter().map(|r| r.url.clone()).collect();
                            services.bus.emit(BrainEvent::WebSearchPerformed {
                                query,
                                result_count: resp.results.len(),
                                sources,
                                at,
                            }, Some(agent_name.clone()))?;
                            services.bus.emit(BrainEvent::ActionObserved {
                                actor: agent_name.clone(),
                                action: "web_search".to_string(),
                                capability: "web.search".to_string(),
                                ok: true,
                                at,
                            }, Some(agent_name))?;
                        }
                        Err(e) => {
                            services.bus.emit(BrainEvent::Error {
                                source: agent_name.clone(),
                                message: e.to_string(),
                                at,
                            }, Some(agent_name))?;
                        }
                    }
                }
                BrainEvent::WebFetchRequested { request, at } => {
                    let url = match request.kind.url() {
                        Some(u) => u,
                        None => return Ok(()),
                    };
                    match services.web_cortex.fetch_page(&url).await {
                        Ok(result) => {
                            services.bus.emit(BrainEvent::WebPageFetched {
                                url: url.clone(),
                                title: result.title,
                                word_count: result.content.split_whitespace().count(),
                                sanitized: result.sanitized_content,
                                at,
                            }, Some(agent_name.clone()))?;
                        }
                        Err(e) => {
                            services.bus.emit(BrainEvent::Error {
                                source: agent_name.clone(),
                                message: e.to_string(),
                                at,
                            }, Some(agent_name))?;
                        }
                    }
                }
                BrainEvent::WebResearchRequested { request, at } => {
                    let query = match request.kind.query() {
                        Some(q) => q,
                        None => return Ok(()),
                    };
                    let depth = request.kind.research_depth().unwrap_or(3);
                    let mut all_sources = Vec::new();
                    let mut credibility_sum = 0.0_f32;
                    let mut source_count = 0usize;

                    let engines: Vec<&str> = if depth >= 3 {
                        vec!["duckduckgo", "github", "crates"]
                    } else {
                        vec!["duckduckgo"]
                    };
                    for resp in services.web_cortex.search_multi_engine(&query, &engines).await {
                        for r in &resp.results {
                            all_sources.push(r.url.clone());
                            source_count += 1;
                        }
                    }

                    for url in all_sources.iter().take(5) {
                        if let Ok(result) = services.web_cortex.fetch_page(url).await {
                            credibility_sum += result.credibility_score();
                        }
                    }

                    let credibility_avg = if source_count > 0 { credibility_sum / source_count as f32 } else { 0.0 };
                    let summary = format!("Research on '{}': {} sources, avg credibility {:.2}", query, source_count, credibility_avg);

                    services.bus.emit(BrainEvent::WebResearchCompleted {
                        topic: query,
                        source_count,
                        credibility_avg,
                        summary,
                        knowledge_stored: false,
                        at,
                    }, Some(agent_name.clone()))?;
                }
                BrainEvent::GitHubAnalysisRequested { request, at } => {
                    let repo = match request.kind.repo() {
                        Some(r) => r,
                        None => return Ok(()),
                    };
                    match services.web_cortex.fetch_github_repo(&repo).await {
                        Ok(info) => {
                            let stars_str = info.stars.map(|s| s.to_string()).unwrap_or_default();
                            services.bus.emit(BrainEvent::GitHubAnalyzed {
                                repo: info.full_name.clone(),
                                stars: info.stars,
                                language: info.language.clone(),
                                summary: format!("{} - {} ({} stars)", info.full_name, info.description.as_deref().unwrap_or(""), stars_str),
                                at,
                            }, Some(agent_name.clone()))?;
                        }
                        Err(e) => {
                            services.bus.emit(BrainEvent::Error {
                                source: agent_name.clone(),
                                message: e.to_string(),
                                at,
                            }, Some(agent_name))?;
                        }
                    }
                }
                _ => {}
            }
            Ok(())
        })
    }
    fn run_task<'a>(&'a self, _ctx: &'a AgentContext, _task: AgentTask) -> AgentFuture<'a> { boxed!(Ok(())) }
    fn shutdown<'a>(&'a self, ctx: &'a AgentContext) -> AgentFuture<'a> { boxed!(ctx.status(&self.name(), AgentState::Stopped, None)) }
}
