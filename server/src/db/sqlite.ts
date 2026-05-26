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
];

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
