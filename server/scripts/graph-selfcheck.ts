// Phase 2 (blueprint §3 / §6 / §17) — Personalized PageRank selfcheck.
//
// Pure-module gate for `server/src/memory/graphTraversal.ts` and the ranker
// integration:
//   (A) buildAdjacency drops weak/floor edges, clips fanout, treats relations
//       as bidirectional.
//   (B) pageRank converges to a stable distribution under simple topologies.
//   (C) Personalisation actually personalises — seeded nodes (and their
//       neighbours) score higher than unseeded ones.
//   (D) Density gate keeps PPR a no-op on small graphs (the ranker's
//       backward-compat path).
//   (E) Ranker integration: with a dense-enough graph + GraphContext,
//       graphScoreById is populated and a well-connected hit ranks higher
//       than an otherwise-identical isolated one.
//
// Hermetic — opens a temp SQLite only for the ranker piece. No network.
//
// Run: npm --prefix server run graph:selfcheck

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "brain-graphcheck-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const {
  buildAdjacency,
  pageRank,
  personalisedPageRank,
  isGraphDenseEnough,
} = await import("../src/memory/graphTraversal.js");
const { rankHits, __resetRankerCache } = await import("../src/reasoning/ranker.js");
const { openDb } = await import("../src/db/sqlite.js");
openDb();
__resetRankerCache();

import type { MemoryRelation } from "../../shared/memory.js";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

function rel(fromId: string, toId: string, weight: number): MemoryRelation {
  return {
    id: `${fromId}->${toId}`,
    fromId,
    toId,
    kind: "cites",
    weight,
    createdAt: new Date().toISOString(),
  };
}

// =============================================================================
// (A) buildAdjacency
// =============================================================================

// (A.1) Empty relations → empty adjacency.
{
  const adj = buildAdjacency([]);
  check("buildAdjacency: empty → empty", adj.size === 0);
}

// (A.2) Floor drops weak edges entirely.
{
  const adj = buildAdjacency([rel("a", "b", 0.05)], { weightFloor: 0.1 });
  check("buildAdjacency: weightFloor drops weak edges", adj.size === 0);
}

// (A.3) Relations are bidirectional — both endpoints get an entry.
{
  const adj = buildAdjacency([rel("a", "b", 0.5)]);
  check(
    "buildAdjacency: relation is bidirectional",
    (adj.get("a")?.length ?? 0) === 1 && (adj.get("b")?.length ?? 0) === 1,
    `a=${adj.get("a")?.length} b=${adj.get("b")?.length}`,
  );
}

// (A.4) fanoutCap clips by weight (keeps the strongest).
{
  const rels: MemoryRelation[] = [
    rel("hub", "n1", 0.1),
    rel("hub", "n2", 0.9),
    rel("hub", "n3", 0.5),
  ];
  const adj = buildAdjacency(rels, { fanoutCap: 2 });
  const hubEdges = adj.get("hub")!.map((e) => e.to);
  check(
    "buildAdjacency: fanoutCap keeps strongest edges",
    hubEdges.length === 2 && hubEdges.includes("n2") && hubEdges.includes("n3"),
    `hubEdges=${JSON.stringify(hubEdges)}`,
  );
}

// =============================================================================
// (B) pageRank — convergence + invariants
// =============================================================================

// (B.1) Single-node universe: all mass at the node.
{
  const adj = new Map<string, Array<{ to: string; weight: number }>>();
  const seeds = new Map([["only", 1]]);
  const r = pageRank(adj, seeds);
  check(
    "pageRank: single seed, no edges → all mass at seed",
    Math.abs((r.scoreById.get("only") ?? 0) - 1) < 1e-9,
    `score=${r.scoreById.get("only")}`,
  );
}

// (B.2) Mass conserved (approximately — convergence tolerance).
{
  const adj = buildAdjacency([
    rel("a", "b", 1),
    rel("b", "c", 1),
    rel("c", "a", 1),
  ]);
  const seeds = new Map([["a", 1]]);
  const r = pageRank(adj, seeds);
  let total = 0;
  for (const v of r.scoreById.values()) total += v;
  check(
    "pageRank: mass conserved across triangle",
    Math.abs(total - 1) < 1e-2,
    `total=${total.toFixed(4)}`,
  );
}

// (B.3) Personalisation: seeded nodes outrank unseeded under the same topology.
{
  // Two disjoint communities; seed one of them.
  const adj = buildAdjacency([
    rel("a1", "a2", 1),
    rel("a2", "a3", 1),
    rel("b1", "b2", 1),
    rel("b2", "b3", 1),
  ]);
  const seeds = new Map([["a1", 1]]);
  const r = pageRank(adj, seeds);
  const aSum =
    (r.scoreById.get("a1") ?? 0) +
    (r.scoreById.get("a2") ?? 0) +
    (r.scoreById.get("a3") ?? 0);
  const bSum =
    (r.scoreById.get("b1") ?? 0) +
    (r.scoreById.get("b2") ?? 0) +
    (r.scoreById.get("b3") ?? 0);
  check(
    "pageRank: seeded community dominates the other",
    aSum > bSum * 2,
    `aSum=${aSum.toFixed(3)} bSum=${bSum.toFixed(3)}`,
  );
}

