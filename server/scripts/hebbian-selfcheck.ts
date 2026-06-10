// Hebbian co-citation wiring selfcheck — hermetic (throwaway DB, no LLM).
//
// Run: npm --prefix server run hebbian:selfcheck
//
// Asserts:
//   (A) PURE math: strengthenWeight is monotone, bounded by 1, and moves by a
//       fraction of the headroom; coCitationPairs canonicalises, dedups, and
//       caps.
//   (B) Wiring over a temp DB: recordCoCitations creates "associates" edges at
//       INITIAL_WEIGHT, repeat co-citation strengthens the SAME edge (no
//       duplicates), <2 ids is a no-op.
//   (C) decayAssociations multiplies weights down and prunes below the floor.
//   (D) associativeNeighbors pulls a strong-edged neighbour the hit set
//       missed, anchors its score BELOW the weakest real hit, ignores weak
//       edges, and bounds the count.
//   (E) Failure isolation: with memory_relations dropped, nothing throws.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

const tmp = mkdtempSync(join(tmpdir(), "brain-hebbian-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const {
  HEBBIAN_RATE,
  INITIAL_WEIGHT,
  PRUNE_FLOOR,
  PULL_IN_LIMIT,
  strengthenWeight,
  coCitationPairs,
  recordCoCitations,
  decayAssociations,
  associativeNeighbors,
  associationCount,
} = await import("../src/memory/hebbian.js");
const { openDb } = await import("../src/db/sqlite.js");
const { upsertMemoryPoint } = await import("../src/db/repositories/memory.js");

const db = openDb();

// -----------------------------------------------------------------------------
// (A) PURE math.
// -----------------------------------------------------------------------------

check("strengthenWeight moves by headroom fraction", Math.abs(strengthenWeight(0.3) - (0.3 + HEBBIAN_RATE * 0.7)) < 1e-9);
check("strengthenWeight is monotone", strengthenWeight(0.6) > 0.6);
check("strengthenWeight asymptotes below 1", strengthenWeight(0.999) < 1 + 1e-9 && strengthenWeight(1) === 1);
check("strengthenWeight clamps garbage", strengthenWeight(Number.NaN) >= 0 && strengthenWeight(-5) >= 0);

{
  const pairs = coCitationPairs(["b", "a", "c", "a"]);
  check("coCitationPairs canonical + dedup", pairs.length === 3 && pairs.every(([x, y]) => x < y), JSON.stringify(pairs));
  check("coCitationPairs caps", coCitationPairs(Array.from({ length: 20 }, (_, i) => `m${i}`), 5).length === 5);
  check("coCitationPairs single id → empty", coCitationPairs(["a"]).length === 0);
}

// -----------------------------------------------------------------------------
// (B) Edge creation + strengthening.
// -----------------------------------------------------------------------------

function makeMemory(content: string): string {
  return upsertMemoryPoint({
    sourceType: "manual",
    content,
    contentHash: createHash("sha1").update(content).digest("hex"),
    importance: 0.5,
  }).id;
}

const m1 = makeMemory("deploy script for the staging server");
const m2 = makeMemory("incident report: staging outage in june");
const m3 = makeMemory("notes about gardening tomatoes");

check("recordCoCitations <2 ids is a no-op", recordCoCitations([m1]) === 0);

const touched = recordCoCitations([m1, m2]);
check("recordCoCitations creates one edge for a pair", touched === 1 && associationCount() === 1);
const edge = db
  .prepare(`SELECT weight FROM memory_relations WHERE kind = 'associates'`)
  .get() as { weight: number };
check("new edge starts at INITIAL_WEIGHT", Math.abs(edge.weight - INITIAL_WEIGHT) < 1e-9);

recordCoCitations([m2, m1]); // reversed order — same canonical edge
const after = db
  .prepare(`SELECT COUNT(*) AS c, MAX(weight) AS w FROM memory_relations WHERE kind = 'associates'`)
  .get() as { c: number; w: number };
check("repeat co-citation strengthens the SAME edge (no duplicate)", after.c === 1 && after.w > INITIAL_WEIGHT, `w=${after.w}`);

// -----------------------------------------------------------------------------
// (C) Decay + prune.
// -----------------------------------------------------------------------------

{
  const before = (db.prepare(`SELECT weight FROM memory_relations WHERE kind='associates'`).get() as { weight: number }).weight;
  const r = decayAssociations(0.5, PRUNE_FLOOR);
  const now = (db.prepare(`SELECT weight FROM memory_relations WHERE kind='associates'`).get() as { weight: number }).weight;
  check("decayAssociations multiplies weights down", r.decayed >= 1 && Math.abs(now - before * 0.5) < 1e-9);
  const r2 = decayAssociations(0.01); // crush below the floor
  check("decayAssociations prunes below the floor", r2.pruned >= 1 && associationCount() === 0, `pruned=${r2.pruned}`);
}

// -----------------------------------------------------------------------------
// (D) Associative recall.
// -----------------------------------------------------------------------------

{
  // Wire m1—m2 strongly, m1—m3 weakly. A hit set containing only m1 should
  // pull in m2 (strong) and ignore m3 (weak).
  recordCoCitations([m1, m2]);
  for (let i = 0; i < 6; i += 1) recordCoCitations([m1, m2]); // strengthen ≥ 0.5
  recordCoCitations([m1, m3]); // weak (one shot, 0.3)
  const hits = [{ memory: { id: m1 } as never, score: 0.6 } as never];
  // Rebuild the hit with the real memory shape for the module.
  const { getMemoryPoint } = await import("../src/db/repositories/memory.js");
  const hit = { memory: getMemoryPoint(m1)!, score: 0.6 };
  void hits;
  const neighbors = associativeNeighbors([hit]);
  check("strong association pulls the missed neighbour in", neighbors.some((n) => n.memory.id === m2), `got=${neighbors.map((n) => n.memory.id).join(",")}`);
  check("weak association is NOT pulled in", !neighbors.some((n) => n.memory.id === m3));
  check("pulled neighbour scores below the weakest real hit", neighbors.every((n) => n.score < 0.6));
  check("pull-in respects the limit", neighbors.length <= PULL_IN_LIMIT);
  check("empty hit set → no neighbours", associativeNeighbors([]).length === 0);
}

// -----------------------------------------------------------------------------
// (E) Failure isolation.
// -----------------------------------------------------------------------------

db.exec("DROP TABLE IF EXISTS memory_relations");
let threw = false;
try {
  recordCoCitations([m1, m2]);
  decayAssociations();
  associativeNeighbors([{ memory: { id: m1, content: "", importance: 0.5 } as never, score: 0.5 }]);
  associationCount();
} catch {
  threw = true;
}
check("no function throws with memory_relations gone", threw === false);

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
