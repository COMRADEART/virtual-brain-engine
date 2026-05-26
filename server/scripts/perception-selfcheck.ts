// Phase 3 — perception + hierarchy selfcheck.
//
// Gate for the two pieces of Phase 3:
//   (A) The 0002-cognitive-abstractions-level migration applies cleanly against
//       a fresh DB AND against a pre-existing DB that predates the column, and
//       the classifier returns plausible levels for representative concepts.
//   (B) The perception worker client returns status="down" gracefully when no
//       Python sidecar is running (the MVP must boot without it). probeWorker
//       must NOT bump the diagnostic counter on the down path.
//
// Hermetic: points BRAIN_DB_PATH at a temp DB before any import that calls
// openDb(). No real /data/brain.sqlite touched, no network required.
//
// Run: npm --prefix server run perception:selfcheck

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";

const tmp = mkdtempSync(join(tmpdir(), "brain-perceivecheck-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

// PERCEPTION_WORKER_URL must point at an unused loopback port so the probe
// can't accidentally reach a real worker on the developer's machine. 1 is
// privileged on most platforms; resolves instantly to ECONNREFUSED.
process.env.PERCEPTION_WORKER_URL = "http://127.0.0.1:1";

const { openDb, applyMigrations } = await import("../src/db/sqlite.js");
const { classifyAbstractionLevel } = await import("../src/core/abstractionLevels.js");
const { probeWorker, transcribe, caption } = await import("../src/perception/workerClient.js");
const { getDiagnosticCounts, resetDiagnostics } = await import("../src/util/diagnostics.js");
const { ABSTRACTION_LEVEL_LABELS } = await import("../../shared/imagination.js");

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

// =============================================================================
// (A) hierarchy — migration + classifier
// =============================================================================

// (A.1) Fresh DB: schema.sql alone should give us the level column + index.
const db = openDb();
const cols = (db.prepare("PRAGMA table_info(cognitive_abstractions)").all() as Array<{ name: string }>).map(
  (c) => c.name,
);
check("cognitive_abstractions has level column (fresh DB)", cols.includes("level"));
const mig = db
  .prepare("SELECT name FROM schema_migrations WHERE name = ?")
  .get("0002-cognitive-abstractions-level");
check("0002 migration recorded in schema_migrations", !!mig);
const idx = db
  .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?")
  .get("idx_cognitive_abstractions_level");
check("idx_cognitive_abstractions_level index exists", !!idx);

// (A.2) Backfill path: simulate a pre-existing DB that pre-dates the level
// column. We build the legacy shape directly with better-sqlite3 (bypassing
// openDb's singleton-per-path constraint), insert a row, then call
// applyMigrations() on the raw connection and assert ALTER TABLE added the
// column without dropping the row.
const legacy = new BetterSqlite3(join(tmp, "legacy.sqlite"));
// Build a fixture that resembles a real pre-Phase-3 DB: memory_points without
// summary_id (so migration 0001 also exercises) and cognitive_abstractions
// without level (so migration 0002 exercises). Keeps the test single-purpose
// but realistic — both migrations must coexist on a legacy DB.
legacy.exec(
  `CREATE TABLE memory_points (
     id TEXT PRIMARY KEY, source_type TEXT NOT NULL, content TEXT NOT NULL,
     content_hash TEXT NOT NULL, importance REAL NOT NULL DEFAULT 0.5,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL
   );
   CREATE TABLE cognitive_abstractions (
     id TEXT PRIMARY KEY, concept TEXT NOT NULL UNIQUE, evidence TEXT NOT NULL,
     confidence REAL NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
   );
   CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, applied_at TEXT NOT NULL);`,
);
legacy.prepare(
  `INSERT INTO cognitive_abstractions (id, concept, evidence, confidence, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?)`,
).run("legacy-1", "legacy concept", "[]", 0.5, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");

applyMigrations(legacy);

const legacyCols = (legacy.prepare("PRAGMA table_info(cognitive_abstractions)").all() as Array<{ name: string }>).map(
  (c) => c.name,
);
check("ALTER TABLE backfilled level column on legacy DB", legacyCols.includes("level"));
const legacyRow = legacy
  .prepare("SELECT id, concept, level FROM cognitive_abstractions WHERE id = ?")
  .get("legacy-1") as { id: string; concept: string; level: number } | undefined;
check(
  "legacy row preserved through migration",
  !!legacyRow && legacyRow.concept === "legacy concept" && legacyRow.level === 0,
  legacyRow ? `level=${legacyRow.level}` : "row missing",
);
const legacyMig = legacy
  .prepare("SELECT name FROM schema_migrations WHERE name = ?")
  .get("0002-cognitive-abstractions-level");
check("0002 migration recorded on legacy DB", !!legacyMig);

// Re-running applyMigrations is a no-op (idempotent) — verify.
applyMigrations(legacy);
const legacyColsTwice = (legacy.prepare("PRAGMA table_info(cognitive_abstractions)").all() as Array<{ name: string }>)
  .map((c) => c.name)
  .filter((n) => n === "level").length;
check("applyMigrations() is idempotent (no duplicate level column)", legacyColsTwice === 1);
legacy.close();

// (A.3) classifier — representative cases. The classifier is deterministic; if
// these break, the ladder definitions changed and the migration backfill
// semantics need a fresh look too.
type Case = { concept: string; evidence: string[]; expected: number };
const cases: Case[] = [
  { concept: "", evidence: [], expected: 0 }, // empty -> 0 sensory
  { concept: "Rust", evidence: [], expected: 2 }, // single concept word -> 2
  { concept: "tauri project", evidence: [], expected: 2 }, // named concept
  {
    concept: "User develops memory-centered adaptive systems",
    evidence: ["build a workflow", "build a pipeline"],
    expected: 3,
  }, // schema (develops + workflow)
  {
    concept: "User favors predictive safety before execution",
    evidence: ["simulate", "risk"],
    expected: 4,
  }, // principle (favors + safety)
  {
    concept: "Self-modifying systems must remain auditable — an ethical principle",
    evidence: [],
    expected: 5,
  }, // philosophical (ethic + must)
];
for (const c of cases) {
  const got = classifyAbstractionLevel(c.concept, c.evidence);
  check(
    `classify("${c.concept.slice(0, 40)}...") -> ${c.expected} (${ABSTRACTION_LEVEL_LABELS[c.expected as 0 | 1 | 2 | 3 | 4 | 5]})`,
    got === c.expected,
    `got=${got}`,
  );
}

// =============================================================================
// (B) perception worker client — graceful "down" without the sidecar
// =============================================================================

resetDiagnostics();
const status = await probeWorker();
check("probeWorker() returns status='down' when no sidecar", status.status === "down");
check("probeWorker() reports models.whisper='unavailable' when down", status.models.whisper === "unavailable");
check("probeWorker() reports models.caption='unavailable' when down", status.models.caption === "unavailable");
check(
  "probeWorker() does not bump diagnostic counter (quiet probe)",
  (getDiagnosticCounts()["perception:probe"] ?? 0) === 0,
  JSON.stringify(getDiagnosticCounts()),
);

// Real calls (transcribe/caption) on a down worker MUST return ok:false but
// MUST also bump the diagnostic counter — those are real failures, not probes.
const trans = await transcribe({ audioBase64: "AA==" });
check("transcribe() on down worker returns ok:false", !trans.ok);
const cap = await caption({ imageBase64: "AA==" });
check("caption() on down worker returns ok:false", !cap.ok);
const counts = getDiagnosticCounts();
check(
  "transcribe failure surfaced via diagnostics",
  (counts["perception:transcribe"] ?? 0) >= 1,
  JSON.stringify(counts),
);
check(
  "caption failure surfaced via diagnostics",
  (counts["perception:caption"] ?? 0) >= 1,
  JSON.stringify(counts),
);

// =============================================================================
// (C) HTTP body-size — global 1mb parser must NOT intercept /api/perceive/*
// =============================================================================
//
// This catches the bug class the worker-client tests above can't see: the
// global express.json({ limit: "1mb" }) in index.ts would reject a >1mb
// perception payload at the parser layer, before the router's own 20mb
// parser ever ran. We spin up a tiny in-process server that replicates the
// index.ts middleware order, then assert:
//   - /api/health rejects a 2mb POST with 413 (1mb floor preserved)
//   - /api/perceive/transcribe ACCEPTS a 2mb POST (status != 413; the worker
//     is down so we get 503, which is the expected "passed body-parser
//     stage, hit the worker shim" signal)

const express = (await import("express")).default;
const { perceptionRouter } = await import("../src/perception/index.js");

const testApp = express();
const localBodyParser = express.json({ limit: "1mb" });
testApp.use((req, res, next) => {
  if (req.path.startsWith("/api/perceive/")) return next();
  return localBodyParser(req, res, next);
});
testApp.post("/api/health", (_req, res) => res.json({ db: "ok" }));
testApp.use("/api", perceptionRouter);
// Quiet error middleware — Express's default logs the PayloadTooLargeError
// stack to stderr, which is noisy and looks like a real failure in the
// selfcheck output. We assert on the 413 status instead.
testApp.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = (err as { status?: number; statusCode?: number }).status
    ?? (err as { statusCode?: number }).statusCode ?? 500;
  if (!res.headersSent) res.status(status).json({ error: "test" });
});

const httpServer = await new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
  const srv = testApp.listen(0, "127.0.0.1", () => {
    const addr = srv.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    resolve({
      port,
      close: () => new Promise<void>((r) => srv.close(() => r())),
    });
  });
});

