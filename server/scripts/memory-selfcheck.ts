// Memory-layer selfcheck — the regression gate for the bug class fixed on the
// `tdd/memory-layer-fixes` branch. Unlike the pure-module selfchecks
// (ranker/agents/twin), the memory layer's bugs ARE the DB schema + the call
// graph, so this one opens a REAL (but throwaway) SQLite DB. It points
// CONFIG.dbPath at a temp file BEFORE importing anything that calls openDb(),
// so it never touches data/brain.sqlite. Run:
//   npm --prefix server run memory:selfcheck
//
// Asserts the three things that broke (or were added) this session:
//   (1) openDb() applies schema + migrations: memory_points.summary_id exists
//       and the 0001 migration is recorded in schema_migrations.
//   (2) getMemoryById(id) does not throw (the .get(id,id) arity bug that
//       RangeError-crashed the process) and assessNovelty() runs (the
//       `WHERE summary_id IS NULL` query that threw on un-migrated DBs).
//   (3) a failing strength write is surfaced (not silently swallowed):
//       getDiagnosticCounts() shows the source and the call does not throw.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";

// Redirect the DB to a throwaway dir BEFORE importing config-dependent modules.
const tmp = mkdtempSync(join(tmpdir(), "brain-memcheck-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const { openDb } = await import("../src/db/sqlite.js");
const { upsertMemoryPoint } = await import("../src/db/repositories/memory.js");
const { getMemoryById } = await import("../src/memory/memoryLifecycle.js");
const { assessNovelty } = await import("../src/memory/noveltyDetector.js");
const { updateMemoryStrength } = await import("../src/memory/memoryStrength.js");
const { getDiagnosticCounts } = await import("../src/util/diagnostics.js");

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

const db = openDb(); // applies schema.sql + runMigrations() against the temp DB

// (1) schema + migration
const cols = (db.prepare("PRAGMA table_info(memory_points)").all() as Array<{ name: string }>).map(
  (c) => c.name,
);
check("memory_points has summary_id column", cols.includes("summary_id"));
const mig = db
  .prepare("SELECT name FROM schema_migrations WHERE name = ?")
  .get("0001-memory-points-summary-id");
check("0001 migration recorded in schema_migrations", !!mig);

// (2) crash class: insert → getMemoryById (arity) → assessNovelty (summary_id query)
const point = upsertMemoryPoint({
  sourceType: "manual",
  content: "memory selfcheck content about neural architecture",
  contentHash: `selfcheck-${Date.now()}`,
  importance: 0.6,
});
let got: unknown = null;
let arityThrew = false;
try {
  got = getMemoryById(point.id);
} catch (err) {
  arityThrew = true;
  console.log("  getMemoryById threw:", err instanceof Error ? err.message : err);
}
check("getMemoryById(id) does not throw (arity fix)", !arityThrew);
check("getMemoryById(id) returns the inserted row", !!got && (got as { id: string }).id === point.id);

let noveltyThrew = false;
try {
  assessNovelty("a distinct novel sentence for the selfcheck", null);
} catch (err) {
  noveltyThrew = true;
  console.log("  assessNovelty threw:", err instanceof Error ? err.message : err);
}
check("assessNovelty(...) does not throw (summary_id query)", !noveltyThrew);

// (3) swallowed-error surfacing: force a strength write to fail by passing a DB
// with no memory_points table; the catch must surface (count++) and not throw.
const brokenDb = new BetterSqlite3(":memory:"); // no schema → UPDATE will fail
let strengthThrew = false;
try {
  updateMemoryStrength(point.id, 0.1, brokenDb);
} catch (err) {
  strengthThrew = true;
  console.log("  updateMemoryStrength threw:", err instanceof Error ? err.message : err);
}
brokenDb.close();
const counts = getDiagnosticCounts();
check("failing updateMemoryStrength does not throw (swallow preserved)", !strengthThrew);
check(
  "failing updateMemoryStrength is surfaced via diagnostics counter",
  (counts["memoryStrength.updateMemoryStrength"] ?? 0) >= 1,
  JSON.stringify(counts),
);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
