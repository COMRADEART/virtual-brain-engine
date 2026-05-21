import { test } from "node:test";
import assert from "node:assert/strict";
import BetterSqlite3 from "better-sqlite3";
import { buildAccessPattern } from "./accessPatternTracker.js";

// memory_access_patterns copied verbatim from db/schema.sql so the
// `created_at TEXT NOT NULL` (no DEFAULT) constraint is faithfully present.
function makeAccessDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(":memory:");
  db.exec(`CREATE TABLE memory_access_patterns (
    id               TEXT PRIMARY KEY,
    memory_a         TEXT NOT NULL,
    memory_b         TEXT NOT NULL,
    coaccess_count   INTEGER NOT NULL DEFAULT 1,
    total_activation_b REAL NOT NULL DEFAULT 0,
    last_coaccess    TEXT NOT NULL,
    created_at       TEXT NOT NULL
  );`);
  return db;
}

test("buildAccessPattern persists a new co-access row for an unseen pair", () => {
  const db = makeAccessDb();

  buildAccessPattern("a", "b", db);

  const row = db
    .prepare(
      "SELECT memory_a, memory_b, coaccess_count FROM memory_access_patterns WHERE memory_a = ? AND memory_b = ?",
    )
    .get("a", "b") as
    | { memory_a: string; memory_b: string; coaccess_count: number }
    | undefined;

  assert.ok(row, "expected a co-access row to be inserted");
  assert.equal(row.coaccess_count, 1);
});

test("buildAccessPattern increments coaccess_count on a repeat call instead of inserting", () => {
  const db = makeAccessDb();

  buildAccessPattern("a", "b", db);
  buildAccessPattern("a", "b", db);

  const rows = db
    .prepare(
      "SELECT memory_a, memory_b, coaccess_count FROM memory_access_patterns",
    )
    .all() as Array<{ memory_a: string; memory_b: string; coaccess_count: number }>;

  assert.equal(rows.length, 1, "expected the UPDATE branch (one row), not a second INSERT");
  assert.equal(rows[0].coaccess_count, 2);
});

test("buildAccessPattern matches the reversed pair as the same edge", () => {
  const db = makeAccessDb();

  buildAccessPattern("a", "b", db);
  buildAccessPattern("b", "a", db);

  const rows = db
    .prepare(
      "SELECT memory_a, memory_b, coaccess_count FROM memory_access_patterns",
    )
    .all() as Array<{ memory_a: string; memory_b: string; coaccess_count: number }>;

  assert.equal(rows.length, 1, "the (b, a) call must hit the existing (a, b) row");
  assert.equal(rows[0].coaccess_count, 2);
});

test("buildAccessPattern advances last_coaccess on the UPDATE branch", () => {
  const db = makeAccessDb();

  buildAccessPattern("a", "b", db);
  const before = (db
    .prepare("SELECT last_coaccess FROM memory_access_patterns")
    .get() as { last_coaccess: string }).last_coaccess;

  // The function records last_coaccess via new Date().toISOString(). Two
  // calls in the same millisecond would produce identical timestamps; busy-
  // wait briefly so the second call lands on a strictly later ISO string.
  const start = Date.now();
  while (Date.now() === start) { /* spin */ }

  buildAccessPattern("a", "b", db);
  const after = (db
    .prepare("SELECT last_coaccess FROM memory_access_patterns")
    .get() as { last_coaccess: string }).last_coaccess;

  assert.ok(after > before, `expected last_coaccess to advance (before=${before}, after=${after})`);
});
