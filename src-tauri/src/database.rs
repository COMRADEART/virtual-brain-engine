use chrono::{DateTime, Utc};
use parking_lot::RwLock;
use rusqlite::{Connection, Result as SqliteResult, params};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryPoint {
    pub id: String,
    pub content: String,
    pub memory_type: String,
    pub tags: Vec<String>,
    pub source_path: Option<String>,
    pub created_at: String,
    pub accessed_at: String,
    pub access_count: i32,
    pub importance: f32,
    pub embedding: Option<Vec<f32>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryRelation {
    pub id: String,
    pub from_id: String,
    pub to_id: String,
    pub relation_type: String,
    pub strength: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrainActivity {
    pub id: String,
    pub activity_type: String,
    pub region_id: String,
    pub intensity: f32,
    pub timestamp: String,
    pub metadata: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectContext {
    pub id: String,
    pub project_path: String,
    pub project_name: String,
    pub language_stats: String,
    pub file_count: i32,
    pub total_lines: i64,
    pub last_indexed: String,
    pub git_branch: Option<String>,
    pub recent_files: String,
}

pub struct Database {
    conn: Connection,
}

impl Database {
    pub fn new(path: &Path) -> SqliteResult<Self> {
        let conn = Connection::open(path)?;
        let db = Self { conn };
        db.initialize()?;
        Ok(db)
    }

    pub fn in_memory() -> SqliteResult<Self> {
        let conn = Connection::open_in_memory()?;
        let db = Self { conn };
        db.initialize()?;
        Ok(db)
    }

    fn initialize(&self) -> SqliteResult<()> {
        self.conn.execute_batch(r#"
            CREATE TABLE IF NOT EXISTS memory_points (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                memory_type TEXT NOT NULL,
                tags TEXT NOT NULL DEFAULT '[]',
                source_path TEXT,
                created_at TEXT NOT NULL,
                accessed_at TEXT NOT NULL,
                access_count INTEGER NOT NULL DEFAULT 0,
                importance REAL NOT NULL DEFAULT 0.5,
                embedding BLOB
            );

            CREATE TABLE IF NOT EXISTS memory_relations (
                id TEXT PRIMARY KEY,
                from_id TEXT NOT NULL,
                to_id TEXT NOT NULL,
                relation_type TEXT NOT NULL,
                strength REAL NOT NULL DEFAULT 0.5,
                FOREIGN KEY (from_id) REFERENCES memory_points(id),
                FOREIGN KEY (to_id) REFERENCES memory_points(id)
            );

            CREATE TABLE IF NOT EXISTS brain_activity (
                id TEXT PRIMARY KEY,
                activity_type TEXT NOT NULL,
                region_id TEXT NOT NULL,
                intensity REAL NOT NULL,
                timestamp TEXT NOT NULL,
                metadata TEXT NOT NULL DEFAULT '{}'
            );

            CREATE TABLE IF NOT EXISTS project_context (
                id TEXT PRIMARY KEY,
                project_path TEXT NOT NULL UNIQUE,
                project_name TEXT NOT NULL,
                language_stats TEXT NOT NULL DEFAULT '{}',
                file_count INTEGER NOT NULL DEFAULT 0,
                total_lines INTEGER NOT NULL DEFAULT 0,
                last_indexed TEXT NOT NULL,
                git_branch TEXT,
                recent_files TEXT NOT NULL DEFAULT '[]'
            );

            CREATE TABLE IF NOT EXISTS system_events (
                id TEXT PRIMARY KEY,
                event_type TEXT NOT NULL,
                cpu_percent REAL,
                memory_percent REAL,
                disk_percent REAL,
                timestamp TEXT NOT NULL,
                metadata TEXT NOT NULL DEFAULT '{}'
            );

            CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_points(memory_type);
            CREATE INDEX IF NOT EXISTS idx_memory_created ON memory_points(created_at);
            CREATE INDEX IF NOT EXISTS idx_brain_region ON brain_activity(region_id);
            CREATE INDEX IF NOT EXISTS idx_brain_timestamp ON brain_activity(timestamp);
            CREATE INDEX IF NOT EXISTS idx_system_timestamp ON system_events(timestamp);
        "#)?;
        Ok(())
    }

    pub fn add_memory_point(&self, point: &MemoryPoint) -> SqliteResult<()> {
        let tags_json = serde_json::to_string(&point.tags).unwrap_or_else(|_| "[]".to_string());

        self.conn.execute(
            r#"INSERT OR REPLACE INTO memory_points
               (id, content, memory_type, tags, source_path, created_at, accessed_at, access_count, importance, embedding)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"#,
            params![
                point.id,
                point.content,
                point.memory_type,
                tags_json,
                point.source_path,
                point.created_at,
                point.accessed_at,
                point.access_count,
                point.importance,
                point.embedding.as_ref().map(|v| serde_json::to_string(v).ok()),
            ],
        )?;
        Ok(())
    }

    pub fn get_recent_memories(&self, limit: usize) -> SqliteResult<Vec<MemoryPoint>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, content, memory_type, tags, source_path, created_at, accessed_at, access_count, importance, embedding
             FROM memory_points
             ORDER BY accessed_at DESC
             LIMIT ?1"
        )?;

        let rows = stmt.query_map([limit], |row| {
            Ok(MemoryPoint {
                id: row.get(0)?,
                content: row.get(1)?,
                memory_type: row.get(2)?,
                tags: serde_json::from_str(&row.get::<_, String>(3).unwrap_or_else(|_| "[]".to_string())).unwrap_or_default(),
                source_path: row.get(4)?,
                created_at: row.get(5)?,
                accessed_at: row.get(6)?,
                access_count: row.get(7)?,
                importance: row.get(8)?,
                embedding: row.get::<_, Option<String>>(9)?
                    .and_then(|s| serde_json::from_str(&s).ok()),
            })
        })?;

        rows.collect()
    }

    pub fn record_brain_activity(&self, activity: &BrainActivity) -> SqliteResult<()> {
        self.conn.execute(
            "INSERT INTO brain_activity (id, activity_type, region_id, intensity, timestamp, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                activity.id,
                activity.activity_type,
                activity.region_id,
                activity.intensity,
                activity.timestamp,
                activity.metadata,
            ],
        )?;
        Ok(())
    }

    pub fn get_recent_activity(&self, limit: usize) -> SqliteResult<Vec<BrainActivity>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, activity_type, region_id, intensity, timestamp, metadata
             FROM brain_activity
             ORDER BY timestamp DESC
             LIMIT ?1"
        )?;

        let rows = stmt.query_map([limit], |row| {
            Ok(BrainActivity {
                id: row.get(0)?,
                activity_type: row.get(1)?,
                region_id: row.get(2)?,
                intensity: row.get(3)?,
                timestamp: row.get(4)?,
                metadata: row.get(5)?,
            })
        })?;

        rows.collect()
    }

    pub fn record_system_event(
        &self,
        event_type: &str,
        cpu_percent: Option<f32>,
        memory_percent: Option<f32>,
        disk_percent: Option<f32>,
        metadata: &str,
    ) -> SqliteResult<()> {
        let id = Uuid::new_v4().to_string();
        let timestamp = Utc::now().to_rfc3339();

        self.conn.execute(
            "INSERT INTO system_events (id, event_type, cpu_percent, memory_percent, disk_percent, timestamp, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, event_type, cpu_percent, memory_percent, disk_percent, timestamp, metadata],
        )?;
        Ok(())
    }

    pub fn get_activity_summary(&self, hours: i32) -> SqliteResult<Vec<BrainActivity>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, activity_type, region_id, intensity, timestamp, metadata
             FROM brain_activity
             WHERE timestamp >= datetime('now', ?1)
             ORDER BY timestamp DESC"
        )?;

        let hours_str = format!("-{} hours", hours);
        let rows = stmt.query_map([hours_str], |row| {
            Ok(BrainActivity {
                id: row.get(0)?,
                activity_type: row.get(1)?,
                region_id: row.get(2)?,
                intensity: row.get(3)?,
                timestamp: row.get(4)?,
                metadata: row.get(5)?,
            })
        })?;

        rows.collect()
    }

    pub fn save_project_context(&self, context: &ProjectContext) -> SqliteResult<()> {
        self.conn.execute(
            r#"INSERT OR REPLACE INTO project_context
               (id, project_path, project_name, language_stats, file_count, total_lines, last_indexed, git_branch, recent_files)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"#,
            params![
                context.id,
                context.project_path,
                context.project_name,
                context.language_stats,
                context.file_count,
                context.total_lines,
                context.last_indexed,
                context.git_branch,
                context.recent_files,
            ],
        )?;
        Ok(())
    }

    pub fn get_project_context(&self, project_path: &str) -> SqliteResult<Option<ProjectContext>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, project_path, project_name, language_stats, file_count, total_lines, last_indexed, git_branch, recent_files
             FROM project_context
             WHERE project_path = ?1"
        )?;

        let mut rows = stmt.query([project_path])?;

        if let Some(row) = rows.next()? {
            Ok(Some(ProjectContext {
                id: row.get(0)?,
                project_path: row.get(1)?,
                project_name: row.get(2)?,
                language_stats: row.get(3)?,
                file_count: row.get(4)?,
                total_lines: row.get(5)?,
                last_indexed: row.get(6)?,
                git_branch: row.get(7)?,
                recent_files: row.get(8)?,
            }))
        } else {
            Ok(None)
        }
    }
}

pub type SharedDatabase = Arc<RwLock<Database>>;

pub fn create_database(data_dir: &Path) -> std::io::Result<SharedDatabase> {
    std::fs::create_dir_all(data_dir)?;
    let db_path = data_dir.join("brain_memory.sqlite");

    let db = Database::new(&db_path)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;

    Ok(Arc::new(RwLock::new(db)))
}