// (B.4) Determinism: same input → same output.
{
  const rels = [rel("a", "b", 0.7), rel("b", "c", 0.5)];
  const seeds = new Map([["a", 1]]);
  const r1 = personalisedPageRank(rels, seeds);
  const r2 = personalisedPageRank(rels, seeds);
  let identical = r1.scoreById.size === r2.scoreById.size;
  for (const [k, v] of r1.scoreById) {
    if ((r2.scoreById.get(k) ?? 0) !== v) {
      identical = false;
      break;
    }
  }
  check("pageRank: deterministic on identical input", identical);
}

// =============================================================================
// (D) Density gate
// =============================================================================

check("isGraphDenseEnough: false at 0 edges", isGraphDenseEnough(0, 50) === false);
check("isGraphDenseEnough: false just below threshold", isGraphDenseEnough(49, 50) === false);
check("isGraphDenseEnough: true at threshold", isGraphDenseEnough(50, 50) === true);
check("isGraphDenseEnough: true above threshold", isGraphDenseEnough(200, 50) === true);

// =============================================================================
// (E) Ranker integration
// =============================================================================

import type { VectorSearchHit } from "../src/db/repositories/memory.js";

const now = new Date().toISOString();
function hit(id: string, content: string, vec: number): VectorSearchHit {
  return {
    score: vec,
    memory: {
      id,
      sourceType: "manual",
      filePath: null,
      projectName: null,
      title: null,
      content,
      contentHash: id,
      embeddingId: null,
      importance: 0.5,
      createdAt: now,
      updatedAt: now,
      metadata: null,
      summaryId: null,
    },
  };
}

// Two hits with equal vec score; "connected" has many citations to other
// retrieved memories, "isolated" has none.
const hits: VectorSearchHit[] = [
  hit("isolated", "alone in the corpus", 0.6),
  hit("connected", "central to the citation graph", 0.6),
  hit("neighbor-1", "cites connected", 0.5),
  hit("neighbor-2", "cites connected", 0.5),
  hit("neighbor-3", "cites connected", 0.5),
];

// 60 relations total → above the 50-edge density gate. The connected hit gets
// many co-citations with the neighbor hits; isolated has none.
const rels: MemoryRelation[] = [];
for (let i = 0; i < 60; i += 1) {
  // Stitch 'connected' into a tight cluster with all three neighbors.
  const fromIdx = i % 3;
  const toIdx = (i + 1) % 3;
  const names = ["connected", "neighbor-1", "neighbor-2"];
  rels.push(rel(names[fromIdx], names[toIdx], 0.8));
}
// neighbor-3 also cites connected
rels.push(rel("neighbor-3", "connected", 0.7));

// (E.1) Without GraphContext, graphScoreById is empty (backward-compat).
{
  const r = rankHits(hits);
  check(
    "ranker: no GraphContext → graphScoreById empty",
    r.graphScoreById.size === 0,
    `size=${r.graphScoreById.size}`,
  );
}

// (E.2) With sparse relations (below density threshold), PPR is a no-op.
{
  const r = rankHits(hits, undefined, { relations: rels.slice(0, 10), totalRelations: 10 });
  check(
    "ranker: sparse graph (below threshold) → graphScoreById empty",
    r.graphScoreById.size === 0,
    `size=${r.graphScoreById.size}`,
  );
}

// (E.3) With dense relations + GraphContext, graphScoreById is populated.
{
  const r = rankHits(hits, undefined, { relations: rels, totalRelations: rels.length });
  check(
    "ranker: dense graph + GraphContext → graphScoreById populated",
    r.graphScoreById.size === hits.length,
    `size=${r.graphScoreById.size}`,
  );
}

// (E.4) Connected hit's graphScore > isolated hit's graphScore (since
// connected gets PPR mass from every neighbor, isolated gets none).
{
  const r = rankHits(hits, undefined, { relations: rels, totalRelations: rels.length });
  const connectedScore = r.graphScoreById.get("connected") ?? 0;
  const isolatedScore = r.graphScoreById.get("isolated") ?? 0;
  check(
    "ranker: connected hit's graphScore > isolated hit's graphScore",
    connectedScore > isolatedScore,
    `connected=${connectedScore.toFixed(3)} isolated=${isolatedScore.toFixed(3)}`,
  );
}

// (E.5) Connected hit ranks ahead of isolated hit under equal vec score
// (the user-visible payoff).
{
  const r = rankHits(hits, undefined, { relations: rels, totalRelations: rels.length });
  const connectedPos = r.ranked.findIndex((h) => h.memory.id === "connected");
  const isolatedPos = r.ranked.findIndex((h) => h.memory.id === "isolated");
  check(
    "ranker: connected hit ranks ahead of isolated under tied vec",
    connectedPos < isolatedPos,
    `connectedPos=${connectedPos} isolatedPos=${isolatedPos}`,
  );
}

// =============================================================================

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
