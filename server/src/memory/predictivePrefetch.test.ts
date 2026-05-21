import { test } from "node:test";
import assert from "node:assert/strict";
import BetterSqlite3 from "better-sqlite3";
import {
  updateTemporalPattern,
  recordConversationSequence,
  predictFromTemporal,
} from "./predictivePrefetch.js";

// memory_temporal_patterns copied verbatim from db/schema.sql so the
// `created_at TEXT NOT NULL` (no DEFAULT) constraint is faithfully present.
function makeTemporalDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(":memory:");
  db.exec(`CREATE TABLE memory_temporal_patterns (
    id           TEXT PRIMARY KEY,
    memory_id    TEXT NOT NULL,
    hour_of_day  INTEGER NOT NULL,
    access_count INTEGER NOT NULL DEFAULT 1,
    last_access  TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );`);
  return db;
}

test("updateTemporalPattern records a temporal access row for an unseen memory", () => {
  const db = makeTemporalDb();

  updateTemporalPattern("m1", db);

  const row = db
    .prepare(
      "SELECT memory_id, access_count FROM memory_temporal_patterns WHERE memory_id = ?",
    )
    .get("m1") as { memory_id: string; access_count: number } | undefined;

  assert.ok(row, "expected a temporal-pattern row to be inserted");
  assert.equal(row.access_count, 1);
});

test("updateTemporalPattern takes the UPDATE branch on a same-hour repeat call", () => {
  const db = makeTemporalDb();

  // Two calls in immediate succession land in the same wall-clock hour, so
  // the second must hit the UPDATE branch — anything else (a second INSERT,
  // a swallowed exception, a no-op) is the silent defect we are guarding.
  updateTemporalPattern("m1", db);
  updateTemporalPattern("m1", db);

  const rows = db
    .prepare(
      "SELECT access_count FROM memory_temporal_patterns WHERE memory_id = ?",
    )
    .all("m1") as Array<{ access_count: number }>;

  assert.equal(rows.length, 1, "expected the UPDATE branch (one row), not a second INSERT");
  assert.equal(rows[0].access_count, 2);
});

test("updateTemporalPattern advances last_access on the UPDATE branch", () => {
  const db = makeTemporalDb();

  updateTemporalPattern("m1", db);
  const before = (db
    .prepare(
      "SELECT last_access FROM memory_temporal_patterns WHERE memory_id = ?",
    )
    .get("m1") as { last_access: string }).last_access;

  const start = Date.now();
  while (Date.now() === start) { /* spin until the wall clock advances */ }

  updateTemporalPattern("m1", db);
  const after = (db
    .prepare(
      "SELECT last_access FROM memory_temporal_patterns WHERE memory_id = ?",
    )
    .get("m1") as { last_access: string }).last_access;

  assert.ok(after > before, `expected last_access to advance (before=${before}, after=${after})`);
});

// memory_sequence_patterns copied verbatim from db/schema.sql.
function makeSequenceDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(":memory:");
  db.exec(`CREATE TABLE memory_sequence_patterns (
    id              TEXT PRIMARY KEY,
    sequence_pattern TEXT NOT NULL,
    next_id         TEXT,
    frequency       INTEGER NOT NULL DEFAULT 1,
    confidence      REAL NOT NULL DEFAULT 0.0,
    last_used       TEXT NOT NULL,
    created_at      TEXT NOT NULL
  );`);
  return db;
}

test("recordConversationSequence persists a sequence pattern after two accesses", () => {
  const db = makeSequenceDb();

  recordConversationSequence("s1", db); // length 1 -> no-op
  recordConversationSequence("s2", db); // length 2 -> inserts pattern "s1"

  const row = db
    .prepare(
      "SELECT sequence_pattern, next_id, frequency FROM memory_sequence_patterns WHERE sequence_pattern = ?",
    )
    .get("s1") as
    | { sequence_pattern: string; next_id: string; frequency: number }
    | undefined;

  assert.ok(row, "expected a sequence-pattern row to be inserted");
  assert.equal(row.next_id, "s2");
  assert.equal(row.frequency, 1);
});

// memory_points + memory_temporal_patterns copied verbatim from db/schema.sql.
function makeTemporalPredictDb(): BetterSqlite3.Database {
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
    CREATE TABLE memory_temporal_patterns (
      id           TEXT PRIMARY KEY,
      memory_id    TEXT NOT NULL,
      hour_of_day  INTEGER NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 1,
      last_access  TEXT NOT NULL,
      created_at   TEXT NOT NULL
    );
  `);
  return db;
}

function addMemory(
  db: BetterSqlite3.Database,
  id: string,
  importance: number,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO memory_points
       (id, source_type, content, content_hash, importance, created_at, updated_at)
     VALUES (?, 'conversation', ?, ?, ?, ?, ?)`,
  ).run(id, `c ${id}`, `h ${id}`, importance, now, now);
}

function addTemporal(
  db: BetterSqlite3.Database,
  memoryId: string,
  hour: number,
  accessCount: number,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO memory_temporal_patterns
       (id, memory_id, hour_of_day, access_count, last_access, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(`tp-${memoryId}`, memoryId, hour, accessCount, now, now);
}

test("predictFromTemporal returns importance-weighted memories active at the given hour", () => {
  const db = makeTemporalPredictDb();
  addMemory(db, "hot", 0.8); // qualifies
  addTemporal(db, "hot", 14, 5);
  addMemory(db, "lowImp", 0.1); // excluded: importance <= 0.3
  addTemporal(db, "lowImp", 14, 9);
  addMemory(db, "wrongHour", 0.9); // excluded: pattern at a different hour
  addTemporal(db, "wrongHour", 3, 9);

  const result = predictFromTemporal(14, 0, db);

  assert.equal(result.length, 1);
  assert.equal(result[0].category, "temporal");
  assert.deepEqual(result[0].memoryIds, ["hot"]);
});
