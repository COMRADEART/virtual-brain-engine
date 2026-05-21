use anyhow::Result;
use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use serde_json::Value;
use adaptation_engine::AdaptationDecision;
use evolution_engine::{EvolutionCandidate, EvolutionGeneration, EvolutionStatus, GenomeKind};
use learning_engine::{LearningSignal, Lesson};
use perception_engine::StructuredObservation;
use planning_engine::CognitivePlanAssessment;
use reflection_engine::{ExecutionOutcome, PlanningQuality, ReflectionRecord, WorkflowEfficiency};
use shared_types::{
    new_id, AgentDescriptor, AgentState, AgentTask, BrainEventEnvelope, BrainId,
    ConsciousnessCycleRecord, GoalRecord, GoalRisk, GoalStatus, GraphEdgeRecord, GraphNodeRecord,
    MemoryKind, MemoryRecord, OperatingMode, PetState, ProjectRecord, SafetyDecision, TaskState,
    ToolResult,
};
use skill_learning::{LearnedSkill, SkillFailure, SkillImprovement, SkillRun, SkillVersion};
use understanding_engine::SituationalUnderstanding;
use std::path::Path;
use std::sync::Arc;

#[derive(Clone)]
pub struct MemoryCortex {
    conn: Arc<Mutex<Connection>>,
}

/// Raw execution counters drawn from `execution_outcomes` + `audit_logs`.
/// Deliberately evolution-math-free: `brain-core` maps this into
/// `evolution_engine::PerformanceSignals`, keeping persistence decoupled from
/// the fitness model.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ExecutionStats {
    pub runs: u64,
    pub completed: u64,
    pub failed: u64,
    pub avg_latency_ms: f64,
    pub blocked_actions: u64,
}

