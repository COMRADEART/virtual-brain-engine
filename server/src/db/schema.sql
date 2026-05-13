-- Schema for the Virtual Brain OS local store. Idempotent: every statement uses
-- IF NOT EXISTS so applying this on every boot is safe.

CREATE TABLE IF NOT EXISTS memory_points (
  id              TEXT PRIMARY KEY,
  source_type     TEXT NOT NULL CHECK (source_type IN ('chunk','conversation','manual')),
  file_path       TEXT,
  project_name    TEXT,
  title           TEXT,
  content         TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  embedding_id    INTEGER UNIQUE,
  importance      REAL NOT NULL DEFAULT 0.5,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  metadata        TEXT
);

CREATE INDEX IF NOT EXISTS memory_points_project ON memory_points(project_name);
CREATE INDEX IF NOT EXISTS memory_points_file    ON memory_points(file_path);
CREATE INDEX IF NOT EXISTS memory_points_source  ON memory_points(source_type);
CREATE INDEX IF NOT EXISTS memory_points_hash    ON memory_points(content_hash);

CREATE TABLE IF NOT EXISTS memory_relations (
  id          TEXT PRIMARY KEY,
  from_id     TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  weight      REAL NOT NULL DEFAULT 1.0,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (from_id) REFERENCES memory_points(id) ON DELETE CASCADE,
  FOREIGN KEY (to_id)   REFERENCES memory_points(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS memory_relations_from ON memory_relations(from_id);
CREATE INDEX IF NOT EXISTS memory_relations_to   ON memory_relations(to_id);

CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content         TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  pipeline_run_id TEXT,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  answer          TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  error           TEXT,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS connectors (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  base_url        TEXT,
  model           TEXT,
  embedding_model TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  is_default      INTEGER NOT NULL DEFAULT 0,
  state           TEXT NOT NULL DEFAULT 'idle',
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_roots (
  id          TEXT PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  path          TEXT PRIMARY KEY,
  project_name  TEXT,
  size_bytes    INTEGER NOT NULL,
  content_hash  TEXT NOT NULL,
  scanned_at    TEXT NOT NULL,
  chunk_count   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS files_project ON files(project_name);
