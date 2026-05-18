import { test } from "node:test";
import assert from "node:assert/strict";
import BetterSqlite3 from "better-sqlite3";
import { loadThresholds } from "./thresholdController.js";

// brain_metadata copied verbatim from db/schema.sql.
function makeMetaDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(":memory:");
  db.exec(`CREATE TABLE brain_metadata (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );`);
  return db;
}

test("loadThresholds returns the persisted thresholds, not the defaults", () => {
  const db = makeMetaDb();
  const persisted = {
    forget: 0.11,
    consolidate: 0.41,
    promote: 0.71,
    archive: 0.21,
    decayRate: 0.061,
  };
  db.prepare(
    "INSERT INTO brain_metadata (key, value) VALUES ('adaptive_thresholds', ?)",
  ).run(JSON.stringify(persisted));

  const result = loadThresholds(db);

  // DEFAULT_THRESHOLDS.forget is 0.08 — if the query throws and is
  // swallowed, defaults come back and this fails.
  assert.equal(result.forget, 0.11);
  assert.equal(result.consolidate, 0.41);
  assert.equal(result.promote, 0.71);
});
