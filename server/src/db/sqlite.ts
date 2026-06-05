import BetterSqlite3 from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "../config.js";

export type SqliteDatabase = BetterSqlite3.Database;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let dbSingleton: SqliteDatabase | null = null;
let vectorOk = false;

function loadVectorExtension(db: SqliteDatabase): boolean {
  try {
    sqliteVec.load(db);
    // Verify vec0 exists by creating the virtual table on first run.
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
        embedding float[${CONFIG.embeddingDim}]
      );`,
    );
    return true;
  } catch (err) {
    console.warn(
      "[db] sqlite-vec extension unavailable -- vector search disabled until installed:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

export function openDb(): SqliteDatabase {
  if (dbSingleton) {
    return dbSingleton;
  }

  mkdirSync(CONFIG.dataDir, { recursive: true });
  const db = new BetterSqlite3(CONFIG.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  vectorOk = loadVectorExtension(db);

  const schemaPath = resolve(__dirname, "schema.sql");
  const schema = readFileSync(schemaPath, "utf8");
  db.exec(schema);

  runMigrations(db);

  dbSingleton = db;
  return db;
}

interface Migration {
  id: number;
  name: string;
  // A migration is either raw SQL or a guarded function. SQLite has no
  // `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so column-adds must use `run`
  // with a PRAGMA-based existence check to stay idempotent across both brand-new
  // DBs (where schema.sql already created the column) and pre-existing DBs.
  sql?: string;
  run?: (db: SqliteDatabase) => void;
}

