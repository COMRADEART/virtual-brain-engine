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

CREATE TABLE IF NOT EXISTS learned_skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  trigger_conditions TEXT NOT NULL DEFAULT '[]',
  required_tools TEXT NOT NULL DEFAULT '[]',
  required_permissions TEXT NOT NULL DEFAULT '[]',
  execution_graph TEXT NOT NULL DEFAULT '{}',
  failure_handling TEXT NOT NULL DEFAULT '[]',
  memory_refs TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.5,
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_versions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  definition TEXT NOT NULL,
  change_summary TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL,
  FOREIGN KEY(skill_id) REFERENCES learned_skills(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS skill_runs (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  ok INTEGER NOT NULL,
  input TEXT NOT NULL DEFAULT '{}',
  output TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  FOREIGN KEY(skill_id) REFERENCES learned_skills(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS skill_failures (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  recovery_hint TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY(skill_id) REFERENCES learned_skills(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS skill_permissions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  permission TEXT NOT NULL,
  decision TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(skill_id) REFERENCES learned_skills(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS skill_triggers (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  trigger_value TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL,
  FOREIGN KEY(skill_id) REFERENCES learned_skills(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS skill_confidence (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  confidence REAL NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(skill_id) REFERENCES learned_skills(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS skill_improvements (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  before_confidence REAL NOT NULL,
  after_confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(skill_id) REFERENCES learned_skills(id) ON DELETE CASCADE
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

CREATE TABLE IF NOT EXISTS perception_observations (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  raw_event_id TEXT NOT NULL,
  raw_event_kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  signal TEXT NOT NULL DEFAULT '{}',
  confidence REAL NOT NULL DEFAULT 0.5,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS understandings (
  id TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL,
  intent TEXT NOT NULL,
  summary TEXT NOT NULL,
  project_id TEXT,
  related_memory_ids TEXT NOT NULL DEFAULT '[]',
  relationships TEXT NOT NULL DEFAULT '[]',
  recurring_patterns TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_outcomes (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  ok INTEGER NOT NULL,
  duration_ms INTEGER,
  output_summary TEXT NOT NULL,
  error_summary TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reflections (
  id TEXT PRIMARY KEY,
  outcome_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  reflection_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY,
  reflection_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_evolution (
  id TEXT PRIMARY KEY,
  skill_id TEXT,
  lesson_id TEXT,
  summary TEXT NOT NULL,
  confidence_delta REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS adaptation_history (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL,
  behavior TEXT NOT NULL,
  rationale TEXT NOT NULL,
  priority_delta INTEGER NOT NULL DEFAULT 0,
  notification_policy TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_efficiency (
  id TEXT PRIMARY KEY,
  workflow TEXT NOT NULL,
  score REAL NOT NULL,
  bottlenecks TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS planning_quality (
  id TEXT PRIMARY KEY,
  plan_id TEXT,
  score REAL NOT NULL,
  risk_score REAL,
  permission_required INTEGER,
  issues TEXT NOT NULL DEFAULT '[]',
  assessment_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operating_mode_state (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS goal_stack (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  title TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL,
  owner_agent TEXT NOT NULL,
  required_tools TEXT NOT NULL DEFAULT '[]',
  risk_level TEXT NOT NULL,
  memory_links TEXT NOT NULL DEFAULT '[]',
  deadline TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS consciousness_cycles (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  world_state TEXT NOT NULL DEFAULT '{}',
  recalled_memory_ids TEXT NOT NULL DEFAULT '[]',
  detected_goal_ids TEXT NOT NULL DEFAULT '[]',
  available_tools TEXT NOT NULL DEFAULT '[]',
  available_skills TEXT NOT NULL DEFAULT '[]',
  risk_score REAL NOT NULL DEFAULT 0,
  plan_ids TEXT NOT NULL DEFAULT '[]',
  actions_taken TEXT NOT NULL DEFAULT '[]',
  reflection_ids TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS evolution_candidates (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL,
  status TEXT NOT NULL,
  fitness REAL NOT NULL DEFAULT 0,
  parent_ids TEXT NOT NULL DEFAULT '[]',
  candidate_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evolution_generations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  generation_index INTEGER NOT NULL DEFAULT 0,
  seed TEXT NOT NULL,
  incumbent_id TEXT,
  champion_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  generation_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