async function postJson(path: string, payload: object): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${httpServer.port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  // Drain so the connection releases for the next request.
  await res.text().catch(() => "");
  return res.status;
}

// 2mb base64 string fits in a JSON {"audioBase64": "..."} envelope between
// 2mb and 3mb on the wire — well above the 1mb global floor, well below the
// 20mb perception cap.
const bigPayload = "A".repeat(2 * 1024 * 1024);
const smallPayload = "A".repeat(1024);

const healthBig = await postJson("/api/health", { junk: bigPayload });
check("global 1mb parser rejects 2mb POST to /api/health (413)", healthBig === 413, `got ${healthBig}`);

const healthSmall = await postJson("/api/health", { junk: smallPayload });
check("global parser accepts small POST to /api/health", healthSmall === 200, `got ${healthSmall}`);

const perceiveBig = await postJson("/api/perceive/transcribe", { audioBase64: bigPayload });
// 503 = worker down (expected — we set PERCEPTION_WORKER_URL to an unreachable
// port at the top of this file). The point is it MUST NOT be 413, which would
// mean the global parser ate the body before the router's 20mb cap could act.
check(
  "perception router accepts 2mb POST (body-parser bypass works)",
  perceiveBig !== 413,
  `got ${perceiveBig}`,
);

await httpServer.close();

// NOTE on the exit pattern: every selfcheck in this dir prints "ALL CHECKS
// PASSED" / "N CHECK(S) FAILED" and then process.exit(). On Windows under
// tsx + better-sqlite3 this triggers a libuv UV_HANDLE_CLOSING abort that
// surfaces as PowerShell -4058 / npm exit 38 even on success. The gate
// signal is the stdout PASSED line, not the OS-level exit code — same as
// memory-selfcheck.ts (run it standalone to confirm). If you ever need a
// clean exit code, drop tsx and pre-compile with tsc first; not worth it
// for a developer-loop selfcheck.
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
