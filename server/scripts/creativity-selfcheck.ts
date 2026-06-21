// Creativity engine selfcheck — hermetic (throwaway DB via BRAIN_DB_PATH, a
// scripted connector, no LLM, no network). Mirrors workspace-selfcheck.ts.
//
// Run: npm --prefix server run creativity:selfcheck
//
// Asserts:
//   (A) PURE: lexicalDistance is 0 for identical content and 1 for disjoint;
//       mostDistantPair picks the least-similar pair and is null below 2 items;
//       noveltyOf clamps.
//   (B) runCreativeCycle over a temp DB with a scripted connector: bridges the
//       distant pair, writes a creative-idea memory + a pending creative_ideas
//       row, emits a `creativity:recombination` cognition event, and
//       pendingIdeasForWorkspace surfaces it.
//   (C) Degrade: no connector → nothing written, clear reason; a corpus with only
//       near-duplicates yields "no distant pair".

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

const tmp = mkdtempSync(join(tmpdir(), "brain-creativity-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const {
  MIN_DISTANCE,
  lexicalDistance,
  mostDistantPair,
  noveltyOf,
  runCreativeCycle,
  pendingIdeasForWorkspace,
  listIdeas,
  creativityStats,
} = await import("../src/core/creativity.js");
const { upsertMemoryPoint, getMemoryPoint } = await import("../src/db/repositories/memory.js");
const { getEventBus } = await import("../src/core/eventBus.js");
const { openDb } = await import("../src/db/sqlite.js");

openDb();

// Minimal scripted connector (scripts aren't typechecked; cast at the call site).
const stubConnector = { send: async () => "A bridge: borrow-checker discipline is photosynthesis for code — energy in, safety out." };
type Opts = Parameters<typeof runCreativeCycle>[0];

// -----------------------------------------------------------------------------
// (A) PURE.
// -----------------------------------------------------------------------------

check("lexicalDistance identical → 0", lexicalDistance("rust borrow checker lifetimes", "rust borrow checker lifetimes") === 0);
check("lexicalDistance disjoint → 1", lexicalDistance("rust borrow checker", "photosynthesis chloroplast sunlight") === 1);
check("lexicalDistance partial in (0,1)", (() => { const d = lexicalDistance("rust borrow checker traits", "rust borrow checker lifetimes"); return d > 0 && d < 1; })());

{
  const items = [
    { id: "a", content: "rust borrow checker lifetimes ownership" },
    { id: "b", content: "rust borrow checker traits ownership" },
    { id: "c", content: "photosynthesis chloroplast sunlight energy conversion" },
  ];
  const pair = mostDistantPair(items);
  check("mostDistantPair finds a pair", pair !== null);
  check("mostDistantPair picks the disjoint one", pair !== null && (pair.a.id === "c" || pair.b.id === "c"));
  check("mostDistantPair distance ≥ MIN_DISTANCE here", (pair?.distance ?? 0) >= MIN_DISTANCE, `d=${pair?.distance.toFixed(2)}`);
  check("mostDistantPair null below 2 items", mostDistantPair([{ id: "x", content: "only one" }]) === null && mostDistantPair([]) === null);
  // Regression: when all pairs tie on distance, pick the canonical least (a.id,b.id).
  const tie = mostDistantPair([
    { id: "3", content: "alpha" },
    { id: "1", content: "beta" },
    { id: "2", content: "gamma" },
  ]);
  check("mostDistantPair tie-break is canonical", tie !== null && tie.a.id === "1" && tie.b.id === "2", `${tie?.a.id},${tie?.b.id}`);
}

check("noveltyOf clamps", noveltyOf(2) === 1 && noveltyOf(-1) === 0);

// -----------------------------------------------------------------------------
// (B) Cycle over a temp DB with a scripted connector.
// -----------------------------------------------------------------------------

upsertMemoryPoint({ sourceType: "manual", content: "Rust's borrow checker enforces ownership and lifetimes at compile time, preventing data races.", contentHash: "seed-rust-1" });
upsertMemoryPoint({ sourceType: "manual", content: "Rust traits define shared behavior; the borrow checker still governs lifetimes across trait objects.", contentHash: "seed-rust-2" });
upsertMemoryPoint({ sourceType: "manual", content: "Photosynthesis in chloroplasts converts sunlight, water and CO2 into glucose and oxygen energy.", contentHash: "seed-bio-1" });

let cognitionFired = false;
const off = getEventBus().on("cognition", (e: { event?: { reason?: string } }) => {
  if (e?.event?.reason === "creativity:recombination") cognitionFired = true;
});

const report = await runCreativeCycle({ connector: stubConnector } as Opts);
check("cycle produced an idea id", report.ideaId !== null, report.reason ?? "");
check("cycle wrote a memory", report.memoryId !== null);
check("cycle returned the synthesized idea", (report.idea ?? "").startsWith("A bridge:"));
check("cycle picked a distant pair", report.pair !== null && report.pair.distance >= MIN_DISTANCE);
check("cycle emitted a creativity cognition event", cognitionFired);

if (report.memoryId) {
  const mem = getMemoryPoint(report.memoryId);
  check("stored memory is tagged creative-idea", (mem?.metadata?.kind as string) === "creative-idea");
  check("stored memory records its seeds", Array.isArray(mem?.metadata?.seedMemoryIds));
}

{
  const pending = pendingIdeasForWorkspace(5);
  check("pendingIdeasForWorkspace surfaces the new idea", pending.length >= 1 && pending[0].status === "pending");
  const stats = creativityStats();
  check("creativityStats counts it", stats.total >= 1 && stats.pending >= 1);
  check("listIdeas returns it", listIdeas(10).length >= 1);
}
off();

// -----------------------------------------------------------------------------
// (C) Degrade paths.
// -----------------------------------------------------------------------------

{
  const before = creativityStats().total;
  const noConn = await runCreativeCycle({ connector: null } as Opts);
  check("no connector → no idea, clear reason", noConn.ideaId === null && noConn.reason === "no connector");
  check("no connector → nothing persisted", creativityStats().total === before);
}

{
  // Fresh DB with only near-duplicate memories → no distant pair.
  openDb().exec("DELETE FROM memory_points");
  upsertMemoryPoint({ sourceType: "manual", content: "rust borrow checker lifetimes ownership safety", contentHash: "dup-1" });
  upsertMemoryPoint({ sourceType: "manual", content: "rust borrow checker lifetimes ownership memory", contentHash: "dup-2" });
  const dup = await runCreativeCycle({ connector: stubConnector } as Opts);
  check("near-duplicate corpus → no distant pair", dup.ideaId === null && dup.reason === "no distant pair");
}

{
  // Regression: if the creative_ideas INSERT fails, the cycle reports honestly —
  // the memory is still written, but ideaId is null with a clear reason.
  openDb().exec("DELETE FROM memory_points");
  upsertMemoryPoint({ sourceType: "manual", content: "Distinct note about quantum computing qubits and superposition states", contentHash: "if-1" });
  upsertMemoryPoint({ sourceType: "manual", content: "Unrelated note about baking sourdough bread and fermentation timing", contentHash: "if-2" });
  openDb().exec("DROP TABLE IF EXISTS creative_ideas");
  const r = await runCreativeCycle({ connector: stubConnector } as Opts);
  check("INSERT failure reported honestly (ideaId null, memory kept)",
    r.ideaId === null && r.memoryId !== null && r.reason === "idea row not persisted",
    JSON.stringify({ ideaId: r.ideaId, memoryId: r.memoryId, reason: r.reason }));
}

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
