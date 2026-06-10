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

const { openDb, isVectorAvailable } = await import("../src/db/sqlite.js");
const { upsertMemoryPoint } = await import("../src/db/repositories/memory.js");
const { getMemoryById } = await import("../src/memory/memoryLifecycle.js");
const { assessNovelty } = await import("../src/memory/noveltyDetector.js");
const { updateMemoryStrength } = await import("../src/memory/memoryStrength.js");
const { getDiagnosticCounts } = await import("../src/util/diagnostics.js");
const { cosineSimilarity, getStoredEmbedding, getStoredEmbeddings } = await import(
  "../src/memory/embeddingSimilarity.js"
);
const { updateClusterForMemory, getClustersForMemory } = await import(
  "../src/memory/semanticCluster.js"
);
const { buildAccessPattern, getRelatedMemories } = await import(
  "../src/memory/accessPatternTracker.js"
);
const { CONFIG } = await import("../src/config.js");

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

// ---------------------------------------------------------------------------
// (4) Embedding cosine similarity — the string-heuristic → real-cosine upgrade.
//     Asserts the DECISION LOGIC (not threshold calibration) at clearly-separated
//     cosine values, so it's hermetic and embedder-independent. The behavioral
//     cluster block only runs when the sqlite-vec extension actually loaded.
// ---------------------------------------------------------------------------
const vecOn = isVectorAvailable();
console.log(`  [cosine] sqlite-vec extension: ${vecOn ? "LOADED" : "UNAVAILABLE"}`);

// 4a. cosineSimilarity — pure math at unambiguous values.
const near1 = cosineSimilarity([1, 2, 3], [1, 2, 3]);
check("cosineSimilarity(identical) ≈ 1", Math.abs(near1 - 1) < 1e-6, `got ${near1}`);
check("cosineSimilarity(orthogonal) = 0", cosineSimilarity([1, 0], [0, 1]) === 0);
const opp = cosineSimilarity([1, 0], [-1, 0]);
check("cosineSimilarity(opposite) ≈ -1", Math.abs(opp + 1) < 1e-6, `got ${opp}`);
check("cosineSimilarity(length mismatch) = 0", cosineSimilarity([1, 2, 3], [1, 2]) === 0);
check("cosineSimilarity(zero vector) = 0", cosineSimilarity([0, 0], [1, 1]) === 0);

// 4b. getStoredEmbedding — defensive contract + (when vec is on) a round-trip
//     through the REAL serializer, which doubles as vec0-blob format verification.
check("getStoredEmbedding('nonexistent-id') -> null", getStoredEmbedding("nonexistent-id") === null);
check("getStoredEmbeddings([]) -> empty map", getStoredEmbeddings([]).size === 0);

const dim = CONFIG.embeddingDim;
// Place nonzero components starting at `at`, zero elsewhere. Letting the
// behavioral vectors live in DIFFERENT dimensions than the round-trip probe
// keeps them mutually orthogonal, so the probe's cluster can never accidentally
// attract them — the merge/separate assertions stay deterministic.
function vecAt(at: number, values: number[]): number[] {
  const v = new Array<number>(dim).fill(0);
  for (let i = 0; i < values.length && at + i < dim; i += 1) v[at + i] = values[i];
  return v;
}
function padVec(prefix: number[]): number[] {
  return vecAt(0, prefix);
}