function columnExists(db: SqliteDatabase, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

function tableExists(db: SqliteDatabase, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(table) as { name: string } | undefined;
  return Boolean(row);
}

const MIGRATIONS: Migration[] = [
  {
    // schema.sql gained `memory_points.summary_id` after the column-less DBs
    // shipped; CREATE TABLE IF NOT EXISTS never backfills it. The whole memory
    // ML layer filters `WHERE summary_id IS NULL`, so without this column every
    // consolidation/novelty/strength query throws "no such column: summary_id".
    id: 1,
    name: "0001-memory-points-summary-id",
    run: (db) => {
      if (!columnExists(db, "memory_points", "summary_id")) {
        db.exec(
          "ALTER TABLE memory_points ADD COLUMN summary_id TEXT REFERENCES memory_points(id) ON DELETE SET NULL",
        );
      }
    },
  },
  {
    // Phase 3 — hierarchy. Pre-existing DBs predate the `level` column on
    // cognitive_abstractions; without backfill, the recentAbstractions SELECT
    // and the level-aware classifier path would throw "no such column: level".
    // The default of 0 ("sensory") is deliberately the most conservative bucket
    // — a re-dream tick promotes them to their real level via upsertAbstraction.
    id: 2,
    name: "0002-cognitive-abstractions-level",
    run: (db) => {
      if (!columnExists(db, "cognitive_abstractions", "level")) {
        db.exec(
          "ALTER TABLE cognitive_abstractions ADD COLUMN level INTEGER NOT NULL DEFAULT 0",
        );
      }
      // Index creation is unconditional + idempotent so it covers BOTH a fresh
      // DB (the column came from schema.sql's CREATE TABLE, so the ALTER above is
      // skipped) and a legacy DB (the column came from the ALTER). It must live
      // here rather than in schema.sql: schema.sql is re-exec'd before migrations
      // on every boot, so a bare index on `level` there crashes pre-Phase-3 DBs.
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_cognitive_abstractions_level ON cognitive_abstractions(level)",
      );
    },
  },
  {
    // Phase 3 (improvement plan §18.7) — temporal cognition / future-self.
    // Adds a `timeline_role` column to cognitive_abstractions so each
    // abstraction is anchored on a past/now/future axis. The classifier in
    // core/abstractionLevels.ts assigns the role at upsert time; legacy rows
    // default to "now" (most conservative — they're at-the-moment captures
    // when their temporal role can't be inferred).
    id: 3,
    name: "0003-cognitive-abstractions-timeline-role",
    run: (db) => {
      if (!columnExists(db, "cognitive_abstractions", "timeline_role")) {
        db.exec(
          "ALTER TABLE cognitive_abstractions ADD COLUMN timeline_role TEXT NOT NULL DEFAULT 'now'",
        );
        db.exec(
          "CREATE INDEX IF NOT EXISTS idx_cognitive_abstractions_timeline_role ON cognitive_abstractions(timeline_role)",
        );
      }
    },
  },
  {
    // Blueprint #7 (causal world model) — explicit action-class → outcome-class
    // ledger. Backfills the `causal_links` table on DBs created before
    // schema.sql gained it. The schema CREATE IF NOT EXISTS handles fresh DBs;
    // this run() is the no-op-for-fresh / create-on-legacy path.
    id: 4,
    name: "0004-causal-links",
    run: (db) => {
      if (!tableExists(db, "causal_links")) {
        db.exec(`
          CREATE TABLE causal_links (
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
        `);
        db.exec(
          "CREATE INDEX IF NOT EXISTS idx_causal_links_cause  ON causal_links(cause_class)",
        );
        db.exec(
          "CREATE INDEX IF NOT EXISTS idx_causal_links_effect ON causal_links(effect_class)",
        );
      }
    },
  },
  {
    // Phase 3 (command/action layer) — audit trail for executed actions. The
    // schema CREATE IF NOT EXISTS handles fresh DBs; this run() creates the
    // table on a DB that predates it.
    id: 5,
    name: "0005-action-log",
    run: (db) => {
      if (!tableExists(db, "action_log")) {
        db.exec(`
          CREATE TABLE action_log (
            id          TEXT PRIMARY KEY,
            action_id   TEXT NOT NULL,
            args        TEXT NOT NULL DEFAULT '{}',
            risk        TEXT NOT NULL,
            confirmed   INTEGER NOT NULL DEFAULT 0,
            ok          INTEGER NOT NULL DEFAULT 0,
            summary     TEXT NOT NULL DEFAULT '',
            created_at  TEXT NOT NULL
          );
        `);
        db.exec("CREATE INDEX IF NOT EXISTS idx_action_log_time   ON action_log(created_at DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_action_log_action ON action_log(action_id, created_at DESC)");
      }
    },
  },
  {
    // Phase 2 (computer-wide ingestion) — consent (opt-in) + run audit tables.
    // Schema CREATE IF NOT EXISTS covers fresh DBs; this creates them on a DB
    // that predates the feature.
    id: 6,
    name: "0006-ingest-tables",
    run: (db) => {
      if (!tableExists(db, "ingest_consent")) {
        db.exec(`
          CREATE TABLE ingest_consent (
            source_id   TEXT PRIMARY KEY,
            enabled     INTEGER NOT NULL DEFAULT 0,
            updated_at  TEXT NOT NULL
          );
        `);
      }
      if (!tableExists(db, "ingest_log")) {
        db.exec(`
          CREATE TABLE ingest_log (
            id          TEXT PRIMARY KEY,
            source_id   TEXT NOT NULL,
            received    INTEGER NOT NULL DEFAULT 0,
            ingested    INTEGER NOT NULL DEFAULT 0,
            deduped     INTEGER NOT NULL DEFAULT 0,
            redacted    INTEGER NOT NULL DEFAULT 0,
            skipped     INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL
          );
        `);
        db.exec("CREATE INDEX IF NOT EXISTS idx_ingest_log_time   ON ingest_log(created_at DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_ingest_log_source ON ingest_log(source_id, created_at DESC)");
      }
    },
  },
  {
    // Phase 4 (learning from use) — usefulness verdicts on memories/actions.
    id: 7,
    name: "0007-usage-feedback",
    run: (db) => {
      if (!tableExists(db, "usage_feedback")) {
        db.exec(`
          CREATE TABLE usage_feedback (
            id          TEXT PRIMARY KEY,
            kind        TEXT NOT NULL,
            target_id   TEXT NOT NULL,
            rating      INTEGER NOT NULL,
            created_at  TEXT NOT NULL
          );
        `);
        db.exec("CREATE INDEX IF NOT EXISTS idx_usage_feedback_kind ON usage_feedback(kind, created_at DESC)");
      }
    },
  },
  {
    // Agentic loop ("main thinking") — honest authorisation channel on the
    // action audit. Adds action_log.authorized_via so the granted-session-scope
    // path can run a confirm-tier action WITHOUT forging a per-plan confirm
    // (confirmed stays 0; authorized_via='session-scope'). Fresh DBs get the
    // column from schema.sql's CREATE TABLE; this backfills pre-existing DBs and
    // sets a faithful value for legacy rows (confirmed → 'confirm-token').
    id: 8,
    name: "0008-action-log-authorized-via",
    run: (db) => {
      if (!columnExists(db, "action_log", "authorized_via")) {
        db.exec("ALTER TABLE action_log ADD COLUMN authorized_via TEXT NOT NULL DEFAULT 'none'");
        // Faithful backfill: a confirmed legacy row presented a token; an
        // unconfirmed one that succeeded was a safe action.
        db.exec("UPDATE action_log SET authorized_via = 'confirm-token' WHERE confirmed = 1");
        db.exec("UPDATE action_log SET authorized_via = 'safe' WHERE confirmed = 0 AND risk = 'safe'");
      }
    },
  },
];

// Exported for the perception/memory selfchecks: they need to apply the
// migration logic to a raw better-sqlite3 connection without going through
// openDb()'s singleton (which can only point at one BRAIN_DB_PATH per process).
export function applyMigrations(db: SqliteDatabase): void {
  runMigrations(db);
}

function runMigrations(db: SqliteDatabase): void {
  const applied = new Set<string>(
    (db.prepare("SELECT name FROM schema_migrations").all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    try {
      if (m.run) {
        m.run(db);
      } else if (m.sql) {
        db.exec(m.sql);
      }
      // Only record success once the migration body ran without throwing, so a
      // transient failure retries on the next boot instead of being skipped.
      db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(
        m.id,
        m.name,
        new Date().toISOString(),
      );
      console.info(`[db] migration applied: ${m.name}`);
    } catch (err) {
      console.error(`[db] migration "${m.name}" failed:`, err);
    }
  }
}

export function isVectorAvailable(): boolean {
  return vectorOk;
}

export function closeDb(): void {
  if (dbSingleton) {
    dbSingleton.close();
    dbSingleton = null;
  }
}
