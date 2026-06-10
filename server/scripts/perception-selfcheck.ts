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

import { mkdtempSync, readFileSync } from "node:fs";
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
const { classifyAbstractionLevel, classifyTimelineRole, timelineRoleSet } = await import(
  "../src/core/abstractionLevels.js"
);
const { probeWorker, transcribe, caption, parseFrame } = await import(
  "../src/perception/workerClient.js"
);
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

// Phase 3 (improvement plan §18.7) — timeline_role column on fresh DB.
check("cognitive_abstractions has timeline_role column (fresh DB)", cols.includes("timeline_role"));
const mig3 = db
  .prepare("SELECT name FROM schema_migrations WHERE name = ?")
  .get("0003-cognitive-abstractions-timeline-role");
check("0003 migration recorded in schema_migrations", !!mig3);
const idx3 = db
  .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?")
  .get("idx_cognitive_abstractions_timeline_role");
check("idx_cognitive_abstractions_timeline_role index exists", !!idx3);

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

// 0003 — timeline_role backfilled on the legacy DB.
const legacyColsAfter3 = (legacy.prepare("PRAGMA table_info(cognitive_abstractions)").all() as Array<{ name: string }>).map(
  (c) => c.name,
);
check("ALTER TABLE backfilled timeline_role column on legacy DB", legacyColsAfter3.includes("timeline_role"));
const legacyTimelineRow = legacy
  .prepare("SELECT id, timeline_role FROM cognitive_abstractions WHERE id = ?")
  .get("legacy-1") as { id: string; timeline_role: string } | undefined;
check(
  "legacy row gets timeline_role='now' default",
  !!legacyTimelineRow && legacyTimelineRow.timeline_role === "now",
  legacyTimelineRow ? `timeline_role=${legacyTimelineRow.timeline_role}` : "row missing",
);
const legacyMig3 = legacy
  .prepare("SELECT name FROM schema_migrations WHERE name = ?")
  .get("0003-cognitive-abstractions-timeline-role");
check("0003 migration recorded on legacy DB", !!legacyMig3);

legacy.close();

