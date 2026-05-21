import { test } from "node:test";
import assert from "node:assert/strict";
import BetterSqlite3 from "better-sqlite3";
import { updateMemoryStrength, batchUpdateStrength } from "./memoryStrength.js";

function makeMemoryDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(":memory:");
  db.exec(`CREATE TABLE memory_points (
    id          TEXT PRIMARY KEY,
    importance  REAL NOT NULL DEFAULT 0.5,
    updated_at  TEXT
  );`);
  return db;
}

test("updateMemoryStrength persists the importance delta to the row", () => {
  const db = makeMemoryDb();
  db.prepare(
    "INSERT INTO memory_points (id, importance, updated_at) VALUES (?, ?, ?)",
  ).run("m1", 0.5, new Date().toISOString());

  updateMemoryStrength("m1", 0.2, db);

  const row = db
    .prepare("SELECT importance FROM memory_points WHERE id = ?")
    .get("m1") as { importance: number };
  assert.equal(row.importance, 0.7);
});

test("batchUpdateStrength applies each delta to its row", () => {
  const db = makeMemoryDb();
  const insert = db.prepare(
    "INSERT INTO memory_points (id, importance, updated_at) VALUES (?, ?, ?)",
  );
  const now = new Date().toISOString();
  insert.run("a", 0.5, now);
  insert.run("b", 0.5, now);

  batchUpdateStrength(
    [
      { id: "a", delta: 0.25 },
      { id: "b", delta: -0.25 },
    ],
    db,
  );

  const get = db.prepare("SELECT importance FROM memory_points WHERE id = ?");
  assert.equal((get.get("a") as { importance: number }).importance, 0.75);
  assert.equal((get.get("b") as { importance: number }).importance, 0.25);
});
