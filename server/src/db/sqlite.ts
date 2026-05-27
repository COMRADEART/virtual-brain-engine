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
        db.exec(
          "CREATE INDEX IF NOT EXISTS idx_cognitive_abstractions_level ON cognitive_abstractions(level)",
        );
      }
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
