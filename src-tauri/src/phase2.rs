use brain_autonomous_runtime::{AutonomousRuntime, AutonomousTask, AutonomousTaskKind, ScheduleSpec};
use chrono::{DateTime, Duration, Utc};
use brain_context_engine::{ContextEngine, ContextSignal, ContextSignalKind, ContextSnapshot, MemoryReference};
use brain_knowledge_graph::{GraphEdgeKind, GraphNodeKind, KnowledgeGraph};
use parking_lot::Mutex;
use brain_personality_engine::{MoodEngine, MoodInput, PersonalityState};
use rusqlite::{params, Connection, OptionalExtension, Result as SqliteResult};
use brain_semantic_memory::{
    EmbeddingProvider, EmbeddingVector, HashedEmbeddingProvider, SemanticMemoryCortex,
    SemanticMemoryRecord, SemanticSearchHit, SemanticSearchQuery, VectorBackend,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;
use brain_temporal_engine::{TemporalEvent, TemporalEventKind};
use uuid::Uuid;
use brain_workflow_engine::{TaskState, WorkflowEngine, WorkflowTask};

pub type SharedPhase2System = Arc<Mutex<Phase2System>>;

pub struct Phase2System {
    conn: Connection,
    semantic: SemanticMemoryCortex<HashedEmbeddingProvider>,
    graph: KnowledgeGraph,
    context: ContextEngine,
    workflow: WorkflowEngine,
    mood: MoodEngine,
    autonomous: AutonomousRuntime,
    backend: VectorBackend,
}

#[derive(Debug, Clone, Serialize)]
pub struct Phase2Status {
    pub semantic_memories: i64,
    pub graph_nodes: i64,
    pub graph_edges: i64,
    pub timeline_events: i64,
    pub pending_workflows: i64,
    pub autonomous_tasks: i64,
    pub backend: VectorBackend,
    pub mood: PersonalityState,
    pub generated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SemanticIngestInput {
    pub content: String,
    #[serde(rename = "memoryType")]
    pub memory_type: Option<String>,
    #[serde(rename = "projectName")]
    pub project_name: Option<String>,
    #[serde(rename = "sourcePath")]
    pub source_path: Option<String>,
    pub tags: Option<Vec<String>>,
    pub importance: Option<f32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SemanticIngestOutput {
    pub memory: SemanticMemoryRecord,
    pub graph_nodes_touched: usize,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SemanticSearchInput {
    pub query: String,
    pub limit: Option<usize>,
    #[serde(rename = "minScore")]
    pub min_score: Option<f32>,
    #[serde(rename = "projectName")]
    pub project_name: Option<String>,
    #[serde(rename = "memoryType")]
    pub memory_type: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SemanticSearchOutput {
    pub hits: Vec<SemanticSearchHit>,
    pub searched: usize,
    pub backend: VectorBackend,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GraphSnapshotInput {
    #[serde(rename = "projectName")]
    pub project_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphNodeDto {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub project: Option<String>,
    pub metadata: Value,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphEdgeDto {
    pub id: String,
    #[serde(rename = "fromId")]
    pub from_id: String,
    #[serde(rename = "toId")]
    pub to_id: String,
    pub kind: String,
    pub weight: f32,
    pub metadata: Value,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphSnapshotOutput {
    pub nodes: Vec<GraphNodeDto>,
    pub edges: Vec<GraphEdgeDto>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ContextSnapshotInput {
    #[serde(rename = "projectPath")]
    pub project_path: Option<String>,
    #[serde(rename = "projectName")]
    pub project_name: Option<String>,
    #[serde(rename = "activeFiles")]
    pub active_files: Option<Vec<String>>,
    pub prompt: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TimelineEventInput {
    #[serde(rename = "projectName")]
    pub project_name: Option<String>,
    pub kind: String,
    pub title: String,
    pub detail: String,
    #[serde(rename = "relatedPath")]
    pub related_path: Option<String>,
    #[serde(rename = "relatedMemoryId")]
    pub related_memory_id: Option<String>,
    pub importance: Option<f32>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TimelineRecentInput {
    #[serde(rename = "projectName")]
    pub project_name: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WorkflowEnqueueInput {
    #[serde(rename = "workflowId")]
    pub workflow_id: Option<String>,
    pub agent: String,
    pub action: String,
    pub priority: Option<u8>,
    pub payload: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WorkflowCompleteInput {
    #[serde(rename = "taskId")]
    pub task_id: String,
    pub detail: Option<String>,
    pub failed: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkflowLogDto {
    pub id: String,
    #[serde(rename = "taskId")]
    pub task_id: String,
    pub agent: String,
    pub event: String,
    pub detail: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkflowSnapshotOutput {
    pub tasks: Vec<WorkflowTask>,
    pub logs: Vec<WorkflowLogDto>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MoodActivityInput {
    pub activity: String,
    pub workload: Option<f32>,
    #[serde(rename = "agentCount")]
    pub agent_count: Option<usize>,
    #[serde(rename = "errorCount")]
    pub error_count: Option<usize>,
    #[serde(rename = "projectName")]
    pub project_name: Option<String>,
    pub novelty: Option<f32>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AutonomousTaskInput {
    pub kind: Option<String>,
    pub title: String,
    #[serde(rename = "intervalMinutes")]
    pub interval_minutes: Option<i64>,
    pub priority: Option<u8>,
    pub payload: Option<Value>,
}

impl Phase2System {
    fn new(db_path: &Path) -> SqliteResult<Self> {
        let conn = Connection::open(db_path)?;
        initialize_phase2_schema(&conn)?;
        let mut mood = MoodEngine::new();
        if let Some(state) = load_latest_personality_state(&conn)? {
            mood.set_state(state);
        }
        Ok(Self {
            conn,
            semantic: SemanticMemoryCortex::new(HashedEmbeddingProvider::new(384)),
            graph: KnowledgeGraph::new(),
            context: ContextEngine::new(),
            workflow: WorkflowEngine::new(),
            mood,
            autonomous: AutonomousRuntime::new(),
            backend: VectorBackend::LocalSqlite,
        })
    }

    fn status(&self) -> Result<Phase2Status, String> {
        Ok(Phase2Status {
            semantic_memories: count_table(&self.conn, "memory_embeddings")?,
            graph_nodes: count_table(&self.conn, "graph_nodes")?,
            graph_edges: count_table(&self.conn, "graph_edges")?,
            timeline_events: count_table(&self.conn, "project_timelines")?,
            pending_workflows: count_where(&self.conn, "workflow_tasks", "state = 'pending'")?,
            autonomous_tasks: count_table(&self.conn, "autonomous_tasks")?,
            backend: self.backend.clone(),
            mood: self.mood.state().clone(),
            generated_at: Utc::now().to_rfc3339(),
        })
    }

    fn ingest_semantic(&mut self, input: SemanticIngestInput) -> Result<SemanticIngestOutput, String> {
        let content = input.content.trim();
        if content.is_empty() {
            return Err("content is required".to_string());
        }

        let now = Utc::now().to_rfc3339();
        let id = Uuid::new_v4().to_string();
        let record = self
            .semantic
            .ingest_text(
                id,
                content.to_string(),
                input.memory_type.unwrap_or_else(|| "manual".to_string()),
                input.project_name.clone(),
                input.source_path.clone(),
                input.tags.unwrap_or_default(),
                input.importance.unwrap_or(0.62),
                now.clone(),
            )
            .map_err(|e| e.to_string())?;

        insert_memory_point_compat(&self.conn, &record)?;
        upsert_embedding(&self.conn, &record)?;

        let touched = self.graph.ingest_memory(
            &record.id,
            record.project_name.as_deref(),
            record.source_path.as_deref(),
            &record.content,
        );
        persist_graph(&self.conn, &self.graph)?;

        let mut event = TemporalEvent::new(
            record.project_name.clone(),
            TemporalEventKind::MemoryCreated,
            "Semantic memory indexed",
            preview(&record.content, 180),
            record.importance,
        );
        event.related_memory_id = Some(record.id.clone());
        event.related_path = record.source_path.clone();
        persist_temporal_event(&self.conn, &event)?;

        let mood = self.mood.update(MoodInput {
            activity: "semantic memory indexed".to_string(),
            workload: 0.48,
            agent_count: 1,
            error_count: 0,
            project_name: record.project_name.clone(),
            novelty: 0.55,
        });
        persist_personality_state(&self.conn, &mood)?;

        Ok(SemanticIngestOutput {
            memory: record,
            graph_nodes_touched: touched.len(),
        })
    }

    fn search_semantic(&mut self, input: SemanticSearchInput) -> Result<SemanticSearchOutput, String> {
        let records = load_semantic_records(&self.conn)?;
        let mut cortex = SemanticMemoryCortex::new(HashedEmbeddingProvider::new(self.semantic.provider().dimensions()));
        for record in records {
            cortex.upsert(record);
        }

        let query = SemanticSearchQuery {
            text: input.query,
            limit: input.limit.unwrap_or(12),
            min_score: input.min_score.unwrap_or(0.18),
            project_name: input.project_name,
            memory_type: input.memory_type,
        };

        let hits = cortex.search(query).map_err(|e| e.to_string())?;
        for hit in &hits {
            record_temporal_access(&self.conn, &hit.memory_id, hit.score)?;
        }

        Ok(SemanticSearchOutput {
            searched: count_table(&self.conn, "memory_embeddings")? as usize,
            hits,
            backend: self.backend.clone(),
        })
    }

    fn context_snapshot(&mut self, input: ContextSnapshotInput) -> Result<ContextSnapshot, String> {
        let related_memories = if let Some(prompt) = input.prompt.clone().filter(|p| !p.trim().is_empty()) {
            self.search_semantic(SemanticSearchInput {
                query: prompt,
                limit: Some(8),
                min_score: Some(0.12),
                project_name: input.project_name.clone(),
                memory_type: None,
            })?
            .hits
            .into_iter()
            .map(|hit| MemoryReference {
                id: hit.memory_id,
                score: hit.score,
                reason: hit.reasons.join(", "),
            })
            .collect::<Vec<_>>()
        } else {
            Vec::new()
        };

        let mut signals = Vec::new();
        if let Some(prompt) = &input.prompt {
            signals.push(ContextSignal {
                kind: ContextSignalKind::UserPrompt,
                project_path: input.project_path.clone(),
                detail: prompt.clone(),
                weight: 0.8,
                observed_at: Utc::now(),
            });
        }
        for file in input.active_files.clone().unwrap_or_default() {
            signals.push(ContextSignal {
                kind: ContextSignalKind::ActiveFile,
                project_path: input.project_path.clone(),
                detail: file,
                weight: 0.65,
                observed_at: Utc::now(),
            });
        }

        let snapshot = self.context.build_snapshot(
            input.project_path,
            input.project_name,
            input.active_files.unwrap_or_default(),
            related_memories,
            signals,
        );
        persist_context_snapshot(&self.conn, &snapshot)?;
        Ok(snapshot)
    }

    fn record_timeline_event(&mut self, input: TimelineEventInput) -> Result<TemporalEvent, String> {
        let kind = parse_temporal_kind(&input.kind);
        let mut event = TemporalEvent::new(
            input.project_name.clone(),
            kind.clone(),
            input.title,
            input.detail,
            input.importance.unwrap_or(0.55),
        );
        event.related_path = input.related_path;
        event.related_memory_id = input.related_memory_id;
        persist_temporal_event(&self.conn, &event)?;

        if let Some(project) = event.project_name.clone() {
            let project_node = self.graph.upsert_node(
                GraphNodeKind::Project,
                project.clone(),
                Some(project.clone()),
                serde_json::json!({ "source": "timeline" }),
            );
            let kind = match kind {
                TemporalEventKind::BugObserved => GraphNodeKind::Bug,
                TemporalEventKind::CommitCreated => GraphNodeKind::Commit,
                TemporalEventKind::SummaryCreated => GraphNodeKind::Summary,
                TemporalEventKind::WorkflowRan => GraphNodeKind::Agent,
                _ => GraphNodeKind::Discussion,
            };
            let event_node = self.graph.upsert_node(
                kind,
                event.title.clone(),
                Some(project),
                serde_json::json!({
                    "timeline_id": event.id,
                    "detail": event.detail,
                    "occurred_at": event.occurred_at,
                }),
            );
            self.graph.upsert_edge(
                project_node.id,
                event_node.id,
                GraphEdgeKind::Contains,
                event.importance,
                serde_json::json!({ "source": "timeline" }),
            );
            persist_graph(&self.conn, &self.graph)?;
        }

        if matches!(kind, TemporalEventKind::FileModified | TemporalEventKind::SessionEnded) {
            let tasks = self.workflow.trigger(
                "activity-observed",
                serde_json::json!({
                    "projectName": event.project_name,
                    "title": event.title,
                    "detail": event.detail,
                    "timelineId": event.id,
                }),
            );
            for task in tasks {
                persist_workflow_task(&self.conn, &task)?;
                persist_workflow_log(
                    &self.conn,
                    &task.id,
                    &task.agent,
                    "queued",
                    "Queued by timeline event trigger",
                )?;
            }
        }

        Ok(event)
    }

    fn recent_timeline(&self, input: TimelineRecentInput) -> Result<Vec<TemporalEvent>, String> {
        load_recent_timeline(&self.conn, input.project_name.as_deref(), input.limit.unwrap_or(30))
    }

    fn enqueue_workflow(&mut self, input: WorkflowEnqueueInput) -> Result<WorkflowTask, String> {
        let task = self.workflow.enqueue(
            input.workflow_id,
            input.agent,
            input.action,
            input.priority.unwrap_or(50),
            input.payload.unwrap_or_else(|| serde_json::json!({})),
        );
        persist_workflow_task(&self.conn, &task)?;
        persist_workflow_log(&self.conn, &task.id, &task.agent, "queued", "Task queued")?;
        Ok(task)
    }

    fn next_workflow_task(&self) -> Result<Option<WorkflowTask>, String> {
        let row = self
            .conn
            .query_row(
                "SELECT id, workflow_id, agent, action, priority, state, payload, attempts, created_at, updated_at
                 FROM workflow_tasks
                 WHERE state = 'pending'
                 ORDER BY priority DESC, created_at ASC
                 LIMIT 1",
                [],
                workflow_task_from_row,
            )
            .optional()
            .map_err(|e| e.to_string())?;

        let Some(mut task) = row else {
            return Ok(None);
        };
        task.state = TaskState::Running;
        task.attempts += 1;
        task.updated_at = Utc::now();
        persist_workflow_task(&self.conn, &task)?;
        persist_workflow_log(&self.conn, &task.id, &task.agent, "started", "Task started")?;
        Ok(Some(task))
    }

    fn complete_workflow(&self, input: WorkflowCompleteInput) -> Result<Option<WorkflowTask>, String> {
        let row = self
            .conn
            .query_row(
                "SELECT id, workflow_id, agent, action, priority, state, payload, attempts, created_at, updated_at
                 FROM workflow_tasks
                 WHERE id = ?1",
                [input.task_id.clone()],
                workflow_task_from_row,
            )
            .optional()
            .map_err(|e| e.to_string())?;

        let Some(mut task) = row else {
            return Ok(None);
        };
        task.state = if input.failed.unwrap_or(false) {
            TaskState::Failed
        } else {
            TaskState::Completed
        };
        task.updated_at = Utc::now();
        persist_workflow_task(&self.conn, &task)?;
        persist_workflow_log(
            &self.conn,
            &task.id,
            &task.agent,
            if input.failed.unwrap_or(false) { "failed" } else { "completed" },
            input.detail.as_deref().unwrap_or("Task finished"),
        )?;
        Ok(Some(task))
    }

    fn workflow_snapshot(&self) -> Result<WorkflowSnapshotOutput, String> {
        let mut task_stmt = self
            .conn
            .prepare(
                "SELECT id, workflow_id, agent, action, priority, state, payload, attempts, created_at, updated_at
                 FROM workflow_tasks
                 ORDER BY updated_at DESC
                 LIMIT 50",
            )
            .map_err(|e| e.to_string())?;
        let tasks = task_stmt
            .query_map([], workflow_task_from_row)
            .map_err(|e| e.to_string())?
            .collect::<SqliteResult<Vec<_>>>()
            .map_err(|e| e.to_string())?;

        let mut log_stmt = self
            .conn
            .prepare(
                "SELECT id, task_id, agent, event, detail, created_at
                 FROM workflow_logs
                 ORDER BY created_at DESC
                 LIMIT 50",
            )
            .map_err(|e| e.to_string())?;
        let logs = log_stmt
            .query_map([], |row| {
                Ok(WorkflowLogDto {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    agent: row.get(2)?,
                    event: row.get(3)?,
                    detail: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<SqliteResult<Vec<_>>>()
            .map_err(|e| e.to_string())?;

        Ok(WorkflowSnapshotOutput { tasks, logs })
    }

    fn update_mood(&mut self, input: MoodActivityInput) -> Result<PersonalityState, String> {
        let state = self.mood.update(MoodInput {
            activity: input.activity,
            workload: input.workload.unwrap_or(0.4),
            agent_count: input.agent_count.unwrap_or(0),
            error_count: input.error_count.unwrap_or(0),
            project_name: input.project_name,
            novelty: input.novelty.unwrap_or(0.25),
        });
        persist_personality_state(&self.conn, &state)?;
        Ok(state)
    }

    fn schedule_autonomous_task(&mut self, input: AutonomousTaskInput) -> Result<AutonomousTask, String> {
        let minutes = input.interval_minutes.unwrap_or(1_440).max(1);
        let kind = parse_autonomous_kind(input.kind.as_deref());
        let task = AutonomousTask::new(
            kind,
            input.title,
            ScheduleSpec::IntervalMinutes(minutes),
            Utc::now() + Duration::minutes(minutes),
            input.priority.unwrap_or(40),
            input.payload.unwrap_or_else(|| serde_json::json!({})),
        );
        self.autonomous.upsert(task.clone());
        persist_autonomous_task(&self.conn, &task)?;
        Ok(task)
    }

    fn due_autonomous_tasks(&self) -> Result<Vec<AutonomousTask>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT task_json
                 FROM autonomous_tasks
                 WHERE enabled = 1 AND next_run_at <= ?1
                 ORDER BY priority DESC, next_run_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([Utc::now().to_rfc3339()], |row| {
                let json: String = row.get(0)?;
                serde_json::from_str::<AutonomousTask>(&json)
                    .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<SqliteResult<Vec<_>>>()
            .map_err(|e| e.to_string())
    }
}

pub fn create_phase2_system(data_dir: &Path) -> std::io::Result<SharedPhase2System> {
    std::fs::create_dir_all(data_dir)?;
    let db_path = data_dir.join("brain_memory.sqlite");
    let system = Phase2System::new(&db_path)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    Ok(Arc::new(Mutex::new(system)))
}

#[tauri::command]
pub fn phase2_status(system: tauri::State<'_, SharedPhase2System>) -> Result<Phase2Status, String> {
    system.lock().status()
}

#[tauri::command]
pub fn semantic_memory_ingest(
    input: SemanticIngestInput,
    system: tauri::State<'_, SharedPhase2System>,
) -> Result<SemanticIngestOutput, String> {
    system.lock().ingest_semantic(input)
}

#[tauri::command]
pub fn semantic_memory_search(
    input: SemanticSearchInput,
    system: tauri::State<'_, SharedPhase2System>,
) -> Result<SemanticSearchOutput, String> {
    system.lock().search_semantic(input)
}

#[tauri::command]
pub fn knowledge_graph_snapshot(
    input: GraphSnapshotInput,
    system: tauri::State<'_, SharedPhase2System>,
) -> Result<GraphSnapshotOutput, String> {
    let system = system.lock();
    load_graph_snapshot(&system.conn, input.project_name)
}

#[tauri::command]
pub fn context_engine_snapshot(
    input: ContextSnapshotInput,
    system: tauri::State<'_, SharedPhase2System>,
) -> Result<ContextSnapshot, String> {
    system.lock().context_snapshot(input)
}

#[tauri::command]
pub fn record_project_timeline_event(
    input: TimelineEventInput,
    system: tauri::State<'_, SharedPhase2System>,
) -> Result<TemporalEvent, String> {
    system.lock().record_timeline_event(input)
}

#[tauri::command]
pub fn project_timeline_recent(
    input: TimelineRecentInput,
    system: tauri::State<'_, SharedPhase2System>,
) -> Result<Vec<TemporalEvent>, String> {
    system.lock().recent_timeline(input)
}

#[tauri::command]
pub fn workflow_enqueue(
    input: WorkflowEnqueueInput,
    system: tauri::State<'_, SharedPhase2System>,
) -> Result<WorkflowTask, String> {
    system.lock().enqueue_workflow(input)
}

#[tauri::command]
pub fn workflow_next_task(
    system: tauri::State<'_, SharedPhase2System>,
) -> Result<Option<WorkflowTask>, String> {
    system.lock().next_workflow_task()
}

#[tauri::command]
pub fn workflow_complete(
    input: WorkflowCompleteInput,
    system: tauri::State<'_, SharedPhase2System>,
) -> Result<Option<WorkflowTask>, String> {
    system.lock().complete_workflow(input)
}

#[tauri::command]
pub fn workflow_snapshot(
    system: tauri::State<'_, SharedPhase2System>,
) -> Result<WorkflowSnapshotOutput, String> {
    system.lock().workflow_snapshot()
}

#[tauri::command]
pub fn pet_personality_state(
    system: tauri::State<'_, SharedPhase2System>,
) -> Result<PersonalityState, String> {
    Ok(system.lock().mood.state().clone())
}

#[tauri::command]
pub fn update_pet_activity(
    input: MoodActivityInput,
    system: tauri::State<'_, SharedPhase2System>,
) -> Result<PersonalityState, String> {
    system.lock().update_mood(input)
}

#[tauri::command]
pub fn autonomous_schedule_task(
    input: AutonomousTaskInput,
    system: tauri::State<'_, SharedPhase2System>,
) -> Result<AutonomousTask, String> {
    system.lock().schedule_autonomous_task(input)
}

#[tauri::command]
pub fn autonomous_due_tasks(
    system: tauri::State<'_, SharedPhase2System>,
) -> Result<Vec<AutonomousTask>, String> {
    system.lock().due_autonomous_tasks()
}

fn initialize_phase2_schema(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS memory_embeddings (
            id TEXT PRIMARY KEY,
            memory_id TEXT NOT NULL UNIQUE,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            dimensions INTEGER NOT NULL,
            vector TEXT NOT NULL,
            vector_backend TEXT NOT NULL DEFAULT 'local-sqlite',
            qdrant_point_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_embeddings_memory ON memory_embeddings(memory_id);

        CREATE TABLE IF NOT EXISTS semantic_clusters (
            id TEXT PRIMARY KEY,
            topic TEXT NOT NULL,
            memory_ids TEXT NOT NULL DEFAULT '[]',
            centroid TEXT NOT NULL DEFAULT '[]',
            coherence REAL NOT NULL DEFAULT 0.0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS graph_nodes (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            label TEXT NOT NULL,
            project TEXT,
            metadata TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_graph_nodes_kind ON graph_nodes(kind);
        CREATE INDEX IF NOT EXISTS idx_graph_nodes_project ON graph_nodes(project);

        CREATE TABLE IF NOT EXISTS graph_edges (
            id TEXT PRIMARY KEY,
            from_id TEXT NOT NULL,
            to_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            weight REAL NOT NULL DEFAULT 0.5,
            metadata TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_id);
        CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_id);

        CREATE TABLE IF NOT EXISTS context_snapshots (
            id TEXT PRIMARY KEY,
            project_path TEXT,
            project_name TEXT,
            active_files TEXT NOT NULL DEFAULT '[]',
            related_memories TEXT NOT NULL DEFAULT '[]',
            relevant_tools TEXT NOT NULL DEFAULT '[]',
            likely_intent TEXT NOT NULL,
            confidence REAL NOT NULL,
            summary TEXT NOT NULL,
            metadata TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_context_project ON context_snapshots(project_name, created_at DESC);

        CREATE TABLE IF NOT EXISTS project_timelines (
            id TEXT PRIMARY KEY,
            project_name TEXT,
            kind TEXT NOT NULL,
            title TEXT NOT NULL,
            detail TEXT NOT NULL,
            related_path TEXT,
            related_memory_id TEXT,
            importance REAL NOT NULL DEFAULT 0.5,
            occurred_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_project_timelines_project ON project_timelines(project_name, occurred_at DESC);

        CREATE TABLE IF NOT EXISTS architecture_snapshots (
            id TEXT PRIMARY KEY,
            project_name TEXT NOT NULL,
            snapshot_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS workflow_tasks (
            id TEXT PRIMARY KEY,
            workflow_id TEXT,
            agent TEXT NOT NULL,
            action TEXT NOT NULL,
            priority INTEGER NOT NULL DEFAULT 50,
            state TEXT NOT NULL,
            payload TEXT NOT NULL DEFAULT '{}',
            attempts INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_workflow_tasks_state ON workflow_tasks(state, priority DESC, created_at ASC);

        CREATE TABLE IF NOT EXISTS workflow_logs (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            agent TEXT NOT NULL,
            event TEXT NOT NULL,
            detail TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_workflow_logs_task ON workflow_logs(task_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS personality_states (
            id TEXT PRIMARY KEY,
            mood TEXT NOT NULL,
            state_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS autonomous_tasks (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            title TEXT NOT NULL,
            schedule_json TEXT NOT NULL,
            task_json TEXT NOT NULL,
            next_run_at TEXT NOT NULL,
            last_run_at TEXT,
            priority INTEGER NOT NULL DEFAULT 40,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_autonomous_due ON autonomous_tasks(enabled, next_run_at, priority DESC);

        CREATE TABLE IF NOT EXISTS temporal_metadata (
            id TEXT PRIMARY KEY,
            entity_id TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            last_seen_at TEXT NOT NULL,
            access_count INTEGER NOT NULL DEFAULT 0,
            importance REAL NOT NULL DEFAULT 0.5,
            decay_score REAL NOT NULL DEFAULT 1.0,
            metadata TEXT NOT NULL DEFAULT '{}'
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_temporal_metadata_entity ON temporal_metadata(entity_id, entity_type);

        CREATE TABLE IF NOT EXISTS memory_evolution_events (
            id TEXT PRIMARY KEY,
            event_type TEXT NOT NULL,
            source_memory_ids TEXT NOT NULL DEFAULT '[]',
            output_memory_id TEXT,
            detail TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS project_milestones (
            id TEXT PRIMARY KEY,
            project_name TEXT NOT NULL,
            title TEXT NOT NULL,
            detail TEXT NOT NULL,
            reached_at TEXT NOT NULL,
            metadata TEXT NOT NULL DEFAULT '{}'
        );
        "#,
    )
}

fn insert_memory_point_compat(conn: &Connection, record: &SemanticMemoryRecord) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    if table_has_column(conn, "memory_points", "source_type").map_err(|e| e.to_string())? {
        let hash = stable_content_hash(&record.content);
        conn.execute(
            "INSERT OR REPLACE INTO memory_points
             (id, source_type, file_path, project_name, title, content, content_hash, embedding_id, importance, created_at, updated_at, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?9, ?10, ?11)",
            params![
                record.id,
                normalize_source_type(&record.memory_type),
                record.source_path,
                record.project_name,
                record.tags.first().cloned(),
                record.content,
                hash,
                record.importance,
                record.created_at,
                now,
                serde_json::json!({ "tags": record.tags }).to_string(),
            ],
        )
        .map_err(|e| e.to_string())?;
    } else {
        conn.execute(
            "INSERT OR REPLACE INTO memory_points
             (id, content, memory_type, tags, source_path, created_at, accessed_at, access_count, importance, embedding)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9)",
            params![
                record.id,
                record.content,
                record.memory_type,
                serde_json::to_string(&record.tags).unwrap_or_else(|_| "[]".to_string()),
                record.source_path,
                record.created_at,
                now,
                record.importance,
                serde_json::to_string(&record.embedding.values).unwrap_or_else(|_| "[]".to_string()),
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn upsert_embedding(conn: &Connection, record: &SemanticMemoryRecord) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR REPLACE INTO memory_embeddings
         (id, memory_id, provider, model, dimensions, vector, vector_backend, created_at, updated_at)
         VALUES (
            COALESCE((SELECT id FROM memory_embeddings WHERE memory_id = ?1), ?2),
            ?1, ?3, ?4, ?5, ?6, 'local-sqlite',
            COALESCE((SELECT created_at FROM memory_embeddings WHERE memory_id = ?1), ?7),
            ?8
         )",
        params![
            record.id,
            Uuid::new_v4().to_string(),
            "local",
            record.embedding.model,
            record.embedding.dimensions as i64,
            serde_json::to_string(&record.embedding.values).unwrap_or_else(|_| "[]".to_string()),
            now,
            Utc::now().to_rfc3339(),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn load_semantic_records(conn: &Connection) -> Result<Vec<SemanticMemoryRecord>, String> {
    let server_shape = table_has_column(conn, "memory_points", "source_type").map_err(|e| e.to_string())?;
    let sql = if server_shape {
        "SELECT m.id, m.content, m.source_type, m.project_name, m.file_path, m.importance, m.created_at,
                e.model, e.dimensions, e.vector, COALESCE(m.metadata, '{}')
         FROM memory_embeddings e
         JOIN memory_points m ON m.id = e.memory_id"
    } else {
        "SELECT m.id, m.content, m.memory_type, NULL, m.source_path, m.importance, m.created_at,
                e.model, e.dimensions, e.vector, m.tags
         FROM memory_embeddings e
         JOIN memory_points m ON m.id = e.memory_id"
    };

    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let vector_json: String = row.get(9)?;
            let metadata_or_tags: String = row.get(10)?;
            let tags = if server_shape {
                serde_json::from_str::<Value>(&metadata_or_tags)
                    .ok()
                    .and_then(|v| v.get("tags").cloned())
                    .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
                    .unwrap_or_default()
            } else {
                serde_json::from_str::<Vec<String>>(&metadata_or_tags).unwrap_or_default()
            };
            Ok(SemanticMemoryRecord {
                id: row.get(0)?,
                content: row.get(1)?,
                memory_type: row.get(2)?,
                project_name: row.get(3)?,
                source_path: row.get(4)?,
                importance: row.get::<_, f32>(5)?.clamp(0.0, 1.0),
                created_at: row.get(6)?,
                tags,
                embedding: EmbeddingVector {
                    model: row.get(7)?,
                    dimensions: row.get::<_, i64>(8)? as usize,
                    values: serde_json::from_str(&vector_json).unwrap_or_default(),
                },
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<SqliteResult<Vec<_>>>()
        .map_err(|e| e.to_string())
}

fn persist_graph(conn: &Connection, graph: &KnowledgeGraph) -> Result<(), String> {
    for node in graph.nodes() {
        conn.execute(
            "INSERT OR REPLACE INTO graph_nodes
             (id, kind, label, project, metadata, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                node.id,
                enum_to_string(&node.kind),
                node.label,
                node.project,
                node.metadata.to_string(),
                node.created_at.to_rfc3339(),
                node.updated_at.to_rfc3339(),
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    for edge in graph.edges() {
        conn.execute(
            "INSERT OR REPLACE INTO graph_edges
             (id, from_id, to_id, kind, weight, metadata, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                edge.id,
                edge.from_id,
                edge.to_id,
                enum_to_string(&edge.kind),
                edge.weight,
                edge.metadata.to_string(),
                edge.created_at.to_rfc3339(),
                edge.updated_at.to_rfc3339(),
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn load_graph_snapshot(conn: &Connection, project_name: Option<String>) -> Result<GraphSnapshotOutput, String> {
    let (node_sql, edge_sql) = if project_name.is_some() {
        (
            "SELECT id, kind, label, project, metadata, updated_at FROM graph_nodes WHERE project = ?1 ORDER BY updated_at DESC LIMIT 400",
            "SELECT e.id, e.from_id, e.to_id, e.kind, e.weight, e.metadata, e.updated_at
             FROM graph_edges e
             JOIN graph_nodes n ON n.id = e.from_id OR n.id = e.to_id
             WHERE n.project = ?1
             GROUP BY e.id
             ORDER BY e.updated_at DESC LIMIT 600",
        )
    } else {
        (
            "SELECT id, kind, label, project, metadata, updated_at FROM graph_nodes ORDER BY updated_at DESC LIMIT 400",
            "SELECT id, from_id, to_id, kind, weight, metadata, updated_at FROM graph_edges ORDER BY updated_at DESC LIMIT 600",
        )
    };

    let nodes = query_nodes(conn, node_sql, project_name.as_deref())?;
    let edges = query_edges(conn, edge_sql, project_name.as_deref())?;

    Ok(GraphSnapshotOutput { nodes, edges })
}

fn query_nodes(conn: &Connection, sql: &str, project: Option<&str>) -> Result<Vec<GraphNodeDto>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let map_row = |row: &rusqlite::Row<'_>| {
        let metadata: String = row.get(4)?;
        Ok(GraphNodeDto {
            id: row.get(0)?,
            kind: row.get(1)?,
            label: row.get(2)?,
            project: row.get(3)?,
            metadata: serde_json::from_str(&metadata).unwrap_or_else(|_| serde_json::json!({})),
            updated_at: row.get(5)?,
        })
    };
    if let Some(project) = project {
        let rows = stmt
            .query_map([project], map_row)
            .map_err(|e| e.to_string())?;
        rows.collect::<SqliteResult<Vec<_>>>()
            .map_err(|e| e.to_string())
    } else {
        let rows = stmt
            .query_map([], map_row)
            .map_err(|e| e.to_string())?;
        rows.collect::<SqliteResult<Vec<_>>>()
            .map_err(|e| e.to_string())
    }
}

fn query_edges(conn: &Connection, sql: &str, project: Option<&str>) -> Result<Vec<GraphEdgeDto>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let map_row = |row: &rusqlite::Row<'_>| {
        let metadata: String = row.get(5)?;
        Ok(GraphEdgeDto {
            id: row.get(0)?,
            from_id: row.get(1)?,
            to_id: row.get(2)?,
            kind: row.get(3)?,
            weight: row.get(4)?,
            metadata: serde_json::from_str(&metadata).unwrap_or_else(|_| serde_json::json!({})),
            updated_at: row.get(6)?,
        })
    };
    if let Some(project) = project {
        let rows = stmt
            .query_map([project], map_row)
            .map_err(|e| e.to_string())?;
        rows.collect::<SqliteResult<Vec<_>>>()
            .map_err(|e| e.to_string())
    } else {
        let rows = stmt
            .query_map([], map_row)
            .map_err(|e| e.to_string())?;
        rows.collect::<SqliteResult<Vec<_>>>()
            .map_err(|e| e.to_string())
    }
}

fn persist_context_snapshot(conn: &Connection, snapshot: &ContextSnapshot) -> Result<(), String> {
    conn.execute(
        "INSERT INTO context_snapshots
         (id, project_path, project_name, active_files, related_memories, relevant_tools, likely_intent, confidence, summary, metadata, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, '{}', ?10)",
        params![
            snapshot.id,
            snapshot.project_path,
            snapshot.project_name,
            serde_json::to_string(&snapshot.active_files).unwrap_or_else(|_| "[]".to_string()),
            serde_json::to_string(&snapshot.related_memories).unwrap_or_else(|_| "[]".to_string()),
            serde_json::to_string(&snapshot.relevant_tools).unwrap_or_else(|_| "[]".to_string()),
            snapshot.likely_intent,
            snapshot.confidence,
            snapshot.summary,
            snapshot.created_at.to_rfc3339(),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn persist_temporal_event(conn: &Connection, event: &TemporalEvent) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO project_timelines
         (id, project_name, kind, title, detail, related_path, related_memory_id, importance, occurred_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            event.id,
            event.project_name,
            enum_to_string(&event.kind),
            event.title,
            event.detail,
            event.related_path,
            event.related_memory_id,
            event.importance,
            event.occurred_at.to_rfc3339(),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn load_recent_timeline(
    conn: &Connection,
    project_name: Option<&str>,
    limit: usize,
) -> Result<Vec<TemporalEvent>, String> {
    let limit = limit.clamp(1, 200) as i64;
    if let Some(project) = project_name {
        let mut stmt = conn
            .prepare(
                "SELECT id, project_name, kind, title, detail, related_path, related_memory_id, importance, occurred_at
                 FROM project_timelines
                 WHERE project_name = ?1
                 ORDER BY occurred_at DESC
                 LIMIT ?2",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![project, limit], temporal_event_from_row)
            .map_err(|e| e.to_string())?;
        rows.collect::<SqliteResult<Vec<_>>>()
            .map_err(|e| e.to_string())
    } else {
        let mut stmt = conn
            .prepare(
                "SELECT id, project_name, kind, title, detail, related_path, related_memory_id, importance, occurred_at
                 FROM project_timelines
                 ORDER BY occurred_at DESC
                 LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([limit], temporal_event_from_row)
            .map_err(|e| e.to_string())?;
        rows.collect::<SqliteResult<Vec<_>>>()
            .map_err(|e| e.to_string())
    }
}

fn temporal_event_from_row(row: &rusqlite::Row<'_>) -> SqliteResult<TemporalEvent> {
    let kind: String = row.get(2)?;
    let occurred_at: String = row.get(8)?;
    Ok(TemporalEvent {
        id: row.get(0)?,
        project_name: row.get(1)?,
        kind: parse_temporal_kind(&kind),
        title: row.get(3)?,
        detail: row.get(4)?,
        related_path: row.get(5)?,
        related_memory_id: row.get(6)?,
        importance: row.get(7)?,
        occurred_at: parse_datetime(&occurred_at),
    })
}

fn persist_workflow_task(conn: &Connection, task: &WorkflowTask) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO workflow_tasks
         (id, workflow_id, agent, action, priority, state, payload, attempts, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            task.id,
            task.workflow_id,
            task.agent,
            task.action,
            task.priority as i64,
            task_state_string(&task.state),
            task.payload.to_string(),
            task.attempts as i64,
            task.created_at.to_rfc3339(),
            task.updated_at.to_rfc3339(),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn persist_workflow_log(
    conn: &Connection,
    task_id: &str,
    agent: &str,
    event: &str,
    detail: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO workflow_logs (id, task_id, agent, event, detail, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            Uuid::new_v4().to_string(),
            task_id,
            agent,
            event,
            detail,
            Utc::now().to_rfc3339(),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn workflow_task_from_row(row: &rusqlite::Row<'_>) -> SqliteResult<WorkflowTask> {
    let state: String = row.get(5)?;
    let payload: String = row.get(6)?;
    let created_at: String = row.get(8)?;
    let updated_at: String = row.get(9)?;
    Ok(WorkflowTask {
        id: row.get(0)?,
        workflow_id: row.get(1)?,
        agent: row.get(2)?,
        action: row.get(3)?,
        priority: row.get::<_, i64>(4)? as u8,
        state: parse_task_state(&state),
        payload: serde_json::from_str(&payload).unwrap_or_else(|_| serde_json::json!({})),
        attempts: row.get::<_, i64>(7)? as u32,
        created_at: parse_datetime(&created_at),
        updated_at: parse_datetime(&updated_at),
    })
}

fn persist_personality_state(conn: &Connection, state: &PersonalityState) -> Result<(), String> {
    conn.execute(
        "INSERT INTO personality_states (id, mood, state_json, updated_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![
            Uuid::new_v4().to_string(),
            enum_to_string(&state.mood),
            serde_json::to_string(state).map_err(|e| e.to_string())?,
            state.updated_at.to_rfc3339(),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn load_latest_personality_state(conn: &Connection) -> SqliteResult<Option<PersonalityState>> {
    conn.query_row(
        "SELECT state_json FROM personality_states ORDER BY updated_at DESC LIMIT 1",
        [],
        |row| {
            let json: String = row.get(0)?;
            serde_json::from_str::<PersonalityState>(&json)
                .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))
        },
    )
    .optional()
}

fn persist_autonomous_task(conn: &Connection, task: &AutonomousTask) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR REPLACE INTO autonomous_tasks
         (id, kind, title, schedule_json, task_json, next_run_at, last_run_at, priority, enabled, created_at, updated_at)
         VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
            COALESCE((SELECT created_at FROM autonomous_tasks WHERE id = ?1), ?10),
            ?11
         )",
        params![
            task.id,
            enum_to_string(&task.kind),
            task.title,
            serde_json::to_string(&task.schedule).map_err(|e| e.to_string())?,
            serde_json::to_string(task).map_err(|e| e.to_string())?,
            task.next_run_at.to_rfc3339(),
            task.last_run_at.map(|d| d.to_rfc3339()),
            task.priority as i64,
            if task.enabled { 1 } else { 0 },
            now,
            Utc::now().to_rfc3339(),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn record_temporal_access(conn: &Connection, entity_id: &str, score: f32) -> Result<(), String> {
    conn.execute(
        "INSERT INTO temporal_metadata
         (id, entity_id, entity_type, last_seen_at, access_count, importance, decay_score, metadata)
         VALUES (?1, ?2, 'memory', ?3, 1, ?4, 1.0, '{}')
         ON CONFLICT(entity_id, entity_type)
         DO UPDATE SET
            last_seen_at = excluded.last_seen_at,
            access_count = access_count + 1,
            importance = MAX(importance, excluded.importance),
            decay_score = excluded.decay_score",
        params![
            Uuid::new_v4().to_string(),
            entity_id,
            Utc::now().to_rfc3339(),
            score.clamp(0.0, 1.0),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn count_table(conn: &Connection, table: &str) -> Result<i64, String> {
    let sql = format!("SELECT COUNT(*) FROM {table}");
    conn.query_row(&sql, [], |row| row.get(0))
        .map_err(|e| e.to_string())
}

fn count_where(conn: &Connection, table: &str, predicate: &str) -> Result<i64, String> {
    let sql = format!("SELECT COUNT(*) FROM {table} WHERE {predicate}");
    conn.query_row(&sql, [], |row| row.get(0))
        .map_err(|e| e.to_string())
}

fn table_has_column(conn: &Connection, table: &str, column: &str) -> SqliteResult<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for name in rows {
        if name? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn stable_content_hash(content: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in content.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn normalize_source_type(kind: &str) -> &str {
    match kind {
        "chunk" | "conversation" | "manual" => kind,
        _ => "manual",
    }
}

fn enum_to_string<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(ToString::to_string))
        .unwrap_or_else(|| "unknown".to_string())
}

fn task_state_string(state: &TaskState) -> &'static str {
    match state {
        TaskState::Pending => "pending",
        TaskState::Running => "running",
        TaskState::Completed => "completed",
        TaskState::Failed => "failed",
        TaskState::Cancelled => "cancelled",
    }
}

fn parse_task_state(value: &str) -> TaskState {
    match value {
        "running" => TaskState::Running,
        "completed" => TaskState::Completed,
        "failed" => TaskState::Failed,
        "cancelled" => TaskState::Cancelled,
        _ => TaskState::Pending,
    }
}

fn parse_temporal_kind(value: &str) -> TemporalEventKind {
    match value {
        "session-started" => TemporalEventKind::SessionStarted,
        "session-ended" => TemporalEventKind::SessionEnded,
        "file-modified" => TemporalEventKind::FileModified,
        "summary-created" => TemporalEventKind::SummaryCreated,
        "memory-created" => TemporalEventKind::MemoryCreated,
        "workflow-ran" => TemporalEventKind::WorkflowRan,
        "bug-observed" => TemporalEventKind::BugObserved,
        "commit-created" => TemporalEventKind::CommitCreated,
        "milestone-reached" => TemporalEventKind::MilestoneReached,
        _ => TemporalEventKind::MemoryCreated,
    }
}

fn parse_autonomous_kind(value: Option<&str>) -> AutonomousTaskKind {
    match value {
        Some("nightly-project-summary") => AutonomousTaskKind::NightlyProjectSummary,
        Some("weekly-architecture-digest") => AutonomousTaskKind::WeeklyArchitectureDigest,
        Some("memory-cleanup") => AutonomousTaskKind::MemoryCleanup,
        Some("semantic-index-refresh") => AutonomousTaskKind::SemanticIndexRefresh,
        Some("reminder") => AutonomousTaskKind::Reminder,
        _ => AutonomousTaskKind::Custom,
    }
}

fn parse_datetime(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

fn preview(text: &str, max: usize) -> String {
    let mut out = String::new();
    for ch in text.chars().take(max) {
        out.push(ch);
    }
    if text.chars().count() > max {
        out.push_str("...");
    }
    out
}
