// turbovec selfcheck — gate for the optional alternative vector index.
//
// Covers the NODE-SIDE seams ONLY — the worker's turbovec/numpy path is NEVER
// exercised here (the gate can't install turbovec; the live backfill+search path
// is the runtime check, same as airllm/perception/ownmodel):
//   (A) worker-down status degrade: getTurbovecStatus() -> "unavailable" + message.
//   (B) availability cache: isTurbovecAvailable() false when worker down;
//       cachedTurbovecAvailable() false before any probe.
//   (C) scoreFromTurbovecSimilarity (pure): similarity->1/(2-s) mapping + clamp +
//       NaN/Infinity guard.
//   (D) worker-down op degrade: turbovecClear()/turbovecAddBatch() -> ok:false.
//   (E) hot-path fallback: vectorSearch() with turbovec ON + worker down returns
//       [] with no throw (turbovec miss -> sqlite-vec); default OFF unchanged.
//   (F) route wiring: GET /api/learning/turbovec/status + POST .../backfill mounted
//       and return honest shapes; backfill with real rows + worker down -> ok:false.
//
// Hermetic: temp DB via BRAIN_DB_PATH, PERCEPTION_WORKER_URL pinned at an
// unreachable port — no real worker, no turbovec, no network. The backfill-with-rows
// case is guarded on isVectorAvailable() (sqlite-vec) so it skips cleanly on a
// machine without the extension rather than failing.
//
// Run: npm --prefix server run turbovec:selfcheck

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "brain-turboveccheck-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");
// Unreachable loopback port — the worker probe resolves instantly to
// ECONNREFUSED, exercising the "worker down" degrade path (same as airllm).
process.env.PERCEPTION_WORKER_URL = "http://127.0.0.1:1";

const { openDb, isVectorAvailable } = await import("../src/db/sqlite.js");
const { upsertMemoryPoint, getAllEmbeddingRows, vectorSearch } = await import(
  "../src/db/repositories/memory.js"
);
const { CONFIG } = await import("../src/config.js");
const {
  getTurbovecStatus,
  isTurbovecAvailable,
  cachedTurbovecAvailable,
  _resetTurbovecCacheForTest,
  turbovecClear,
  turbovecAddBatch,
  scoreFromTurbovecSimilarity,
} = await import("../src/learning/turbovecClient.js");

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

openDb(); // apply schema

// =============================================================================
// (A) worker-down status degrade
// =============================================================================
const down = await getTurbovecStatus();
check(
  "getTurbovecStatus() with worker down -> 'unavailable'",
  down.state === "unavailable",
  `state=${down.state}`,
);
check(
  "getTurbovecStatus() carries a helpful message",
  typeof down.message === "string" && down.message.length > 0,
);
check(
  "worker-down status fields normalised (dim/bitWidth null, count 0)",
  down.dim === null && down.bitWidth === null && down.count === 0,
  `dim=${down.dim} bitWidth=${down.bitWidth} count=${down.count}`,
);

// =============================================================================
// (B) availability cache
// =============================================================================
_resetTurbovecCacheForTest();
check("cachedTurbovecAvailable() false before any probe", cachedTurbovecAvailable() === false);
const avail = await isTurbovecAvailable();
check("isTurbovecAvailable() with worker down -> false", avail === false, `avail=${avail}`);
check("cachedTurbovecAvailable() reflects the last (false) probe", cachedTurbovecAvailable() === false);

// =============================================================================
// (C) scoreFromTurbovecSimilarity — pure similarity->score transform
// =============================================================================
check("scoreFromTurbovecSimilarity(1) -> 1.0", scoreFromTurbovecSimilarity(1) === 1);
check("scoreFromTurbovecSimilarity(0) -> 0.5", scoreFromTurbovecSimilarity(0) === 0.5);
check(
  "scoreFromTurbovecSimilarity(-1) -> ~0.333 (sqlite-vec range floor)",
  Math.abs(scoreFromTurbovecSimilarity(-1) - 1 / 3) < 1e-9,
  `${scoreFromTurbovecSimilarity(-1)}`,
);
check(
  "scoreFromTurbovecSimilarity(2) clamps below 2 -> ~1000 (finite, no div-by-zero)",
  Number.isFinite(scoreFromTurbovecSimilarity(2)) &&
    Math.abs(scoreFromTurbovecSimilarity(2) - 1000) < 1e-3,
  `${scoreFromTurbovecSimilarity(2)}`,
);
check("scoreFromTurbovecSimilarity(NaN) -> 0.5 (finite guard)", scoreFromTurbovecSimilarity(NaN) === 0.5);
check("scoreFromTurbovecSimilarity(Infinity) -> 0.5 (finite guard)", scoreFromTurbovecSimilarity(Infinity) === 0.5);

// =============================================================================
// (D) worker-down op degrade — structured results, never throw
// =============================================================================
const cleared = await turbovecClear();
check("turbovecClear() with worker down -> ok:false", cleared.ok === false, `ok=${cleared.ok}`);
check("turbovecClear() carries an error string", typeof cleared.error === "string" && (cleared.error ?? "").length > 0);

const dim = CONFIG.embeddingDim;
const added = await turbovecAddBatch([{ id: 1, vector: new Array<number>(dim).fill(0.1) }]);
check("turbovecAddBatch() with worker down -> ok:false", added.ok === false, `ok=${added.ok}`);

