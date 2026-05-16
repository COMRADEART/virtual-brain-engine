use anyhow::Result;
use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use serde_json::Value;
use shared_types::{
    new_id, AgentDescriptor, AgentState, AgentTask, BrainEventEnvelope, BrainId, GraphEdgeRecord,
    GraphNodeRecord, MemoryKind, MemoryRecord, PetState, ProjectRecord, SafetyDecision, TaskState,
    ToolResult,
};
use std::path::Path;
use std::sync::Arc;

#[derive(Clone)]
pub struct MemoryCortex {
    conn: Arc<Mutex<Connection>>,
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

    pub fn counts(&self) -> Result<Value> {
        let conn = self.conn.lock();
        let count = |table: &str| -> Result<i64> {
            let sql = format!("SELECT COUNT(*) FROM {table}");
            Ok(conn.query_row(&sql, [], |r| r.get(0))?)
        };
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
            "permissions": count("permissions")?,
            "commandLogs": count("command_logs")?,
            "bodyMaps": count("system_body_maps")?,
            "worldStates": count("world_state_snapshots")?,
            "reasoningTraces": count("reasoning_traces")?,
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
