// Memory dedup-audit selfcheck — hermetic (throwaway DB via BRAIN_DB_PATH, no
// LLM, no network, no real vector extension required). Mirrors the temp-DB
// pattern of brainstate-selfcheck.ts.
//
// Run: npm --prefix server run dedup:selfcheck
//
// Why this exists: dedupAudit had NO selfcheck, so a wrong-column SQL bug in
// mergePair (`source_id`/`target_id` instead of the real `from_id`/`to_id`)
// shipped green — the boot-time auto-merge is failure-isolated, so `npm run gate`
// (which never runs a merge) couldn't see it; only a live boot surfaced
// `SqliteError: no such column: source_id`. This locks the contract.
//
// Asserts:
//   (A) mergePair(keep, delete) does NOT throw and uses valid columns.
//   (B) the deleted memory_point is gone; the kept one remains.
//   (C) relations referencing the deleted memory (in EITHER direction:
//       from_id OR to_id) are removed.
//   (D) the kept memory's importance is bumped (+0.05, capped at 1.0).
//   (E) runDedupAudit returns a well-formed result and does not throw on a
//       small set (the scan path runs clean).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

// Throwaway DB BEFORE importing anything that opens it.
const tmp = mkdtempSync(join(tmpdir(), "brain-dedup-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const { openDb } = await import("../src/db/sqlite.js");
const { runDedupAudit, mergePair } = await import("../src/memory/dedupAudit.js");

const db = openDb(); // applies schema.sql → memory_points, memory_relations, …

// memory_vec is a virtual table created only when sqlite-vec loads. mergePair
// touches it (line: DELETE FROM memory_vec WHERE rowid = (...)). Ensure a table
// of that name EXISTS so the check is hermetic regardless of extension state —
// a no-op if the real virtual table already loaded.
try {
  db.exec("CREATE TABLE IF NOT EXISTS memory_vec (rowid INTEGER PRIMARY KEY, embedding BLOB)");
} catch {
  /* virtual table already present — fine */
}

const now = "2026-06-09T00:00:00.000Z";
function insertMemory(id: string, content: string): void {
  db.prepare(
    `INSERT INTO memory_points (id, source_type, content, content_hash, importance, created_at, updated_at)
     VALUES (?, 'manual', ?, ?, 0.5, ?, ?)`,
  ).run(id, content, `hash-${id}`, now, now);
}
function insertRelation(id: string, fromId: string, toId: string): void {
  db.prepare(
    `INSERT INTO memory_relations (id, from_id, to_id, kind, created_at) VALUES (?, ?, ?, 'related', ?)`,
  ).run(id, fromId, toId, now);
}

// A = keep, B = delete (the near-duplicate). embedding_id stays NULL so the
// memory_vec sub-delete is a harmless no-op (NULL matches no rowid).
insertMemory("A", "the auth token expires after one hour");
insertMemory("B", "the auth token expires after one hour (dup)");
insertRelation("r1", "B", "A"); // B is the from-side
insertRelation("r2", "A", "B"); // B is the to-side
insertRelation("r3", "A", "A"); // unrelated to B — must survive

let threw = false;
try {
  mergePair("A", "B");
} catch (err) {
  threw = true;
  check("mergePair does not throw", false, err instanceof Error ? err.message : String(err));
}
if (!threw) check("mergePair does not throw (valid columns)", true);

const bGone = db.prepare(`SELECT COUNT(*) AS n FROM memory_points WHERE id = 'B'`).get() as { n: number };
check("deleted memory_point is gone", bGone.n === 0);

const aKept = db.prepare(`SELECT importance AS imp FROM memory_points WHERE id = 'A'`).get() as
  | { imp: number }
  | undefined;
check("kept memory_point remains", aKept !== undefined);
check("kept memory importance bumped +0.05", !!aKept && Math.abs(aKept.imp - 0.55) < 1e-9, `imp=${aKept?.imp}`);

const relsToB = db
  .prepare(`SELECT COUNT(*) AS n FROM memory_relations WHERE from_id = 'B' OR to_id = 'B'`)
  .get() as { n: number };
check("relations referencing the deleted memory are removed (from_id OR to_id)", relsToB.n === 0);

const relAA = db.prepare(`SELECT COUNT(*) AS n FROM memory_relations WHERE id = 'r3'`).get() as { n: number };
check("unrelated relation survives the merge", relAA.n === 1);

// runDedupAudit must run its scan query without throwing and return a shaped
// result. With embedding_id NULL the memory_vec JOIN yields 0 scannable rows —
// the early-return path — which is exactly what we want to prove runs clean.
let auditThrew = false;
let scanned = -1;
try {
  const res = runDedupAudit({ similarityThreshold: 0.92, maxPairsPerRun: 50 });
  scanned = res.scanned;
} catch (err) {
  auditThrew = true;
  check("runDedupAudit does not throw", false, err instanceof Error ? err.message : String(err));
}
if (!auditThrew) {
  check("runDedupAudit returns a well-formed result", scanned >= 0, `scanned=${scanned}`);
}

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