impl MemoryCortex {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        if let Some(parent) = path.as_ref().parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.execute_batch(include_str!("schema.sql"))?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(include_str!("schema.sql"))?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn store_event(&self, envelope: &BrainEventEnvelope) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO events (id, kind, payload, occurred_at, source_agent, correlation_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                envelope.id,
                event_kind_name(&envelope.event),
                serde_json::to_string(&envelope.event)?,
                envelope.occurred_at.to_rfc3339(),
                envelope.source_agent,
                envelope.correlation_id,
            ],
        )?;
        Ok(())
    }

    pub fn upsert_agent(&self, agent: &AgentDescriptor) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO agents (id, name, state, capabilities, last_seen_at, metadata)
             VALUES (
                COALESCE((SELECT id FROM agents WHERE name = ?1), ?2),
                ?1, ?3, ?4, ?5, '{}'
             )",
            params![
                agent.name,
                new_id("agent"),
                serde_json::to_string(&agent.state)?,
                serde_json::to_string(&agent.capabilities)?,
                agent.last_seen_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn agents(&self) -> Result<Vec<AgentDescriptor>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT name, state, capabilities, last_seen_at, metadata FROM agents ORDER BY name",
        )?;
        let rows = stmt.query_map([], |row| {
            let state: String = row.get(1)?;
            let caps: String = row.get(2)?;
            let last_seen: String = row.get(3)?;
            Ok(AgentDescriptor {
                name: row.get(0)?,
                state: serde_json::from_str(&state).unwrap_or(AgentState::Idle),
                capabilities: serde_json::from_str(&caps).unwrap_or_default(),
                last_seen_at: parse_time(&last_seen),
                detail: None,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn upsert_project(&self, name: &str, root_path: &str, language_stats: Value) -> Result<ProjectRecord> {
        let now = Utc::now();
        let id = self
            .conn
            .lock()
            .query_row("SELECT id FROM projects WHERE root_path = ?1", [root_path], |r| r.get(0))
            .optional()?
            .unwrap_or_else(|| new_id("proj"));
        let record = ProjectRecord {
            id,
            name: name.to_string(),
            root_path: root_path.to_string(),
            language_stats,
            last_seen_at: now,
            summary: None,
            metadata: serde_json::json!({}),
        };
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO projects (id, name, root_path, language_stats, last_seen_at, summary, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                record.id,
                record.name,
                record.root_path,
                record.language_stats.to_string(),
                record.last_seen_at.to_rfc3339(),
                record.summary,
                record.metadata.to_string(),
            ],
        )?;
        Ok(record)
    }

    pub fn recent_projects(&self, limit: usize) -> Result<Vec<ProjectRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, name, root_path, language_stats, last_seen_at, summary, metadata
             FROM projects ORDER BY last_seen_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit as i64], project_from_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn store_memory(&self, mut memory: MemoryRecord) -> Result<MemoryRecord> {
        if memory.id.is_empty() {
            memory.id = new_id("mem");
        }
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO memories
             (id, session_id, project_id, kind, title, content, importance, tags, source_path, created_at, updated_at, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                memory.id,
                memory.session_id,
                memory.project_id,
                serde_json::to_string(&memory.kind)?,
                memory.title,
                memory.content,
                memory.importance,
                serde_json::to_string(&memory.tags)?,
                memory.source_path,
                memory.created_at.to_rfc3339(),
                memory.updated_at.to_rfc3339(),
                memory.metadata.to_string(),
            ],
        )?;
        Ok(memory)
    }

    pub fn recent_memories(&self, limit: usize) -> Result<Vec<MemoryRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, project_id, kind, title, content, importance, tags, source_path, created_at, updated_at, metadata
             FROM memories ORDER BY updated_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit as i64], memory_from_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn memory_by_id(&self, id: &str) -> Result<Option<MemoryRecord>> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT id, session_id, project_id, kind, title, content, importance, tags, source_path, created_at, updated_at, metadata
             FROM memories WHERE id = ?1",
            [id],
            memory_from_row,
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn store_vector(&self, memory_id: &str, model: &str, vector: &[f32], cluster_id: Option<&str>) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO semantic_vectors (memory_id, model, dimensions, vector_json, cluster_id, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                memory_id,
                model,
                vector.len() as i64,
                serde_json::to_string(vector)?,
                cluster_id,
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn vectors(&self) -> Result<Vec<(MemoryRecord, Vec<f32>)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT m.id, m.session_id, m.project_id, m.kind, m.title, m.content, m.importance, m.tags,
                    m.source_path, m.created_at, m.updated_at, m.metadata, v.vector_json
             FROM memories m JOIN semantic_vectors v ON v.memory_id = m.id",
        )?;
        let rows = stmt.query_map([], |row| {
            let memory = memory_from_row(row)?;
            let json: String = row.get(12)?;
            let vector = serde_json::from_str(&json).unwrap_or_default();
            Ok((memory, vector))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn upsert_graph_node(&self, node: &GraphNodeRecord) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO graph_nodes (id, kind, label, project_id, metadata, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                node.id,
                serde_json::to_string(&node.kind)?,
                node.label,
                node.project_id,
                node.metadata.to_string(),
                node.created_at.to_rfc3339(),
                node.updated_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn upsert_graph_edge(&self, edge: &GraphEdgeRecord) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO graph_edges (id, from_id, to_id, kind, weight, metadata, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                edge.id,
                edge.from_id,
                edge.to_id,
                serde_json::to_string(&edge.kind)?,
                edge.weight,
                edge.metadata.to_string(),
                edge.created_at.to_rfc3339(),
                edge.updated_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn graph(&self, limit: usize) -> Result<(Vec<GraphNodeRecord>, Vec<GraphEdgeRecord>)> {
        let conn = self.conn.lock();
        let mut nodes_stmt = conn.prepare(
            "SELECT id, kind, label, project_id, metadata, created_at, updated_at
             FROM graph_nodes ORDER BY updated_at DESC LIMIT ?1",
        )?;
        let nodes = nodes_stmt
            .query_map([limit as i64], graph_node_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut edges_stmt = conn.prepare(
            "SELECT id, from_id, to_id, kind, weight, metadata, created_at, updated_at
             FROM graph_edges ORDER BY updated_at DESC LIMIT ?1",
        )?;
        let edges = edges_stmt
            .query_map([limit as i64], graph_edge_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok((nodes, edges))
    }

    pub fn store_task(&self, task: &AgentTask) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO tasks (id, workflow_id, agent, action, state, priority, payload, result, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                task.id,
                task.workflow_id,
                task.agent,
                task.action,
                serde_json::to_string(&task.state)?,
                task.priority as i64,
                task.payload.to_string(),
                task.result.as_ref().map(Value::to_string),
                task.created_at.to_rfc3339(),
                task.updated_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn recent_tasks(&self, limit: usize) -> Result<Vec<AgentTask>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, workflow_id, agent, action, state, priority, payload, result, created_at, updated_at
             FROM tasks ORDER BY updated_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit as i64], task_from_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn store_pet_state(&self, state: &PetState) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO pet_states (id, mood, state_json, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![
                new_id("pet"),
                serde_json::to_string(&state.mood)?,
                serde_json::to_string(state)?,
                state.updated_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn latest_pet_state(&self) -> Result<PetState> {
        let conn = self.conn.lock();
        let state = conn
            .query_row(
                "SELECT state_json FROM pet_states ORDER BY updated_at DESC LIMIT 1",
                [],
                |row| {
                    let json: String = row.get(0)?;
                    serde_json::from_str(&json)
                        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))
                },
            )
            .optional()?
            .unwrap_or_default();
        Ok(state)
    }

    pub fn audit(&self, actor: &str, action: &str, decision: &SafetyDecision, metadata: Value) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO audit_logs (id, actor, action, decision, reason, metadata, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                new_id("audit"),
                actor,
                action,
                serde_json::to_string(&decision.decision)?,
                decision.reason,
                metadata.to_string(),
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn store_tool_result(&self, tool: &str, provider: &str, prompt: Option<&str>, result: &ToolResult) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO tool_calls (id, tool, provider, prompt, result, local_only, started_at, finished_at, error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                new_id("tool"),
                tool,
                provider,
                prompt,
                result.output.to_string(),
                if matches!(result.provider, shared_types::ToolProvider::Ollama | shared_types::ToolProvider::Shell | shared_types::ToolProvider::Python) { 1 } else { 0 },
                Utc::now().to_rfc3339(),
                Utc::now().to_rfc3339(),
                result.error.clone(),
            ],
        )?;
        if matches!(result.provider, shared_types::ToolProvider::Shell) {
            let output = &result.output;
            conn.execute(
                "INSERT INTO command_logs (id, command, cwd, exit_code, stdout, stderr, duration_ms, decision, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    new_id("cmd"),
                    prompt.unwrap_or(tool),
                    output.get("cwd").and_then(Value::as_str),
                    output.get("status").and_then(Value::as_i64),
                    output.get("stdout").and_then(Value::as_str),
                    output.get("stderr").and_then(Value::as_str),
                    output.get("duration_ms").and_then(Value::as_u64).map(|v| v as i64),
                    if result.ok { "allow" } else { "failed" },
                    Utc::now().to_rfc3339(),
                ],
            )?;
        }
        Ok(())
    }

    pub fn store_context_snapshot(
        &self,
        id: &str,
        project_id: Option<&str>,
        active_files: &[String],
        relevant_memory_ids: &[String],
        likely_intent: &str,
        confidence: f32,
        summary: &str,
    ) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO context_snapshots
             (id, project_id, active_files, relevant_memory_ids, likely_intent, confidence, summary, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                project_id,
                serde_json::to_string(active_files)?,
                serde_json::to_string(relevant_memory_ids)?,
                likely_intent,
                confidence,
                summary,
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn store_system_body_map<T: Serialize>(&self, profile: &str, map: &T) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO system_body_maps (id, profile, map_json, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                new_id("body"),
                profile,
                serde_json::to_string(map)?,
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn store_world_state<T: Serialize>(&self, state: &T) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO world_state_snapshots (id, state_json, created_at)
             VALUES (?1, ?2, ?3)",
            params![
                new_id("world"),
                serde_json::to_string(state)?,
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn store_reasoning_trace<T: Serialize>(&self, trace: &T) -> Result<()> {
        let value = serde_json::to_value(trace)?;
        let id = value
            .get("id")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| new_id("trace"));
        let kind = value
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("reasoning")
            .to_string();
        let summary = value
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or("reasoning trace")
            .to_string();
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO reasoning_traces (id, kind, summary, metadata, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, kind, summary, value.to_string(), Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn store_observation(&self, observation: &StructuredObservation) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO perception_observations
             (id, source, kind, raw_event_id, raw_event_kind, summary, signal, confidence, tags, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                observation.id,
                serde_json::to_string(&observation.source)?,
                serde_json::to_string(&observation.kind)?,
                observation.raw_event_id,
                observation.raw_event_kind,
                observation.summary,
                observation.signal.to_string(),
                observation.confidence,
                serde_json::to_string(&observation.tags)?,
                observation.created_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn store_understanding(&self, understanding: &SituationalUnderstanding) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO understandings
             (id, observation_id, intent, summary, project_id, related_memory_ids, relationships, recurring_patterns, confidence, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                understanding.id,
                understanding.observation_id,
                serde_json::to_string(&understanding.intent)?,
                understanding.summary,
                understanding.project_id,
                serde_json::to_string(&understanding.related_memory_ids)?,
                serde_json::to_string(&understanding.relationships)?,
                serde_json::to_string(&understanding.recurring_patterns)?,
                understanding.confidence,
                understanding.created_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn store_plan_assessment(&self, assessment: &CognitivePlanAssessment) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO planning_quality
             (id, plan_id, score, risk_score, permission_required, issues, assessment_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                assessment.id,
                assessment.plan_id,
                assessment.quality_score,
                assessment.risk_score,
                if assessment.permission_required { 1 } else { 0 },
                "[]",
                serde_json::to_string(assessment)?,
                assessment.created_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn store_execution_outcome(&self, outcome: &ExecutionOutcome) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO execution_outcomes
             (id, action, ok, duration_ms, output_summary, error_summary, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                outcome.id,
                outcome.action,
                if outcome.ok { 1 } else { 0 },
                outcome.duration_ms.map(|v| v as i64),
                outcome.output_summary,
                outcome.error_summary,
                outcome.created_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn store_reflection(&self, reflection: &ReflectionRecord) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO reflections (id, outcome_id, summary, reflection_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                reflection.id,
                reflection.outcome_id,
                reflection.summary,
                serde_json::to_string(reflection)?,
                reflection.created_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn store_lesson(&self, lesson: &Lesson, signal: &LearningSignal) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO lessons (id, reflection_id, summary, tags, confidence, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                lesson.id,
                lesson.reflection_id,
                lesson.summary,
                serde_json::to_string(&lesson.tags)?,
                lesson.confidence,
                lesson.created_at.to_rfc3339(),
            ],
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO skill_evolution (id, skill_id, lesson_id, summary, confidence_delta, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                signal.id,
                signal.skill_id,
                signal.lesson_id,
                lesson.summary,
                signal.confidence_delta,
                signal.created_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn store_adaptation(&self, decision: &AdaptationDecision) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO adaptation_history
             (id, trigger, behavior, rationale, priority_delta, notification_policy, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                decision.id,
                decision.trigger,
                decision.behavior,
                decision.rationale,
                decision.priority_delta as i64,
                decision.notification_policy,
                decision.created_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn store_workflow_efficiency(&self, efficiency: &WorkflowEfficiency) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO workflow_efficiency (id, workflow, score, bottlenecks, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                efficiency.id,
                efficiency.workflow,
                efficiency.score,
                serde_json::to_string(&efficiency.bottlenecks)?,
                efficiency.created_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn store_planning_quality(&self, quality: &PlanningQuality) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO planning_quality (id, plan_id, score, issues, assessment_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                quality.id,
                quality.plan_id,
                quality.score,
                serde_json::to_string(&quality.issues)?,
                serde_json::to_string(quality)?,
                quality.created_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn store_operating_mode(&self, mode: &OperatingMode) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO operating_mode_state (id, mode, updated_at)
             VALUES ('current', ?1, ?2)",
            params![serde_json::to_string(mode)?, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn latest_operating_mode(&self) -> Result<OperatingMode> {
        let conn = self.conn.lock();
        let value = conn
            .query_row("SELECT mode FROM operating_mode_state WHERE id = 'current'", [], |row| row.get::<_, String>(0))
            .optional()?;
        Ok(value
            .and_then(|mode| serde_json::from_str::<OperatingMode>(&mode).ok())
            .unwrap_or_default())
    }

    pub fn store_goal(&self, goal: &GoalRecord) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO goal_stack
             (id, parent_id, title, priority, status, owner_agent, required_tools, risk_level, memory_links, deadline, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                goal.id,
                goal.parent_id,
                goal.title,
                goal.priority as i64,
                serde_json::to_string(&goal.status)?,
                goal.owner_agent,
                serde_json::to_string(&goal.required_tools)?,
                serde_json::to_string(&goal.risk_level)?,
                serde_json::to_string(&goal.memory_links)?,
                goal.deadline.as_ref().map(DateTime::to_rfc3339),
                goal.created_at.to_rfc3339(),
                goal.updated_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn recent_goals(&self, limit: usize) -> Result<Vec<GoalRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, parent_id, title, priority, status, owner_agent, required_tools, risk_level, memory_links, deadline, created_at, updated_at
             FROM goal_stack ORDER BY updated_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit as i64], goal_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn store_consciousness_cycle(&self, cycle: &ConsciousnessCycleRecord) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO consciousness_cycles
             (id, mode, world_state, recalled_memory_ids, detected_goal_ids, available_tools, available_skills,
              risk_score, plan_ids, actions_taken, reflection_ids, summary, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                cycle.id,
                serde_json::to_string(&cycle.mode)?,
                cycle.world_state.to_string(),
                serde_json::to_string(&cycle.recalled_memory_ids)?,
                serde_json::to_string(&cycle.detected_goal_ids)?,
                serde_json::to_string(&cycle.available_tools)?,
                serde_json::to_string(&cycle.available_skills)?,
                cycle.risk_score,
                serde_json::to_string(&cycle.plan_ids)?,
                serde_json::to_string(&cycle.actions_taken)?,
                serde_json::to_string(&cycle.reflection_ids)?,
                cycle.summary,
                cycle.created_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn upsert_learned_skill(&self, skill: &LearnedSkill) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO learned_skills
             (id, name, description, trigger_conditions, required_tools, required_permissions, execution_graph,
              failure_handling, memory_refs, confidence, usage_count, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                skill.id,
                skill.name,
                skill.description,
                serde_json::to_string(&skill.trigger_conditions)?,
                serde_json::to_string(&skill.required_tools)?,
                serde_json::to_string(&skill.required_permissions)?,
                skill.execution_graph.to_string(),
                serde_json::to_string(&skill.failure_handling)?,
                serde_json::to_string(&skill.memory_refs)?,
                skill.confidence,
                skill.usage_count as i64,
                skill.created_at.to_rfc3339(),
                skill.updated_at.to_rfc3339(),
            ],
        )?;
        for permission in &skill.required_permissions {
            conn.execute(
                "INSERT OR REPLACE INTO skill_permissions (id, skill_id, permission, decision, scope, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    stable_row_id("skill-permission", &format!("{}:{permission}", skill.id)),
                    skill.id,
                    permission,
                    "required",
                    "{}",
                    Utc::now().to_rfc3339(),
                    Utc::now().to_rfc3339(),
                ],
            )?;
        }
        for trigger in &skill.trigger_conditions {
            conn.execute(
                "INSERT OR REPLACE INTO skill_triggers (id, skill_id, trigger_kind, trigger_value, confidence, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    stable_row_id("skill-trigger", &format!("{}:{trigger}", skill.id)),
                    skill.id,
                    "condition",
                    trigger,
                    skill.confidence,
                    Utc::now().to_rfc3339(),
                ],
            )?;
        }
        conn.execute(
            "INSERT INTO skill_confidence (id, skill_id, confidence, reason, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                new_id("skill-confidence"),
                skill.id,
                skill.confidence,
                "skill upsert",
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn store_skill_version(&self, version: &SkillVersion) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO skill_versions (id, skill_id, version, definition, change_summary, confidence, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                version.id,
                version.skill_id,
                version.version as i64,
                version.definition.to_string(),
                version.change_summary,
                version.confidence,
                version.created_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn store_skill_run(&self, run: &SkillRun) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO skill_runs (id, skill_id, ok, input, output, started_at, finished_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                run.id,
                run.skill_id,
                if run.ok { 1 } else { 0 },
                run.input.to_string(),
                run.output.to_string(),
                run.started_at.to_rfc3339(),
                run.finished_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn store_skill_failure(&self, failure: &SkillFailure) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO skill_failures (id, skill_id, reason, recovery_hint, metadata, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                failure.id,
                failure.skill_id,
                failure.reason,
                failure.recovery_hint,
                failure.metadata.to_string(),
                failure.created_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn store_skill_improvement(&self, improvement: &SkillImprovement) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO skill_improvements (id, skill_id, summary, before_confidence, after_confidence, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                improvement.id,
                improvement.skill_id,
                improvement.summary,
                improvement.before_confidence,
                improvement.after_confidence,
                improvement.created_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn store_evolution_candidate(&self, candidate: &EvolutionCandidate) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO evolution_candidates
             (id, kind, generation, origin, status, fitness, parent_ids, candidate_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                candidate.id,
                candidate.kind.as_str(),
                candidate.generation as i64,
                serde_json::to_string(&candidate.origin)?,
                serde_json::to_string(&candidate.status)?,
                candidate.fitness.overall,
                serde_json::to_string(&candidate.parent_ids)?,
                serde_json::to_string(candidate)?,
                candidate.created_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn recent_evolution_candidates(&self, limit: usize) -> Result<Vec<EvolutionCandidate>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT candidate_json FROM evolution_candidates
             ORDER BY created_at DESC, fitness DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit as i64], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for json in rows {
            if let Ok(candidate) = serde_json::from_str(&json?) {
                out.push(candidate);
            }
        }
        Ok(out)
    }

    /// The active champion for a kind: the most recent candidate still in
    /// `Promoted` status. After a rollback the rolled-back candidate is no
    /// longer `Promoted`, so this returns the restored prior champion.
    pub fn evolution_champion(&self, kind: GenomeKind) -> Result<Option<EvolutionCandidate>> {
        let conn = self.conn.lock();
        let promoted = serde_json::to_string(&EvolutionStatus::Promoted)?;
        let json: Option<String> = conn
            .query_row(
                "SELECT candidate_json FROM evolution_candidates
                 WHERE kind = ?1 AND status = ?2
                 ORDER BY created_at DESC LIMIT 1",
                params![kind.as_str(), promoted],
                |row| row.get(0),
            )
            .optional()?;
        Ok(json.and_then(|j| serde_json::from_str(&j).ok()))
    }

    pub fn store_evolution_generation(&self, generation: &EvolutionGeneration) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO evolution_generations
             (id, kind, generation_index, seed, incumbent_id, champion_id, summary, generation_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                generation.id,
                generation.kind.as_str(),
                generation.index as i64,
                generation.seed.to_string(),
                generation.incumbent_id,
                generation.champion_id,
                generation.summary,
                serde_json::to_string(generation)?,
                generation.created_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn recent_evolution_generations(&self, limit: usize) -> Result<Vec<EvolutionGeneration>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT generation_json FROM evolution_generations
             ORDER BY created_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit as i64], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for json in rows {
            if let Ok(generation) = serde_json::from_str(&json?) {
                out.push(generation);
            }
        }
        Ok(out)
    }

    /// Mean workflow efficiency score from recent records — used as
    /// `prediction_accuracy` in `PerformanceSignals`.
    pub fn recent_workflow_efficiency_avg(&self, window: usize) -> Result<f32> {
        let conn = self.conn.lock();
        let score: Option<f64> = conn
            .query_row(
                "SELECT AVG(score) FROM workflow_efficiency ORDER BY created_at DESC LIMIT ?1",
                [window as i64],
                |row| row.get(0),
            )
            .optional()?;
        Ok(score.unwrap_or(0.58) as f32)
    }

    /// Mean planning quality score from recent records — used as
    /// `memory_quality` in `PerformanceSignals`.
    pub fn recent_planning_quality_avg(&self, window: usize) -> Result<f32> {
        let conn = self.conn.lock();
        let score: Option<f64> = conn
            .query_row(
                "SELECT AVG(score) FROM planning_quality ORDER BY created_at DESC LIMIT ?1",
                [window as i64],
                |row| row.get(0),
            )
            .optional()?;
        Ok(score.unwrap_or(0.55) as f32)
    }

    /// The next generation index for a genome kind, counting existing generations.
    pub fn next_evolution_generation_index(&self, kind: GenomeKind) -> Result<u32> {
        let conn = self.conn.lock();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM evolution_generations WHERE kind = ?1",
                [kind.as_str()],
                |row| row.get(0),
            )
            .unwrap_or(0);
        Ok(count as u32)
    }

    /// Raw execution counters for fitness scoring. Pure read; no evolution math.
    pub fn execution_stats(&self) -> Result<ExecutionStats> {
        let conn = self.conn.lock();
        let (runs, completed, failed, avg): (i64, i64, i64, Option<f64>) = conn.query_row(
            "SELECT COUNT(*),
                    SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END),
                    SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END),
                    AVG(duration_ms)
             FROM execution_outcomes",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                    row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                    row.get(3)?,
                ))
            },
        )?;
        let blocked: i64 = conn.query_row(
            "SELECT COUNT(*) FROM audit_logs WHERE decision LIKE '%deny%'",
            [],
            |row| row.get(0),
        )?;
        Ok(ExecutionStats {
            runs: runs.max(0) as u64,
            completed: completed.max(0) as u64,
            failed: failed.max(0) as u64,
            avg_latency_ms: avg.unwrap_or(0.0),
            blocked_actions: blocked.max(0) as u64,
        })
    }

    pub fn counts(&self) -> Result<Value> {
        let conn = self.conn.lock();
        let count = |table: &str| -> Result<i64> {
            let sql = format!("SELECT COUNT(*) FROM {table}");
            Ok(conn.query_row(&sql, [], |r| r.get(0))?)
        };
        let promoted_genomes: i64 = conn.query_row(
            "SELECT COUNT(*) FROM evolution_candidates WHERE status LIKE '%promoted%'",
            [],
            |r| r.get(0),
        )?;
        Ok(serde_json::json!({
            "memories": count("memories")?,
            "projects": count("projects")?,
            "agents": count("agents")?,
            "events": count("events")?,
            "tasks": count("tasks")?,
            "graphNodes": count("graph_nodes")?,
            "graphEdges": count("graph_edges")?,
            "toolCalls": count("tool_calls")?,
            "auditLogs": count("audit_logs")?,
            "skills": count("skills")?,
            "learnedSkills": count("learned_skills")?,
            "skillVersions": count("skill_versions")?,
            "skillRuns": count("skill_runs")?,
            "skillFailures": count("skill_failures")?,
            "permissions": count("permissions")?,
            "commandLogs": count("command_logs")?,
            "bodyMaps": count("system_body_maps")?,
            "worldStates": count("world_state_snapshots")?,
            "reasoningTraces": count("reasoning_traces")?,
            "observations": count("perception_observations")?,
            "understandings": count("understandings")?,
            "executionOutcomes": count("execution_outcomes")?,
            "reflections": count("reflections")?,
            "lessons": count("lessons")?,
            "skillEvolution": count("skill_evolution")?,
            "adaptations": count("adaptation_history")?,
            "workflowEfficiency": count("workflow_efficiency")?,
            "planningQuality": count("planning_quality")?,
            "goals": count("goal_stack")?,
            "consciousnessCycles": count("consciousness_cycles")?,
            "evolutionCandidates": count("evolution_candidates")?,
            "evolutionGenerations": count("evolution_generations")?,
            "promotedGenomes": promoted_genomes,
        }))
    }
}

pub fn memory(
    kind: MemoryKind,
    title: impl Into<Option<String>>,
    content: impl Into<String>,
    project_id: Option<BrainId>,
    tags: Vec<String>,
    source_path: Option<String>,
    importance: f32,
) -> MemoryRecord {
    let now = Utc::now();
    MemoryRecord {
        id: new_id("mem"),
        session_id: None,
        project_id,
        kind,
        title: title.into(),
        content: content.into(),
        importance: importance.clamp(0.0, 1.0),
        tags,
        source_path,
        created_at: now,
        updated_at: now,
        metadata: serde_json::json!({}),
    }
}

fn memory_from_row(row: &Row<'_>) -> rusqlite::Result<MemoryRecord> {
    let kind: String = row.get(3)?;
    let tags: String = row.get(7)?;
    let created: String = row.get(9)?;
    let updated: String = row.get(10)?;
    let metadata: String = row.get(11)?;
    Ok(MemoryRecord {
        id: row.get(0)?,
        session_id: row.get(1)?,
        project_id: row.get(2)?,
        kind: serde_json::from_str(&kind).unwrap_or(MemoryKind::LongTerm),
        title: row.get(4)?,
        content: row.get(5)?,
        importance: row.get(6)?,
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        source_path: row.get(8)?,
        created_at: parse_time(&created),
        updated_at: parse_time(&updated),
        metadata: serde_json::from_str(&metadata).unwrap_or_else(|_| serde_json::json!({})),
    })
}

fn project_from_row(row: &Row<'_>) -> rusqlite::Result<ProjectRecord> {
    let language_stats: String = row.get(3)?;
    let last_seen: String = row.get(4)?;
    let metadata: String = row.get(6)?;
    Ok(ProjectRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        root_path: row.get(2)?,
        language_stats: serde_json::from_str(&language_stats).unwrap_or_else(|_| serde_json::json!({})),
        last_seen_at: parse_time(&last_seen),
        summary: row.get(5)?,
        metadata: serde_json::from_str(&metadata).unwrap_or_else(|_| serde_json::json!({})),
    })
}

fn graph_node_from_row(row: &Row<'_>) -> rusqlite::Result<GraphNodeRecord> {
    let kind: String = row.get(1)?;
    let metadata: String = row.get(4)?;
    let created: String = row.get(5)?;
    let updated: String = row.get(6)?;
    Ok(GraphNodeRecord {
        id: row.get(0)?,
        kind: serde_json::from_str(&kind).unwrap_or(shared_types::GraphNodeKind::Concept),
        label: row.get(2)?,
        project_id: row.get(3)?,
        metadata: serde_json::from_str(&metadata).unwrap_or_else(|_| serde_json::json!({})),
        created_at: parse_time(&created),
        updated_at: parse_time(&updated),
    })
}

fn graph_edge_from_row(row: &Row<'_>) -> rusqlite::Result<GraphEdgeRecord> {
    let kind: String = row.get(3)?;
    let metadata: String = row.get(5)?;
    let created: String = row.get(6)?;
    let updated: String = row.get(7)?;
    Ok(GraphEdgeRecord {
        id: row.get(0)?,
        from_id: row.get(1)?,
        to_id: row.get(2)?,
        kind: serde_json::from_str(&kind).unwrap_or(shared_types::GraphEdgeKind::RelatedTo),
        weight: row.get(4)?,
        metadata: serde_json::from_str(&metadata).unwrap_or_else(|_| serde_json::json!({})),
        created_at: parse_time(&created),
        updated_at: parse_time(&updated),
    })
}

fn task_from_row(row: &Row<'_>) -> rusqlite::Result<AgentTask> {
    let state: String = row.get(4)?;
    let payload: String = row.get(6)?;
    let result: Option<String> = row.get(7)?;
    let created: String = row.get(8)?;
    let updated: String = row.get(9)?;
    Ok(AgentTask {
        id: row.get(0)?,
        workflow_id: row.get(1)?,
        agent: row.get(2)?,
        action: row.get(3)?,
        state: serde_json::from_str(&state).unwrap_or(TaskState::Pending),
        priority: row.get::<_, i64>(5)? as u8,
        payload: serde_json::from_str(&payload).unwrap_or_else(|_| serde_json::json!({})),
        result: result.and_then(|r| serde_json::from_str(&r).ok()),
        created_at: parse_time(&created),
        updated_at: parse_time(&updated),
    })
}

fn goal_from_row(row: &Row<'_>) -> rusqlite::Result<GoalRecord> {
    let status: String = row.get(4)?;
    let required_tools: String = row.get(6)?;
    let risk_level: String = row.get(7)?;
    let memory_links: String = row.get(8)?;
    let deadline: Option<String> = row.get(9)?;
    let created: String = row.get(10)?;
    let updated: String = row.get(11)?;
    Ok(GoalRecord {
        id: row.get(0)?,
        parent_id: row.get(1)?,
        title: row.get(2)?,
        priority: row.get::<_, i64>(3)?.clamp(0, 100) as u8,
        status: serde_json::from_str(&status).unwrap_or(GoalStatus::Proposed),
        owner_agent: row.get(5)?,
        required_tools: serde_json::from_str(&required_tools).unwrap_or_default(),
        risk_level: serde_json::from_str(&risk_level).unwrap_or(GoalRisk::Medium),
        memory_links: serde_json::from_str(&memory_links).unwrap_or_default(),
        deadline: deadline.map(|value| parse_time(&value)),
        created_at: parse_time(&created),
        updated_at: parse_time(&updated),
    })
}

fn parse_time(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

fn event_kind_name<T: Serialize>(event: &T) -> String {
    serde_json::to_value(event)
        .ok()
        .and_then(|value| value.get("kind").and_then(Value::as_str).map(ToString::to_string))
        .unwrap_or_else(|| "unknown".to_string())
}

fn stable_row_id(prefix: &str, value: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{prefix}-{hash:016x}")
}
