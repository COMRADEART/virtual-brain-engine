import { test } from "node:test";
import assert from "node:assert/strict";
import BetterSqlite3 from "better-sqlite3";
import { applyMemoryRetrievalBoost } from "./consolidationEngine.js";

// memory_points copied verbatim from db/schema.sql (only table the
// importance-write path touches with the injected db).
function makeDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(":memory:");
  db.exec(`CREATE TABLE memory_points (
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
  );`);
  return db;
}

test("applyMemoryRetrievalBoost increases a retrieved memory's importance, never crushes it", () => {
  const db = makeDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO memory_points
       (id, source_type, content, content_hash, importance, created_at, updated_at)
     VALUES (?, 'conversation', ?, ?, ?, ?, ?)`,
  ).run("ret-m1", "body", "h1", 0.7, now, now);

  applyMemoryRetrievalBoost(["ret-m1"], db);

  const row = db
    .prepare("SELECT importance FROM memory_points WHERE id = ?")
    .get("ret-m1") as { importance: number };

  assert.ok(
    row.importance > 0.7,
    `retrieval should boost importance above 0.7, got ${row.importance}`,
  );
});
