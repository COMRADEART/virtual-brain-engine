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
