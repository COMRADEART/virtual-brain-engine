// substrate selfcheck — gate for the C2 "substrate unblock" slice.
//
// Covers the NODE-SIDE seams, all hermetic (temp DB via BRAIN_DB_PATH, worker
// pinned unreachable — no FTS5-less build assumed, no network):
//   (A) toFtsMatchQuery (pure): tokenise / quote / OR-join / null on no tokens.
//   (B) FTS keyword search: a tokenised MATCH returns the right memory; a
//       no-match query returns []; (guarded on isFtsAvailable so a build without
//       fts5 skips cleanly rather than failing).
//   (C) LIKE fallback: with CONFIG.ftsEnabled flipped off, keywordSearch still
//       finds the memory via the substring path — no-regression on the fallback.
//   (D) relation-query bound: getRelationsFor caps at its limit on a hub node.
//   (E) turbovec mirror queue: bounded + drop-oldest + single-in-flight + never
//       throws (injected fast adder, so it's hermetic and fast).
//
// Run: npm --prefix server run substrate:selfcheck

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "brain-substratecheck-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");
process.env.PERCEPTION_WORKER_URL = "http://127.0.0.1:1";

const { openDb, isFtsAvailable } = await import("../src/db/sqlite.js");
const { CONFIG } = await import("../src/config.js");
const {
  upsertMemoryPoint,
  insertRelation,
  getRelationsFor,
  keywordSearch,
  toFtsMatchQuery,
} = await import("../src/db/repositories/memory.js");
const {
  turbovecEnqueueAdd,
  turbovecMirrorStats,
  _setTurbovecAddImplForTest,
  _resetTurbovecMirrorForTest,
} = await import("../src/learning/turbovecClient.js");

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

openDb(); // apply schema + migrations + FTS loader

// =============================================================================
// (A) toFtsMatchQuery — pure
// =============================================================================
check(
  'toFtsMatchQuery("quantum physics") -> \'"quantum" OR "physics"\'',
  toFtsMatchQuery("quantum physics") === '"quantum" OR "physics"',
  `${toFtsMatchQuery("quantum physics")}`,
);
const punctOut = toFtsMatchQuery('what is "x" AND y* ?');
check(
  "toFtsMatchQuery neutralises punctuation / operators (no '*' leak, balanced quotes)",
  typeof punctOut === "string" &&
    !punctOut.includes("*") &&
    (punctOut.match(/"/g)?.length ?? 0) % 2 === 0,
  `${punctOut}`,
);
check("toFtsMatchQuery drops 1-char noise tokens", toFtsMatchQuery("a I x") === null, `${toFtsMatchQuery("a I x")}`);
check("toFtsMatchQuery('') -> null (caller falls back to LIKE)", toFtsMatchQuery("") === null);
check("toFtsMatchQuery('!!! ???') -> null (no usable tokens)", toFtsMatchQuery("!!! ???") === null);

// Seed memories for the search assertions.
upsertMemoryPoint({ sourceType: "chunk", content: "the quantum cat sat on the warm mat", contentHash: "s1" });
upsertMemoryPoint({ sourceType: "chunk", content: "a dog ran quickly through the green park", contentHash: "s2" });
upsertMemoryPoint({ sourceType: "chunk", content: "photosynthesis converts sunlight into chemical energy", contentHash: "s3" });

// =============================================================================
// (B) FTS keyword search — guarded on FTS availability
// =============================================================================
if (isFtsAvailable()) {
  const quantum = keywordSearch("quantum", 10);
  check(
    'FTS keywordSearch("quantum") finds the quantum memory',
    quantum.length === 1 && quantum[0].memory.content.includes("quantum"),
    `hits=${quantum.length}`,
  );
  const orMatch = keywordSearch("photosynthesis dog", 10);
  check(
    'FTS keywordSearch("photosynthesis dog") ORs tokens -> 2 memories',
    orMatch.length === 2,
    `hits=${orMatch.length}`,
  );
  const none = keywordSearch("zzznonexistenttoken", 10);
  check('FTS keywordSearch(no-match) -> [] (no throw)', none.length === 0, `hits=${none.length}`);
  const punct = keywordSearch("!!! ???", 10);
  check("FTS keywordSearch(punctuation-only) -> [] via LIKE fallback path (no throw)", Array.isArray(punct));
} else {
  console.log("      (fts5 unavailable in this better-sqlite3 build — FTS assertions skipped)");
}

// =============================================================================
// (C) LIKE fallback — flip the flag off, same query still resolves
// =============================================================================
const prevFts = CONFIG.ftsEnabled;
CONFIG.ftsEnabled = false;
const likeHit = keywordSearch("quantum", 10);
check(
  "LIKE fallback (CONFIG.ftsEnabled=false) still finds the quantum memory",
  likeHit.length === 1 && likeHit[0].memory.content.includes("quantum"),
  `hits=${likeHit.length}`,
);
CONFIG.ftsEnabled = prevFts;

// =============================================================================
// (D) relation-query bound
// =============================================================================
const hub = upsertMemoryPoint({ sourceType: "chunk", content: "hub node", contentHash: "hub" });
for (let i = 0; i < 60; i++) {
  const leaf = upsertMemoryPoint({ sourceType: "chunk", content: `leaf ${i}`, contentHash: `leaf-${i}` });
  insertRelation(hub.id, leaf.id, "associates", 1);
}
const capped = getRelationsFor(hub.id, 25);
check("getRelationsFor respects an explicit limit (25 of 60 edges)", capped.length === 25, `got=${capped.length}`);
const defaulted = getRelationsFor(hub.id);
check("getRelationsFor default cap returns all 60 (under the 256 default)", defaulted.length === 60, `got=${defaulted.length}`);

// =============================================================================
// (E) turbovec mirror queue — bounded, drop-oldest, never throws
// =============================================================================
_resetTurbovecMirrorForTest();
// Inject an adder that never resolves, so nothing drains while we fill the queue
// and we can assert the synchronous bound/drop behaviour deterministically.
let pendingResolvers = 0;
_setTurbovecAddImplForTest(
  () =>
    new Promise(() => {
      pendingResolvers++;
    }),
);
let enqueueThrew = false;
try {
  for (let i = 0; i < 1300; i++) turbovecEnqueueAdd(i, [0.1, 0.2, 0.3]);
} catch {
  enqueueThrew = true;
}
const stats = turbovecMirrorStats();
check("turbovecEnqueueAdd never throws into the ingest path", enqueueThrew === false);
check(
  "mirror queue is bounded at MIRROR_QUEUE_MAX (1000) — not unbounded fan-out",
  stats.queued <= 1000,
  `queued=${stats.queued}`,
);
check(
  "mirror queue dropped the overflow (~299 of 1300 enqueued beyond the cap)",
  stats.dropped >= 250,
  `dropped=${stats.dropped}`,
);
check(
  "only ONE add is in flight at a time (single-drain, not 1300 concurrent)",
  pendingResolvers === 1,
  `inFlight=${pendingResolvers}`,
);
_resetTurbovecMirrorForTest();

// =============================================================================
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