// (A.2b) Boot-sequence regression — the failure the isolated applyMigrations()
// test above CANNOT see. A real boot (openDb) runs the FULL schema.sql against
// the existing DB *before* migrations: exec(schema) → runMigrations. If
// schema.sql carries a bare index on a column that only a later migration adds
// (the `level` index regression), exec(schema) throws "no such column: level"
// and the server never boots — yet applyMigrations() alone stays green, which is
// exactly why the green gate shipped a dead server. Replay that exact sequence:
// pre-create ONLY the regressed (level-less) cognitive_abstractions, let
// schema.sql build every other table fresh, assert the schema re-exec is clean,
// then assert migrations still backfill the column without losing the row.
const bootDb = new BetterSqlite3(join(tmp, "bootseq.sqlite"));
bootDb.exec(
  `CREATE TABLE cognitive_abstractions (
     id TEXT PRIMARY KEY, concept TEXT NOT NULL UNIQUE, evidence TEXT NOT NULL,
     confidence REAL NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
   );`,
);
bootDb
  .prepare(
    `INSERT INTO cognitive_abstractions (id, concept, evidence, confidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  .run("boot-1", "boot concept", "[]", 0.5, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");

const schemaSql = readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8");
let schemaReplayOk = true;
let schemaReplayErr = "";
try {
  bootDb.exec(schemaSql); // exactly the openDb() exec(schema) step, on a pre-`level` DB
} catch (e) {
  schemaReplayOk = false;
  schemaReplayErr = e instanceof Error ? e.message : String(e);
}
check(
  "schema.sql re-exec on pre-`level` DB does not throw (server-boot crash regression)",
  schemaReplayOk,
  schemaReplayErr,
);

if (schemaReplayOk) {
  applyMigrations(bootDb); // the runMigrations() step that follows exec(schema)
  const bootCols = (
    bootDb.prepare("PRAGMA table_info(cognitive_abstractions)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  check("boot sequence backfills level column (schema -> migrations)", bootCols.includes("level"));
  const bootRow = bootDb
    .prepare("SELECT level FROM cognitive_abstractions WHERE id = ?")
    .get("boot-1") as { level: number } | undefined;
  check("pre-existing row survived the boot sequence", !!bootRow && bootRow.level === 0);
}
bootDb.close();

// Phase 3 — classifyTimelineRole pure-function cases.
type TimelineCase = { concept: string; evidence: string[]; expected: "past" | "now" | "future" };
const timelineCases: TimelineCase[] = [
  { concept: "", evidence: [], expected: "now" }, // empty → now
  { concept: "User used to ship Rust crates weekly", evidence: [], expected: "past" }, // 'used to'
  { concept: "User plans to migrate to Tauri 3", evidence: [], expected: "future" }, // 'plans to'
  { concept: "Current Tauri project structure", evidence: [], expected: "now" }, // no temporal token
  { concept: "Roadmap: ship perception streaming next quarter", evidence: [], expected: "future" }, // roadmap+next quarter
  { concept: "Previously the brain used SignalSimulation only", evidence: [], expected: "past" }, // previously
];
for (const c of timelineCases) {
  const got = classifyTimelineRole(c.concept, c.evidence);
  check(
    `classifyTimelineRole("${c.concept.slice(0, 40)}...") -> ${c.expected}`,
    got === c.expected,
    `got=${got}`,
  );
}
check(
  "timelineRoleSet() exposes exactly 3 roles",
  timelineRoleSet().length === 3 &&
    timelineRoleSet().includes("past") &&
    timelineRoleSet().includes("now") &&
    timelineRoleSet().includes("future"),
);

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
// (B2) Phase 2 — frame parse client + OmniParser probe state (worker down)
// =============================================================================

const frame = await parseFrame({ imageBase64: "AA==" });
check("parseFrame() on down worker returns ok:false", !frame.ok);
check(
  "parseFrame() surfaces perception:frame diagnostic",
  (getDiagnosticCounts()["perception:frame"] ?? 0) >= 1,
  JSON.stringify(getDiagnosticCounts()),
);
check(
  "probeWorker() reports models.omniparser='unavailable' when down",
  status.models.omniparser === "unavailable",
);

// =============================================================================
// (B3) Phase 2 — perception INGESTION: a frame becomes a retrievable MemoryPoint
// =============================================================================
//
// This is the genuinely-verifiable half (the OmniParser model can't run here
// without torch). We feed SYNTHETIC parsed-frame text + embeddings straight
// into ingestPerceptionMemory and assert the retrieval plumbing + the dedup
// governance gate behave.

const { ingestPerceptionMemory, countPerceptionMemories, DEDUP_COS, PERCEPTION_IMPORTANCE } =
  await import("../src/vision/perceptionMemory.js");
const { isVectorAvailable } = await import("../src/db/sqlite.js");
const { getStoredEmbedding } = await import("../src/memory/embeddingSimilarity.js");
const { CONFIG } = await import("../src/config.js");
const { getMemoryPoint } = await import("../src/db/repositories/memory.js");

const DIM = CONFIG.embeddingDim;
const vectorOk = isVectorAvailable();
check("sqlite-vec extension available (vector path exercised)", vectorOk, vectorOk ? "" : "no vec — string-only path");

// Empty/whitespace content is rejected before any DB work.
const emptyIngest = await ingestPerceptionMemory({ content: "   " });
check("ingestPerceptionMemory rejects empty content", !emptyIngest.stored && emptyIngest.reason === "empty");
check("empty ingest stored nothing", countPerceptionMemories() === 0);

if (vectorOk) {
  // A clean base vector: first half ones, second half zeros (so the orthogonal
  // complement gives an unambiguous cosine 0 distinct frame later).
  const base = new Array<number>(DIM).fill(0).map((_, i) => (i < DIM / 2 ? 1 : 0));

  const first = await ingestPerceptionMemory({
    content: "VS Code — editing reasoning/pipeline.ts",
    embedding: base,
    sourceApp: "Code.exe",
    windowTitle: "pipeline.ts — star",
  });
  check("first perception frame stores", first.stored && first.reason === "stored", JSON.stringify(first));
  check("countPerceptionMemories() === 1 after first store", countPerceptionMemories() === 1);

  const memId = first.memoryId!;
  const row = memId ? getMemoryPoint(memId) : null;
  check(
    "stored row is source_type='manual' + metadata.kind='perception'",
    !!row && row.sourceType === "manual" && (row.metadata?.kind as string) === "perception",
    row ? `sourceType=${row.sourceType} kind=${String(row.metadata?.kind)}` : "row missing",
  );
  check(
    "perception importance is discounted to PERCEPTION_IMPORTANCE",
    !!row && Math.abs(row.importance - PERCEPTION_IMPORTANCE) < 1e-9,
    row ? `importance=${row.importance}` : "row missing",
  );
  const roundTrip = getStoredEmbedding(memId);
  check(
    "stored embedding round-trips (vector persisted)",
    !!roundTrip && roundTrip.length === DIM,
    roundTrip ? `len=${roundTrip.length}` : "null",
  );

  // --- Dedup governance: 49 near-identical frames must NOT flood the pool. ---
  // Each is base + tiny noise (~1e-3) -> cosine ~0.999 >> DEDUP_COS.
  let dupCount = 0;
  for (let n = 0; n < 49; n += 1) {
    const noisy = base.map((v, i) => v + ((i % 7) - 3) * 1e-3);
    const r = await ingestPerceptionMemory({
      content: `VS Code — editing reasoning/pipeline.ts (tick ${n})`,
      embedding: noisy,
      windowTitle: "pipeline.ts — star",
    });
    if (r.reason === "duplicate") dupCount += 1;
  }
  check("near-identical frames are flagged duplicate (cos > DEDUP_COS)", dupCount === 49, `dups=${dupCount}`);
  check(
    "high-volume repetitive stream did NOT flood retrieval (still 1)",
    countPerceptionMemories() === 1,
    `count=${countPerceptionMemories()} DEDUP_COS=${DEDUP_COS}`,
  );

  // --- A genuinely DISTINCT frame (orthogonal vector) DOES store. ---
  const distinct = new Array<number>(DIM).fill(0).map((_, i) => (i >= DIM / 2 ? 1 : 0));
  const distinctRes = await ingestPerceptionMemory({
    content: "Firefox — reading docs/CIVILIZATION_ARCHITECTURE.md",
    embedding: distinct,
    windowTitle: "Firefox",
  });
  check("distinct (orthogonal) frame stores", distinctRes.stored && distinctRes.reason === "stored");
  check("countPerceptionMemories() === 2 after distinct frame", countPerceptionMemories() === 2);
} else {
  // No vec extension: the no-embedding path must still store (string-only),
  // and the dedup gate is skipped (no geometry to compare).
  const a = await ingestPerceptionMemory({ content: "VS Code — editing reasoning/pipeline.ts" });
  check("string-only perception frame stores (no vec)", a.stored && a.reason === "stored");
  check("countPerceptionMemories() === 1 (string-only path)", countPerceptionMemories() === 1);
}

// =============================================================================
// (B4) Phase 2 — privacy default: capture is OFF until explicitly enabled
// =============================================================================
//
// The route's 403 guard depends on getVisionConfig() being falsy by default.
// Document that default here; the route's 403 itself is integration-tested by
// the orchestrator (it needs a live worker + body parser).

const { getVisionConfig } = await import("../src/vision/capture.js");
const visionCfg = await getVisionConfig();
check(
  "vision capture is OFF by default (no config persisted)",
  visionCfg === null || visionCfg.enabled !== true,
  visionCfg ? `enabled=${visionCfg.enabled}` : "null",
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