if (vecOn) {
  // Round-trip: insert a known float32 vector via the real serializer, read it
  // back. First few components must survive within float32 tolerance.
  const knownPrefix = [0.5, -0.25, 0.125, 0.0625];
  const rt = upsertMemoryPoint({
    sourceType: "manual",
    content: "cosine round-trip probe",
    contentHash: `rt-${Date.now()}`,
    embedding: padVec(knownPrefix),
  });
  const readBack = getStoredEmbedding(rt.id);
  const rtOk =
    !!readBack &&
    readBack.length === dim &&
    knownPrefix.every((expected, i) => Math.abs(readBack[i] - expected) < 1e-3);
  check("getStoredEmbedding round-trips a known float32 vector", rtOk,
    readBack ? `first=${readBack.slice(0, 4).map((x) => x.toFixed(4)).join(",")}` : "null");

  // 4c. BEHAVIORAL: cosine merges what Jaccard would NOT. Two memories with
  //     near-identical embeddings (cosine ≈ 0.99) but DISJOINT vocabulary land in
  //     one cluster — string-Jaccard on their text would be ~0.
  // dims 10+ — orthogonal to the round-trip probe (dims 0-3) so the probe's
  // cluster can't attract these. vecA·vecB cosine ≈ 0.9999.
  const vecA = vecAt(10, [1, 0, 0, 0]);
  const vecB = vecAt(10, [0.9999, 0.0141, 0, 0]);
  const cAB = cosineSimilarity(vecA, vecB);
  check("synthetic vecA·vecB cosine ≈ 0.99 (>0.95)", cAB > 0.95, `got ${cAB.toFixed(4)}`);

  const mCosA = upsertMemoryPoint({
    sourceType: "manual",
    content: "alpha beta gamma delta epsilon zeta eta",
    contentHash: `cosA-${Date.now()}`,
    embedding: vecA,
  });
  const mCosB = upsertMemoryPoint({
    sourceType: "manual",
    content: "ocean mountain forest river desert canyon valley",
    contentHash: `cosB-${Date.now()}`,
    embedding: vecB,
  });
  updateClusterForMemory(mCosA.id, mCosA.content, db);
  updateClusterForMemory(mCosB.id, mCosB.content, db);
  const clustersB = getClustersForMemory(mCosB.id, db);
  const merged =
    clustersB.length > 0 &&
    clustersB.some((c) => c.memoryIds.includes(mCosA.id) && c.memoryIds.includes(mCosB.id));
  check("cosine MERGES near-identical embeddings despite disjoint text", merged,
    `B-clusters=${clustersB.map((c) => c.memoryIds.length).join("/")}`);

  // 4d. BEHAVIORAL: an orthogonal-embedding memory (cosine ≈ 0 to vecA) forms a
  //     SEPARATE cluster from mCosA.
  const vecOrtho = vecAt(14, [1, 0, 0, 0]); // disjoint dims from vecA (10) and probe (0-3)
  check("synthetic vecA·vecOrtho cosine = 0", cosineSimilarity(vecA, vecOrtho) === 0);
  const mOrtho = upsertMemoryPoint({
    sourceType: "manual",
    content: "alpha beta gamma delta epsilon zeta eta theta",
    contentHash: `ortho-${Date.now()}`,
    embedding: vecOrtho,
  });
  updateClusterForMemory(mOrtho.id, mOrtho.content, db);
  const clustersOrtho = getClustersForMemory(mOrtho.id, db);
  const separate =
    clustersOrtho.length > 0 &&
    clustersOrtho.every((c) => !c.memoryIds.includes(mCosA.id));
  check("orthogonal embedding forms a SEPARATE cluster", separate,
    `ortho-clusters contain A? ${!separate}`);

  // 4e. STRING-FALLBACK PARITY: a memory with NO embedding still clusters via the
  //     string path (no throw, behaves as before — byte-identical fallback).
  let fallbackThrew = false;
  let mNoEmb: { id: string; content: string } | null = null;
  try {
    mNoEmb = upsertMemoryPoint({
      sourceType: "manual",
      content: "string fallback path clusters without any stored embedding vector",
      contentHash: `noemb-${Date.now()}`,
    });
    updateClusterForMemory(mNoEmb.id, mNoEmb.content, db);
  } catch {
    fallbackThrew = true;
  }
  const fallbackClustered =
    !fallbackThrew &&
    !!mNoEmb &&
    getStoredEmbedding(mNoEmb.id, db) === null &&
    getClustersForMemory(mNoEmb.id, db).some((c) => c.memoryIds.includes(mNoEmb!.id));
  check("string-fallback (no embedding) still clusters via string path", fallbackClustered);
} else {
  // No extension: getStoredEmbedding must be null for ANY id (portable assertion
  // on machines without sqlite-vec). Cosine behavioral logic can't be exercised.
  check("getStoredEmbedding(<any id>) -> null when vec unavailable",
    getStoredEmbedding(point.id) === null);
}

// ---------------------------------------------------------------------------
// (5) getRelatedMemories param-count regression guard. The fix bound 6 params to
//     the SQL's 6 placeholders; the prior 5-arg call ALWAYS threw "too few
//     parameter values", which the function's own try/catch swallowed → it
//     silently returned [] → related-memory consolidation/spreading-activation
//     never fired (the exact "ships green" class CLAUDE.md warns about). Seed two
//     co-accessed memories and assert the READ path actually returns the
//     neighbour. With a regression the throw is swallowed and related=[] — so the
//     second assertion (not the no-throw one) is what fails it.
// ---------------------------------------------------------------------------
const relA = upsertMemoryPoint({
  sourceType: "manual",
  content: "related-memory guard A",
  contentHash: `relA-${Date.now()}`,
  importance: 0.6,
});
const relB = upsertMemoryPoint({
  sourceType: "manual",
  content: "related-memory guard B",
  contentHash: `relB-${Date.now()}`,
  importance: 0.6,
});
// coaccess_count must reach MIN_COACCESS_COUNT (2) to pass the read filter.
buildAccessPattern(relA.id, relB.id, db);
buildAccessPattern(relA.id, relB.id, db);
let relatedThrew = false;
let related: string[] = [];
try {
  related = getRelatedMemories(relA.id);
} catch (err) {
  relatedThrew = true;
  console.log("  getRelatedMemories threw:", err instanceof Error ? err.message : err);
}
check("getRelatedMemories(id) does not throw", !relatedThrew);
check(
  "getRelatedMemories(a) returns the co-accessed neighbour b (6-param fix)",
  related.includes(relB.id),
  `related=[${related.join(",")}]`,
);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
