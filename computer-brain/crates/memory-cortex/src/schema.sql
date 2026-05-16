PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  active_project_id TEXT,
  summary TEXT,
  metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  language_stats TEXT NOT NULL DEFAULT '{}',
  last_seen_at TEXT NOT NULL,
  summary TEXT,
  metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  project_id TEXT,
  kind TEXT NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0.5,
  tags TEXT NOT NULL DEFAULT '[]',
  source_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);

CREATE TABLE IF NOT EXISTS semantic_vectors (
  memory_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector_json TEXT NOT NULL,
  cluster_id TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(memory_id) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS semantic_memories (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  cluster_id TEXT,
  concepts TEXT NOT NULL DEFAULT '[]',
  related_memory_ids TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(memory_id) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '[]',
  last_seen_at TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  source_agent TEXT,
  correlation_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workflow_id TEXT,
  agent TEXT NOT NULL,
  action TEXT NOT NULL,
  state TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 50,
  payload TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state, priority DESC, created_at ASC);

CREATE TABLE IF NOT EXISTS graph_nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  project_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_project ON graph_nodes(project_id);

CREATE TABLE IF NOT EXISTS graph_edges (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 0.5,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(from_id) REFERENCES graph_nodes(id) ON DELETE CASCADE,
  FOREIGN KEY(to_id) REFERENCES graph_nodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_id);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  definition TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  pattern TEXT NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0.5,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  capability TEXT NOT NULL,
  decision TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS system_body_maps (
  id TEXT PRIMARY KEY,
  profile TEXT NOT NULL,
  map_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS world_state_snapshots (
  id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  active_files TEXT NOT NULL DEFAULT '[]',
  relevant_memory_ids TEXT NOT NULL DEFAULT '[]',
  likely_intent TEXT NOT NULL,
  confidence REAL NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pet_states (
  id TEXT PRIMARY KEY,
  mood TEXT NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  provider TEXT NOT NULL,
  prompt TEXT,
  result TEXT,
  local_only INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS command_logs (
  id TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  cwd TEXT,
  exit_code INTEGER,
  stdout TEXT,
  stderr TEXT,
  duration_ms INTEGER,
  decision TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reasoning_traces (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_summaries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  period TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