// =============================================================================
// (E) hot-path fallback — turbovec ON + worker down must NOT throw, must fall
// back to sqlite-vec (empty DB -> []). Default OFF is unchanged.
// =============================================================================
_resetTurbovecCacheForTest();
const prevFlag = CONFIG.turbovecEnabled;
CONFIG.turbovecEnabled = true;
let fallbackThrew = false;
let fallbackResult: unknown = "not-run";
try {
  fallbackResult = await vectorSearch(new Array<number>(dim).fill(0), 5);
} catch (err) {
  fallbackThrew = true;
  console.log(`      threw: ${err instanceof Error ? err.message : String(err)}`);
}
check(
  "vectorSearch() with turbovec ON + worker down -> [] (falls back, no throw)",
  !fallbackThrew && Array.isArray(fallbackResult) && fallbackResult.length === 0,
  `threw=${fallbackThrew} len=${Array.isArray(fallbackResult) ? fallbackResult.length : "n/a"}`,
);

CONFIG.turbovecEnabled = false;
_resetTurbovecCacheForTest();
let defaultResult: unknown = "not-run";
let defaultThrew = false;
try {
  defaultResult = await vectorSearch(new Array<number>(dim).fill(0), 5);
} catch (err) {
  defaultThrew = true;
  console.log(`      threw: ${err instanceof Error ? err.message : String(err)}`);
}
check(
  "vectorSearch() with turbovec OFF (default) -> [] unchanged",
  !defaultThrew && Array.isArray(defaultResult) && defaultResult.length === 0,
  `threw=${defaultThrew} len=${Array.isArray(defaultResult) ? defaultResult.length : "n/a"}`,
);
check("CONFIG.turbovecEnabled defaults to false", prevFlag === false, `prevFlag=${prevFlag}`);
CONFIG.turbovecEnabled = false; // leave clean

// =============================================================================
// (F) route wiring — exercise the Express handlers in-process
// =============================================================================
const express = (await import("express")).default;
const { learningRouter } = await import("../src/routes/learning.js");

const routeApp = express();
routeApp.use(express.json({ limit: "1mb" }));
routeApp.use("/api", learningRouter);

const srv = await new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
  const s = routeApp.listen(0, "127.0.0.1", () => {
    const addr = s.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    resolve({ port, close: () => new Promise<void>((r) => s.close(() => r())) });
  });
});

async function call(
  path: string,
  method: "GET" | "POST",
  body?: object,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(`http://127.0.0.1:${srv.port}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json: parsed };
}

_resetTurbovecCacheForTest();
const st = await call("/api/learning/turbovec/status", "GET");
check(
  "GET /api/learning/turbovec/status -> 200, state unavailable, enabled false",
  st.status === 200 &&
    st.json?.state === "unavailable" &&
    st.json?.enabled === false,
  `status=${st.status} state=${st.json?.state} enabled=${st.json?.enabled}`,
);

const bfEmpty = await call("/api/learning/turbovec/backfill", "POST");
check(
  "POST /api/learning/turbovec/backfill (empty DB) -> 200, ok:true, added 0",
  bfEmpty.status === 200 && bfEmpty.json?.ok === true && bfEmpty.json?.added === 0,
  `status=${bfEmpty.status} ok=${bfEmpty.json?.ok} added=${bfEmpty.json?.added}`,
);

// Backfill WITH rows needs sqlite-vec to seed embeddings. Skip cleanly (not a
// failure) on a machine without the extension rather than asserting on nothing.
if (isVectorAvailable()) {
  upsertMemoryPoint({
    sourceType: "chunk",
    content: "turbovec backfill row one",
    contentHash: "tv1",
    embedding: new Array<number>(dim).fill(0.1),
  });
  upsertMemoryPoint({
    sourceType: "chunk",
    content: "turbovec backfill row two",
    contentHash: "tv2",
    embedding: new Array<number>(dim).fill(0.2),
  });
  const rows = getAllEmbeddingRows();
  check("getAllEmbeddingRows() reads the 2 seeded embeddings", rows.length === 2, `rows=${rows.length}`);
  check(
    "blobToEmbedding round-trips a 768-dim vector (length matches CONFIG.embeddingDim)",
    rows.length === 2 && rows.every((r) => r.embedding.length === dim),
    `dims=${rows.map((r) => r.embedding.length).join(",")}`,
  );
  const bfRows = await call("/api/learning/turbovec/backfill", "POST");
  check(
    "backfill with rows + worker down -> ok:false (clear reaches the down worker first)",
    bfRows.status === 200 && bfRows.json?.ok === false,
    `status=${bfRows.status} ok=${bfRows.json?.ok}`,
  );
  check(
    "backfill reports totalInDb=2 (the DB count, independent of the worker)",
    bfRows.json?.totalInDb === 2,
    `totalInDb=${bfRows.json?.totalInDb}`,
  );
  check(
    "backfill carries an error string from the down worker",
    typeof bfRows.json?.error === "string" && (bfRows.json?.error as string).length > 0,
    `error=${bfRows.json?.error}`,
  );
} else {
  console.log("      (sqlite-vec unavailable in this env — backfill-with-rows assertions skipped)");
}

await srv.close();

// =============================================================================
// Same exit pattern as the other selfchecks: the stdout PASSED line is the gate
// signal; a Windows libuv teardown abort on process.exit is tolerated upstream.
// =============================================================================
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);