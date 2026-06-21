// observability selfcheck — gate for the C1 "observability spine" slice.
//
// All hermetic (temp DB via BRAIN_DB_PATH, worker pinned unreachable):
//   (A) metrics registry (pure): incr / gauge / observe + snapshot percentiles.
//   (B) brain_vitals round-trip: recordVitals -> readVitals (shape + since filter).
//   (C) diagnostics_log round-trip: persistDiagnostic -> readDiagnostics.
//   (D) surfaceError integration: one call bumps the metrics counter AND persists
//       a durable row (the in-memory counter used to vanish on restart).
//   (E) retention: pruneOldTelemetry drops rows older than the window.
//   (F) the OBSERVABILITY=false gate makes record/persist no-ops.
//
// The /api/brain/{vitals,metrics,diagnostics} routes are thin glue over these
// functions and are swept by the gate's server-smoke; this covers the units.
//
// Run: npm --prefix server run observability:selfcheck

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "brain-obscheck-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");
process.env.PERCEPTION_WORKER_URL = "http://127.0.0.1:1";

const { openDb } = await import("../src/db/sqlite.js");
const { CONFIG } = await import("../src/config.js");
const metrics = await import("../src/observability/metrics.js");
const { recordVitals, readVitals, persistDiagnostic, readDiagnostics, pruneOldTelemetry } =
  await import("../src/observability/vitals.js");
const { surfaceError, getDiagnosticCounts, resetDiagnostics } = await import(
  "../src/util/diagnostics.js"
);

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

openDb(); // apply schema + migrations (brain_vitals + diagnostics_log)

// =============================================================================
// (A) metrics registry — pure
// =============================================================================
metrics.resetMetricsForTest();
metrics.incr("c");
metrics.incr("c", 2);
metrics.gauge("g", 5);
metrics.observe("h", 10);
metrics.observe("h", 20);
metrics.observe("h", 30);
const snap = metrics.snapshot();
check("metrics.incr accumulates (c=3)", snap.counters.c === 3, `c=${snap.counters.c}`);
check("metrics.gauge sets latest (g=5)", snap.gauges.g === 5, `g=${snap.gauges.g}`);
check(
  "metrics histogram percentiles (count=3, p50=20, p95=30, max=30)",
  snap.histograms.h?.count === 3 &&
    snap.histograms.h?.p50 === 20 &&
    snap.histograms.h?.p95 === 30 &&
    snap.histograms.h?.max === 30,
  JSON.stringify(snap.histograms.h),
);
metrics.gauge("nan", Number.NaN);
check("metrics.gauge ignores non-finite values", metrics.snapshot().gauges.nan === undefined);

// =============================================================================
// (B) brain_vitals round-trip
// =============================================================================
recordVitals({ "organism.health": 0.8, "memory.count": 42 }, "2026-06-17T10:00:00.000Z");
recordVitals({ "organism.health": 0.6 }, "2026-06-17T11:00:00.000Z");
const all = readVitals();
check("readVitals returns the persisted samples", all.length === 3, `rows=${all.length}`);
check(
  "readVitals row shape is {metric,value,capturedAt}",
  all.every((r) => typeof r.metric === "string" && typeof r.value === "number" && typeof r.capturedAt === "string"),
);
const since = readVitals("2026-06-17T10:30:00.000Z");
check("readVitals(since) filters by timestamp (1 of 3)", since.length === 1, `rows=${since.length}`);

// =============================================================================
// (C) diagnostics_log round-trip
// =============================================================================
persistDiagnostic("test:c-source", "error", "a persisted error message", 7);
const diags = readDiagnostics(10);
const row = diags.find((d) => d.source === "test:c-source");
check(
  "persistDiagnostic -> readDiagnostics round-trips source/level/message/count",
  !!row && row.level === "error" && row.message === "a persisted error message" && row.count === 7,
  JSON.stringify(row),
);

// =============================================================================
// (D) surfaceError integration — bumps metrics AND persists a durable row
// =============================================================================
metrics.resetMetricsForTest();
resetDiagnostics();
surfaceError("test:surface", new Error("boom from surfaceError"));
const afterSnap = metrics.snapshot();
check("surfaceError bumps errors.total counter", afterSnap.counters["errors.total"] === 1, `=${afterSnap.counters["errors.total"]}`);
check("surfaceError bumps the per-source counter", afterSnap.counters["errors.test:surface"] === 1);
check("surfaceError keeps its in-memory count (getDiagnosticCounts)", getDiagnosticCounts()["test:surface"] === 1);
const durable = readDiagnostics(20).find((d) => d.source === "test:surface");
check(
  "surfaceError PERSISTS a durable diagnostics_log row (survives restart)",
  !!durable && durable.message === "boom from surfaceError",
  JSON.stringify(durable),
);

// =============================================================================
// (E) retention — pruneOldTelemetry drops rows older than the window
// =============================================================================
recordVitals({ "ancient.metric": 1 }, "2020-01-01T00:00:00.000Z");
pruneOldTelemetry();
const ancient = readVitals().find((r) => r.metric === "ancient.metric");
check("pruneOldTelemetry removes rows older than the retention window", ancient === undefined);

// =============================================================================
// (F) the OBSERVABILITY=false gate makes record/persist no-ops
// =============================================================================
const prevObs = CONFIG.observability;
const baselineVitals = readVitals().length;
const baselineDiags = readDiagnostics(1000).length;
CONFIG.observability = false;
recordVitals({ "gated.metric": 1 });
persistDiagnostic("test:gated", "warn", "should not persist", 1);
check("recordVitals is a no-op when OBSERVABILITY=false", readVitals().length === baselineVitals);
check(
  "persistDiagnostic is a no-op when OBSERVABILITY=false",
  readDiagnostics(1000).length === baselineDiags &&
    readDiagnostics(1000).every((d) => d.source !== "test:gated"),
);
CONFIG.observability = prevObs;

// =============================================================================
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
