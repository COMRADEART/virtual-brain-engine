import { test } from "node:test";
import assert from "node:assert/strict";
import BetterSqlite3 from "better-sqlite3";
import {
  updateClusterForMemory,
  getAllClusters,
  getClustersForMemory,
  getClusterStats,
  mergeClusters,
  computeClusterCoherence,
  computeJaccardSimilarity,
  computeNgramOverlap,
} from "./semanticCluster.js";

// Mirrors the relevant columns of schema.sql (memory_clusters + the subset of
// memory_points the cluster matcher reads).
function makeDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(":memory:");
  db.exec(`
    CREATE TABLE memory_clusters (
      id           TEXT PRIMARY KEY,
      topic        TEXT NOT NULL,
      memory_ids   TEXT NOT NULL DEFAULT '[]',
      memory_count INTEGER NOT NULL DEFAULT 0,
      strength     REAL NOT NULL DEFAULT 0.5,
      coherence    REAL NOT NULL DEFAULT 0.8,
      created_at   TEXT NOT NULL,
      last_updated TEXT NOT NULL
    );
    CREATE TABLE memory_points (
      id         TEXT PRIMARY KEY,
      content    TEXT NOT NULL,
      summary_id TEXT
    );
  `);
  return db;
}

function addMemory(db: BetterSqlite3.Database, id: string, content: string): void {
  db.prepare("INSERT INTO memory_points (id, content, summary_id) VALUES (?, ?, NULL)").run(
    id,
    content,
  );
}

const BASE =
  "database migration scripts handle schema versioning and rollback safely";
const SIMILAR =
  "database migration scripts handle schema versioning and rollback procedures";
const UNRELATED =
  "weather forecast predicts heavy rainfall thunderstorm across coastal regions tomorrow";

test("M1: similar content joins the same cluster instead of spawning one-member clusters", () => {
  const db = makeDb();
  addMemory(db, "m1", BASE);
  updateClusterForMemory("m1", BASE, db);
  addMemory(db, "m2", SIMILAR);
  updateClusterForMemory("m2", SIMILAR, db);

  const clusters = getAllClusters(50, db);
  assert.equal(clusters.length, 1, "the two similar memories should share one cluster");
  assert.equal(clusters[0].memoryIds.length, 2);
  assert.deepEqual([...clusters[0].memoryIds].sort(), ["m1", "m2"]);
});

test("M1: unrelated content forms a separate cluster", () => {
  const db = makeDb();
  addMemory(db, "m1", BASE);
  updateClusterForMemory("m1", BASE, db);
  addMemory(db, "m3", UNRELATED);
  updateClusterForMemory("m3", UNRELATED, db);

  const clusters = getAllClusters(50, db);
  assert.equal(clusters.length, 2, "disjoint topics must not be merged");
  for (const c of clusters) assert.equal(c.memoryIds.length, 1);
});

test("M1: a third similar memory keeps growing the existing cluster", () => {
  const db = makeDb();
  for (const [id, c] of [
    ["m1", BASE],
    ["m2", SIMILAR],
    ["m3", "database migration scripts schema versioning rollback and audit"],
  ] as const) {
    addMemory(db, id, c);
    updateClusterForMemory(id, c, db);
  }
  const clusters = getAllClusters(50, db);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].memoryIds.length, 3);
});

test("L1: computeClusterCoherence returns 1.0 on empty ids (no `IN ()` syntax error)", () => {
  const db = makeDb();
  assert.equal(computeClusterCoherence([], "anything", db), 1.0);
});

test("L1: computeClusterCoherence tolerates ids with no matching rows", () => {
  const db = makeDb();
  const c = computeClusterCoherence(["does-not-exist"], "lonely content here", db);
  assert.ok(Number.isFinite(c) && c >= 0 && c <= 1);
});

test("getClustersForMemory finds the cluster a memory belongs to", () => {
  const db = makeDb();
  addMemory(db, "m1", BASE);
  updateClusterForMemory("m1", BASE, db);
  const found = getClustersForMemory("m1", db);
  assert.equal(found.length, 1);
  assert.ok(found[0].memoryIds.includes("m1"));
});

test("mergeClusters unions members into the target and deletes the source", () => {
  const db = makeDb();
  addMemory(db, "m1", BASE);
  updateClusterForMemory("m1", BASE, db);
  addMemory(db, "m3", UNRELATED);
  updateClusterForMemory("m3", UNRELATED, db);
  const before = getAllClusters(50, db);
  assert.equal(before.length, 2);

  mergeClusters(before[1].clusterId, before[0].clusterId, db);

  const after = getAllClusters(50, db);
  assert.equal(after.length, 1);
  assert.deepEqual([...after[0].memoryIds].sort(), ["m1", "m3"]);
});

test("getClusterStats reflects the current table", () => {
  const db = makeDb();
  addMemory(db, "m1", BASE);
  updateClusterForMemory("m1", BASE, db);
  const stats = getClusterStats(db);
  assert.equal(stats.totalClusters, 1);
  assert.ok(stats.avgStrength > 0);
  assert.equal(stats.largestCluster, 1);
});

test("similarity primitives: identical -> 1, disjoint -> 0, empty -> 0", () => {
  assert.equal(computeJaccardSimilarity(BASE, BASE), 1);
  assert.equal(computeJaccardSimilarity(BASE, UNRELATED), 0);
  assert.equal(computeJaccardSimilarity("", ""), 0);
  assert.equal(computeNgramOverlap(BASE, BASE), 1);
  assert.equal(computeNgramOverlap(BASE, UNRELATED), 0);
});
