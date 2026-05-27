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
  metadata        TEXT,
  summary_id      TEXT REFERENCES memory_points(id) ON DELETE SET NULL
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

-- Online learning-to-rank weights for memory retrieval. Single row
-- (id = 'memory_ranker'); `version` lets a feature-layout change drop stale
-- weights cleanly instead of feeding them through a mismatched vector.
CREATE TABLE IF NOT EXISTS ranker_state (
  id            TEXT PRIMARY KEY,
  version       INTEGER NOT NULL,
  weights       TEXT NOT NULL,
  trained_count INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL
);

-- Spreading activation + co-access patterns (accessPatternTracker)
CREATE TABLE IF NOT EXISTS memory_access_patterns (
  id               TEXT PRIMARY KEY,
  memory_a         TEXT NOT NULL,
  memory_b         TEXT NOT NULL,
  coaccess_count   INTEGER NOT NULL DEFAULT 1,
  total_activation_b REAL NOT NULL DEFAULT 0,
  last_coaccess    TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_access_patterns_ab ON memory_access_patterns(memory_a, memory_b);
CREATE INDEX IF NOT EXISTS idx_access_patterns_coaccess ON memory_access_patterns(coaccess_count DESC);

CREATE TABLE IF NOT EXISTS memory_access_log (
  id          TEXT PRIMARY KEY,
  memory_id   TEXT NOT NULL,
  accessed_at TEXT NOT NULL,
  context     TEXT
);
CREATE INDEX IF NOT EXISTS idx_access_log_memory ON memory_access_log(memory_id);
CREATE INDEX IF NOT EXISTS idx_access_log_time ON memory_access_log(accessed_at DESC);

-- Semantic clustering (semanticCluster)
CREATE TABLE IF NOT EXISTS memory_clusters (
  id           TEXT PRIMARY KEY,
  topic        TEXT NOT NULL,
  memory_ids   TEXT NOT NULL DEFAULT '[]',
  memory_count INTEGER NOT NULL DEFAULT 0,
  strength     REAL NOT NULL DEFAULT 0.5,
  coherence    REAL NOT NULL DEFAULT 0.8,
  created_at   TEXT NOT NULL,
  last_updated TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clusters_topic ON memory_clusters(topic);
CREATE INDEX IF NOT EXISTS idx_clusters_strength ON memory_clusters(strength DESC);

-- Sequence prediction patterns (predictivePrefetch)
CREATE TABLE IF NOT EXISTS memory_sequence_patterns (
  id              TEXT PRIMARY KEY,
  sequence_pattern TEXT NOT NULL,
  next_id         TEXT,
  frequency       INTEGER NOT NULL DEFAULT 1,
  confidence      REAL NOT NULL DEFAULT 0.0,
  last_used       TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seq_pattern ON memory_sequence_patterns(sequence_pattern);
CREATE INDEX IF NOT EXISTS idx_seq_confidence ON memory_sequence_patterns(confidence DESC);

-- Temporal access patterns (predictivePrefetch)
CREATE TABLE IF NOT EXISTS memory_temporal_patterns (
  id           TEXT PRIMARY KEY,
  memory_id    TEXT NOT NULL,
  hour_of_day  INTEGER NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 1,
  last_access  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_temporal_hour ON memory_temporal_patterns(hour_of_day);
CREATE INDEX IF NOT EXISTS idx_temporal_memory ON memory_temporal_patterns(memory_id);

-- Brain metadata (thresholdController + general key-value store)
CREATE TABLE IF NOT EXISTS brain_metadata (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- COMPUTER BRAIN agentic layer: append-only audit of every gated agent
-- action. Phase 1 is allow-all; the `allowed` column + this table are the
-- hook point for the deferred permission allowlist.
CREATE TABLE IF NOT EXISTS agent_audit (
  id          TEXT PRIMARY KEY,
  agent       TEXT NOT NULL,
  action      TEXT NOT NULL,
  allowed     INTEGER NOT NULL DEFAULT 1,
  detail      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_audit_agent ON agent_audit(agent, created_at DESC);

-- DIGITAL TWIN (see DIGITAL_TWIN_SPEC.md §4.2). The spec's 9 per-layer tables
-- are deliberately collapsed to 4: every read here is whole-snapshot ("latest",
-- "recent N") and all trend math runs in JS over recent snapshots, never as
-- cross-snapshot SQL aggregation on one layer — so the 5 state layers live in a
-- single `layers_json` blob. `predictive_models` became `twin_predictions`
-- (logged prediction + later-observed actual is more useful than model blobs).
CREATE TABLE IF NOT EXISTS system_snapshots (
  id           TEXT PRIMARY KEY,
  captured_at  TEXT NOT NULL,
  health_score REAL NOT NULL,
  layers_json  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_time ON system_snapshots(captured_at DESC);

CREATE TABLE IF NOT EXISTS anomaly_logs (
  id           TEXT PRIMARY KEY,
  detected_at  TEXT NOT NULL,
  kind         TEXT NOT NULL,
  severity     TEXT NOT NULL,
  metric       TEXT NOT NULL,
  value        REAL NOT NULL,
  baseline     REAL NOT NULL,
  detail       TEXT,
  snapshot_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_anomaly_time ON anomaly_logs(detected_at DESC);

CREATE TABLE IF NOT EXISTS twin_predictions (
  id           TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  metric       TEXT NOT NULL,
  horizon_min  INTEGER NOT NULL,
  predicted    REAL NOT NULL,
  confidence   REAL NOT NULL,
  actual       REAL,
  reason       TEXT
);
CREATE INDEX IF NOT EXISTS idx_pred_time ON twin_predictions(created_at DESC);

CREATE TABLE IF NOT EXISTS simulation_results (
  id           TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  action       TEXT NOT NULL,
  risk_score   REAL NOT NULL,
  result_json  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sim_time ON simulation_results(created_at DESC);

-- IMAGINATION ENGINE. This stores simulated futures and prediction feedback.
-- It is local-only and append-friendly: simulations are never executable
-- actions, only mental-sandbox records that can later be compared to reality.
CREATE TABLE IF NOT EXISTS imagination_sessions (
  id                 TEXT PRIMARY KEY,
  created_at         TEXT NOT NULL,
  goal               TEXT NOT NULL,
  action             TEXT NOT NULL,
  mode               TEXT NOT NULL,
  selected_future_id TEXT NOT NULL,
  risk_score         REAL NOT NULL,
  confidence         REAL NOT NULL,
  result_json        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_imagination_sessions_time ON imagination_sessions(created_at DESC);

CREATE TABLE IF NOT EXISTS imagination_timeline (
  id          TEXT PRIMARY KEY,
  session_id  TEXT,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  detail      TEXT NOT NULL,
  confidence  REAL NOT NULL,
  risk        REAL NOT NULL,
  created_at  TEXT NOT NULL,
  metadata    TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_imagination_timeline_time ON imagination_timeline(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_imagination_timeline_session ON imagination_timeline(session_id);

CREATE TABLE IF NOT EXISTS imagination_reflections (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  future_id       TEXT NOT NULL,
  predicted_json  TEXT NOT NULL,
  actual_json     TEXT NOT NULL,
  accuracy        REAL NOT NULL,
  lesson          TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_imagination_reflections_time ON imagination_reflections(created_at DESC);

CREATE TABLE IF NOT EXISTS cognitive_abstractions (
  id          TEXT PRIMARY KEY,
  concept     TEXT NOT NULL UNIQUE,
  evidence    TEXT NOT NULL,
  confidence  REAL NOT NULL,
  -- Phase 3 hierarchy level (0..5, sensory -> philosophical). See
  -- server/src/core/abstractionLevels.ts for the ladder. Existing DBs get this
  -- backfilled via migration 0002.
  level       INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cognitive_abstractions_confidence ON cognitive_abstractions(confidence DESC);
CREATE INDEX IF NOT EXISTS idx_cognitive_abstractions_level ON cognitive_abstractions(level);

-- COGNITIVE EVOLUTION ENGINE. Components are versioned cognitive structures:
-- workflows, skills, reasoning strategies, memory models, planners, routing
-- policies, and sandboxed architecture proposals. Mutations are benchmarked
-- before they can ever be approved or applied.
CREATE TABLE IF NOT EXISTS evolution_components (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  name           TEXT NOT NULL,
  version        INTEGER NOT NULL,
  parent_id      TEXT,
  status         TEXT NOT NULL,
  description    TEXT NOT NULL,
  tags_json      TEXT NOT NULL DEFAULT '[]',
  genome_json    TEXT NOT NULL,
  metrics_json   TEXT NOT NULL,
  fitness_score  REAL NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evolution_components_kind ON evolution_components(kind, fitness_score DESC);
CREATE INDEX IF NOT EXISTS idx_evolution_components_time ON evolution_components(updated_at DESC);

CREATE TABLE IF NOT EXISTS evolution_mutations (
  id                 TEXT PRIMARY KEY,
  component_id       TEXT NOT NULL,
  mutation_kind      TEXT NOT NULL,
  before_json        TEXT NOT NULL,
  after_json         TEXT NOT NULL,
  benchmark_json     TEXT NOT NULL,
  reversible         INTEGER NOT NULL DEFAULT 1,
  requires_approval  INTEGER NOT NULL DEFAULT 1,
  status             TEXT NOT NULL,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evolution_mutations_component ON evolution_mutations(component_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evolution_mutations_time ON evolution_mutations(created_at DESC);

CREATE TABLE IF NOT EXISTS evolution_experiments (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  target_kind     TEXT NOT NULL,
  hypothesis      TEXT NOT NULL,
  result_summary  TEXT NOT NULL,
  result_json     TEXT NOT NULL,
  fitness_delta   REAL NOT NULL,
  safe            INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evolution_experiments_time ON evolution_experiments(created_at DESC);

CREATE TABLE IF NOT EXISTS evolution_identity_traits (
  id          TEXT PRIMARY KEY,
  trait       TEXT NOT NULL UNIQUE,
  evidence    TEXT NOT NULL,
  confidence  REAL NOT NULL,
  stability   REAL NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evolution_identity_confidence ON evolution_identity_traits(confidence DESC);

CREATE TABLE IF NOT EXISTS evolution_audit (
  id          TEXT PRIMARY KEY,
  action      TEXT NOT NULL,
  detail      TEXT NOT NULL,
  metadata    TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evolution_audit_time ON evolution_audit(created_at DESC);

-- PERSISTENT AUTONOMOUS DIGITAL ORGANISM. These tables preserve continuity,
-- goals, identity, world model, immune responses, energy, health, dreams, and
-- sandboxed research across process restarts and machine reboots.
CREATE TABLE IF NOT EXISTS organism_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS continuity_snapshots (
  id                  TEXT PRIMARY KEY,
  created_at          TEXT NOT NULL,
  lifecycle_state     TEXT NOT NULL,
  active_goal_ids     TEXT NOT NULL DEFAULT '[]',
  context_json        TEXT NOT NULL DEFAULT '{}',
  world_json          TEXT NOT NULL DEFAULT '{}',
  restored_workflows  TEXT NOT NULL DEFAULT '[]',
  energy_json         TEXT NOT NULL DEFAULT '{}',
  health_json         TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_continuity_snapshots_time ON continuity_snapshots(created_at DESC);

CREATE TABLE IF NOT EXISTS identity_profiles (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  traits_json              TEXT NOT NULL DEFAULT '[]',
  preferences_json         TEXT NOT NULL DEFAULT '[]',
  expertise_json           TEXT NOT NULL DEFAULT '[]',
  tool_familiarity_json    TEXT NOT NULL DEFAULT '[]',
  communication_style      TEXT NOT NULL,
  planning_style           TEXT NOT NULL,
  execution_tendencies_json TEXT NOT NULL DEFAULT '[]',
  trusted_workflows_json   TEXT NOT NULL DEFAULT '[]',
  confidence               REAL NOT NULL DEFAULT 0.5,
  updated_at               TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dream_cycles (
  id              TEXT PRIMARY KEY,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  status          TEXT NOT NULL,
  activities_json TEXT NOT NULL DEFAULT '[]',
  outputs_json    TEXT NOT NULL DEFAULT '[]',
  energy_cost     REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_dream_cycles_time ON dream_cycles(started_at DESC);

CREATE TABLE IF NOT EXISTS cognitive_health (
  id                  TEXT PRIMARY KEY,
  captured_at          TEXT NOT NULL,
  health_score         REAL NOT NULL,
  memory_integrity     REAL NOT NULL,
  workflow_stability   REAL NOT NULL,
  identity_coherence   REAL NOT NULL,
  goal_alignment       REAL NOT NULL,
  resource_balance     REAL NOT NULL,
  immune_load          REAL NOT NULL,
  issues_json          TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_cognitive_health_time ON cognitive_health(captured_at DESC);

CREATE TABLE IF NOT EXISTS energy_usage (
  id             TEXT PRIMARY KEY,
  created_at     TEXT NOT NULL,
  category       TEXT NOT NULL,
  task           TEXT NOT NULL,
  amount         REAL NOT NULL,
  balance_after  REAL NOT NULL,
  metadata       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_energy_usage_time ON energy_usage(created_at DESC);

CREATE TABLE IF NOT EXISTS goal_history (
  id                    TEXT PRIMARY KEY,
  goal_id               TEXT NOT NULL,
  title                 TEXT NOT NULL,
  status                TEXT NOT NULL,
  progress              REAL NOT NULL,
  priority              INTEGER NOT NULL,
  dependencies_json     TEXT NOT NULL DEFAULT '[]',
  subgoals_json         TEXT NOT NULL DEFAULT '[]',
  attempts_json         TEXT NOT NULL DEFAULT '[]',
  blockers_json         TEXT NOT NULL DEFAULT '[]',
  confidence            REAL NOT NULL,
  estimated_completion  TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goal_history_goal ON goal_history(goal_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_goal_history_status ON goal_history(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS organism_mutation_history (
  id          TEXT PRIMARY KEY,
  source_id   TEXT,
  kind        TEXT NOT NULL,
  summary     TEXT NOT NULL,
  reversible  INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_organism_mutation_history_time ON organism_mutation_history(created_at DESC);

CREATE TABLE IF NOT EXISTS immune_events (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  severity     TEXT NOT NULL,
  status       TEXT NOT NULL,
  target       TEXT NOT NULL,
  detail       TEXT NOT NULL,
  metadata     TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  resolved_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_immune_events_time ON immune_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_immune_events_status ON immune_events(status, severity);

CREATE TABLE IF NOT EXISTS research_sessions (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  hypothesis     TEXT NOT NULL,
  status         TEXT NOT NULL,
  sandboxed      INTEGER NOT NULL DEFAULT 1,
  findings_json  TEXT NOT NULL DEFAULT '[]',
  risk           REAL NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_research_sessions_time ON research_sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS organism_world_model (
  id                       TEXT PRIMARY KEY,
  summary                  TEXT NOT NULL,
  user_habits_json         TEXT NOT NULL DEFAULT '[]',
  project_evolution_json   TEXT NOT NULL DEFAULT '[]',
  workflow_patterns_json   TEXT NOT NULL DEFAULT '[]',
  environment_changes_json TEXT NOT NULL DEFAULT '[]',
  installed_tools_json     TEXT NOT NULL DEFAULT '[]',
  ai_capabilities_json     TEXT NOT NULL DEFAULT '[]',
  historical_trends_json   TEXT NOT NULL DEFAULT '[]',
  updated_at               TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS organism_subbrains (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  specialization        TEXT NOT NULL,
  memory_scopes_json    TEXT NOT NULL DEFAULT '[]',
  skills_json           TEXT NOT NULL DEFAULT '[]',
  safety_rules_json     TEXT NOT NULL DEFAULT '[]',
  maturity              REAL NOT NULL DEFAULT 0.35,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_organism_subbrains_maturity ON organism_subbrains(maturity DESC);

-- VISUAL MEMORY (see MULTIMODAL_SENSORY_CORTEX_SPEC.md)
-- Stores screenshots and their metadata for visual memory and UI reasoning.
CREATE TABLE IF NOT EXISTS visual_memory (
  id                   TEXT PRIMARY KEY,
  screenshot_path      TEXT NOT NULL,
  thumbnail_path       TEXT,
  width                INTEGER NOT NULL,
  height               INTEGER NOT NULL,
  capture_timestamp    INTEGER NOT NULL,
  source_app           TEXT,
  window_title         TEXT,
  monitor_index        INTEGER NOT NULL DEFAULT 0,
  hash                 TEXT NOT NULL,
  tags                 TEXT NOT NULL DEFAULT '[]',
  annotation           TEXT,
  linked_memory_ids    TEXT NOT NULL DEFAULT '[]',
  created_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_visual_memory_capture_time ON visual_memory(capture_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_visual_memory_source_app  ON visual_memory(source_app);
CREATE INDEX IF NOT EXISTS idx_visual_memory_hash        ON visual_memory(hash);

-- Detected UI regions within a visual memory capture.
CREATE TABLE IF NOT EXISTS visual_regions (
  id                    TEXT PRIMARY KEY,
  visual_memory_id      TEXT NOT NULL,
  region_type           TEXT NOT NULL,
  bounding_box_x        REAL NOT NULL,
  bounding_box_y        REAL NOT NULL,
  bounding_box_width    REAL NOT NULL,
  bounding_box_height   REAL NOT NULL,
  confidence            REAL NOT NULL,
  detected_text         TEXT,
  detected_app          TEXT,
  metadata              TEXT NOT NULL DEFAULT '{}',
  created_at            TEXT NOT NULL,
  FOREIGN KEY (visual_memory_id) REFERENCES visual_memory(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_visual_regions_memory     ON visual_regions(visual_memory_id);
CREATE INDEX IF NOT EXISTS idx_visual_regions_type       ON visual_regions(region_type);

-- Tracked workflow states inferred from sequences of UI transitions.
CREATE TABLE IF NOT EXISTS visual_workflow_states (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  entry_screenshot_id   TEXT,
  exit_screenshot_id    TEXT,
  transition_trigger    TEXT,
  frequency             INTEGER NOT NULL DEFAULT 1,
  avg_duration_ms       INTEGER,
  tags                  TEXT NOT NULL DEFAULT '[]',
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_states_name      ON visual_workflow_states(name);
CREATE INDEX IF NOT EXISTS idx_workflow_states_frequency ON visual_workflow_states(frequency DESC);

-- Causal world model (blueprint §3 #7) — explicit cause→effect map keyed on
-- action classes (twin/simulationEngine.classifyAction) and outcome labels.
-- Populated from imagination.reflect() observations; consumed by
-- imagination.imagine() to bias risk priors with empirical history.
--
-- Semantics: each row is a (cause, effect) pair. `observations` = number of
-- times we've seen the cause class. `occurrences` = number of those times
-- the effect followed. `strength` = Laplace-smoothed P(effect | cause).
-- `confidence` = exponential saturation on observation count.
CREATE TABLE IF NOT EXISTS causal_links (
  id                TEXT PRIMARY KEY,
  cause_class       TEXT NOT NULL,
  effect_class      TEXT NOT NULL,
  observations      INTEGER NOT NULL DEFAULT 0,
  occurrences       INTEGER NOT NULL DEFAULT 0,
  strength          REAL    NOT NULL DEFAULT 0,
  confidence        REAL    NOT NULL DEFAULT 0,
  last_observed_at  TEXT    NOT NULL,
  source            TEXT    NOT NULL DEFAULT 'imagination-reflection',
  UNIQUE(cause_class, effect_class)
);
CREATE INDEX IF NOT EXISTS idx_causal_links_cause  ON causal_links(cause_class);
CREATE INDEX IF NOT EXISTS idx_causal_links_effect ON causal_links(effect_class);

-- Migration tracking: runMigrations() uses this to apply only new migrations.
CREATE TABLE IF NOT EXISTS schema_migrations (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL UNIQUE,
  applied_at TEXT    NOT NULL
);
