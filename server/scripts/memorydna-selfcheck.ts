// Memory DNA selfcheck — hermetic (throwaway DB via BRAIN_DB_PATH, no LLM, no
// network). Mirrors neuromod-selfcheck.ts.
//
// Run: npm --prefix server run memorydna:selfcheck
//
// Asserts:
//   (A) PURE: deriveDna trust/verification per provenance (web low, grounded
//       conversation high); mergeDna preserves existing keys; readDna round-trips
//       explicit DNA and falls back to provenance inference for legacy rows;
//       trustDemotion is EXACTLY 1.0 for normal/unknown trust (the no-op),
//       ramps to the floor at trust 0, and is monotone.
//   (B) Over a temp DB: a web-ingested memory and a DNA-stamped conversation
//       memory tally correctly in memoryDnaStats (verification labels, lowTrust).
//   (C) readDna never throws on garbage metadata; the demotion is a strict no-op
//       for high-trust memories.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

const tmp = mkdtempSync(join(tmpdir(), "brain-memorydna-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const {
  TRUST_OK,
  TRUST_DEMOTION_FLOOR,
  deriveDna,
  mergeDna,
  readDna,
  trustDemotion,
  memoryDnaStats,
} = await import("../src/memory/memoryDna.js");
const { upsertMemoryPoint } = await import("../src/db/repositories/memory.js");
const { openDb } = await import("../src/db/sqlite.js");

openDb();

// -----------------------------------------------------------------------------
// (A) PURE.
// -----------------------------------------------------------------------------

// deriveDna by provenance.
{
  const web = deriveDna({ source: "ingest:web" });
  check("deriveDna web → low trust", (web.trust ?? 1) < TRUST_OK, `trust=${web.trust}`);
  check("deriveDna web → web-corroborated", web.verification === "web-corroborated");
  check("deriveDna carries an emotion", typeof web.emotion === "number");

  const grounded = deriveDna({ source: "conversation", confidence: 0.9, citedCount: 3 });
  check("deriveDna grounded conversation → high trust", (grounded.trust ?? 0) >= 0.65, `trust=${grounded.trust}`);
  check("deriveDna grounded conversation → user-confirmed", grounded.verification === "user-confirmed");

  const guess = deriveDna({ source: "conversation", confidence: 0.2, citedCount: 0 });
  check("deriveDna ungrounded conversation → self-derived", guess.verification === "self-derived");
  check("deriveDna ungrounded trust below grounded", (guess.trust ?? 1) < (grounded.trust ?? 0));
}

// mergeDna preserves existing keys.
{
  const merged = mergeDna({ conversationId: "c1", runId: "r1" }, { trust: 0.4, verification: "web-corroborated" });
  check("mergeDna preserves existing metadata", merged.conversationId === "c1" && merged.runId === "r1");
  check("mergeDna attaches dna", !!(merged.dna as { trust?: number }).trust);
}

// readDna round-trip + provenance fallback.
{
  const explicit = readDna({ metadata: mergeDna({}, { emotion: 0.7, trust: 0.3, verification: "unverified" }) });
  check("readDna recovers explicit trust", Math.abs((explicit.trust ?? 0) - 0.3) < 1e-9);
  check("readDna recovers explicit emotion", Math.abs((explicit.emotion ?? 0) - 0.7) < 1e-9);
  // Regression: emotion-only explicit DNA must NOT fall through to provenance.
  const emoOnly = readDna({ metadata: mergeDna({}, { emotion: 0.8 }), sourceType: "chunk" });
  check("readDna keeps emotion-only explicit DNA", Math.abs((emoOnly.emotion ?? 0) - 0.8) < 1e-9);

  const legacyWeb = readDna({ metadata: { source: "ingest:web" }, sourceType: "chunk" });
  check("readDna infers web trust for a legacy row", (legacyWeb.trust ?? 1) < TRUST_OK, `trust=${legacyWeb.trust}`);

  const legacyChunk = readDna({ metadata: { source: "file" }, sourceType: "chunk" });
  check("readDna infers high trust for a local chunk", (legacyChunk.trust ?? 0) >= TRUST_OK);

  const noMeta = readDna({ sourceType: "conversation" });
  check("readDna defaults safely with no metadata", typeof noMeta.trust === "number");
}

// trustDemotion: no-op for normal/unknown, ramp + floor for low.
{
  check("trustDemotion is 1.0 for undefined trust (no-op)", trustDemotion(undefined) === 1.0);
  check("trustDemotion is 1.0 at TRUST_OK", trustDemotion({ trust: TRUST_OK }) === 1.0);
  check("trustDemotion is 1.0 above TRUST_OK", trustDemotion({ trust: 0.9 }) === 1.0);
  check("trustDemotion hits the floor at trust 0", Math.abs(trustDemotion({ trust: 0 }) - TRUST_DEMOTION_FLOOR) < 1e-9);
  check("trustDemotion is below 1 for low trust", trustDemotion({ trust: 0.2 }) < 1.0 && trustDemotion({ trust: 0.2 }) >= TRUST_DEMOTION_FLOOR);
  check("trustDemotion is monotone in trust", trustDemotion({ trust: 0.1 }) < trustDemotion({ trust: 0.4 }));
}

// -----------------------------------------------------------------------------
// (B) Stats over a temp DB.
// -----------------------------------------------------------------------------
{
  // A raw web-ingested memory (provenance-only DNA).
  upsertMemoryPoint({
    sourceType: "chunk",
    content: "Some text fetched from a web page about widgets.",
    contentHash: "hash-web-1",
    metadata: { source: "ingest:web", sourcePath: "https://example.com" },
  });
  // A DNA-stamped grounded conversation memory.
  upsertMemoryPoint({
    sourceType: "conversation",
    content: "Q: how do widgets work\nA: …",
    contentHash: "hash-conv-1",
    metadata: mergeDna({ conversationId: "c1" }, deriveDna({ source: "conversation", confidence: 0.9, citedCount: 2, emotion: 0.65 })),
  });

  const stats = memoryDnaStats(100);
  check("stats sampled both memories", stats.sampled === 2, `sampled=${stats.sampled}`);
  check("stats counts a low-trust (web) memory", stats.lowTrust >= 1, `lowTrust=${stats.lowTrust}`);
  check("stats tallies web-corroborated", stats.byVerification["web-corroborated"] >= 1);
  check("stats tallies user-confirmed (grounded conv)", stats.byVerification["user-confirmed"] >= 1);
  check("stats avgTrust in range", stats.avgTrust > 0 && stats.avgTrust <= 1);
  check("stats is JSON-serializable", JSON.parse(JSON.stringify(stats)).sampled === 2);
}

// -----------------------------------------------------------------------------
// (C) Robustness.
// -----------------------------------------------------------------------------
{
  let threw = false;
  try {
    readDna({ metadata: { dna: "not-an-object" } as unknown as Record<string, unknown> });
    readDna({ metadata: null });
    readDna(null);
    readDna(undefined);
  } catch {
    threw = true;
  }
  check("readDna never throws on garbage", threw === false);
  // Stats still works with brain dropped (failure-isolated → 0 sampled).
  openDb().exec("DROP TABLE IF EXISTS memory_points");
  let threw2 = false;
  try {
    memoryDnaStats(10);
  } catch {
    threw2 = true;
  }
  check("memoryDnaStats degrades without the table", threw2 === false);
}

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
