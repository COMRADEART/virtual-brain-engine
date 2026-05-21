import { test } from "node:test";
import assert from "node:assert/strict";
import BetterSqlite3 from "better-sqlite3";
import { getMemoriesForConsolidation } from "./memoryLifecycle.js";

// memory_points + memory_relations copied verbatim from db/schema.sql.
// The correlated citation_count subquery needs memory_relations to exist.
function makeDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(":memory:");
  db.exec(`
    CREATE TABLE memory_points (
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
    CREATE TABLE memory_relations (
      id          TEXT PRIMARY KEY,
      from_id     TEXT NOT NULL,
      to_id       TEXT NOT NULL,
      kind        TEXT NOT NULL,
      weight      REAL NOT NULL DEFAULT 1.0,
      created_at  TEXT NOT NULL
    );
  `);
  return db;
}

function insertMemory(
  db: BetterSqlite3.Database,
  id: string,
  importance: number,
  ageDays: number,
): void {
  const ts = new Date(Date.now() - ageDays * 86_400_000).toISOString();
  db.prepare(
    `INSERT INTO memory_points
       (id, source_type, content, content_hash, importance, created_at, updated_at)
     VALUES (?, 'conversation', ?, ?, ?, ?, ?)`,
  ).run(id, `content ${id}`, `hash ${id}`, importance, ts, ts);
}

test("getMemoriesForConsolidation returns stale low-importance conversation memories", () => {
  const db = makeDb();
  insertMemory(db, "stale", 0.2, 30); // qualifies: old + low importance
  insertMemory(db, "recent", 0.2, 1); // excluded: created < 7 days ago
  insertMemory(db, "important", 0.9, 30); // excluded: importance >= 0.5

  const rows = getMemoriesForConsolidation(10, db);

  assert.deepEqual(
    rows.map((r) => r.id),
    ["stale"],
  );
});
