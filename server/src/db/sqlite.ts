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
  sql: string;
}

const MIGRATIONS: Migration[] = [];

function runMigrations(db: SqliteDatabase): void {
  const applied = new Set<string>(
    (db.prepare("SELECT name FROM schema_migrations").all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    try {
      db.exec(m.sql);
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
