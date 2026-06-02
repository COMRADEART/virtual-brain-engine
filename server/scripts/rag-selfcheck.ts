// RAG selfcheck — multi-query expansion + Reciprocal Rank Fusion (Phase A) and
// the lexical query-aware reranker (Phase B, appended below). HERMETIC: the
// RRF/expand tests are pure (no DB, no network, injected generate fn); the
// reranker tests use a throwaway DB via BRAIN_DB_PATH for its persisted state.
// Run: npm --prefix server run rag:selfcheck

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "brain-ragcheck-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const { reciprocalRankFusion, expandQuery } = await import("../src/reasoning/queryExpansion.js");
import type { VectorSearchHit } from "../src/db/repositories/memory.js";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

function hit(id: string, score: number): VectorSearchHit {
  return { memory: { id } as unknown as VectorSearchHit["memory"], score };
}

// ============================================================================
// 1. Reciprocal Rank Fusion (pure)
// ============================================================================
{
  // "b" appears in BOTH lists → its RRF sum beats single-list "a"/"c".
  const l1 = [hit("a", 0.9), hit("b", 0.5)];
  const l2 = [hit("b", 0.7), hit("c", 0.8)];
  const fused = reciprocalRankFusion([l1, l2], { limit: 10 });
  const ids = fused.map((h) => h.memory.id);
  check("RRF: doc found by multiple queries ranks first", ids[0] === "b", ids.join(","));
  check("RRF: union recall — every unique doc surfaces", new Set(ids).size === 3 && ids.includes("a") && ids.includes("c"));
  const b = fused.find((h) => h.memory.id === "b");
  check("RRF: emitted score is MAX vec across lists (b→0.7)", !!b && Math.abs(b.score - 0.7) < 1e-9, `${b?.score}`);
  check("RRF: limit caps the fused set", reciprocalRankFusion([l1, l2], { limit: 1 }).length === 1);
}
{
  const fused = reciprocalRankFusion([[hit("x", 0.5), hit("x", 0.6)]], { limit: 10 });
  check("RRF: dedup by id (keeps max vec)", fused.length === 1 && Math.abs(fused[0].score - 0.6) < 1e-9);
}
check("RRF: empty input → empty", reciprocalRankFusion([], {}).length === 0);

// ============================================================================
// 2. expandQuery (failure-isolated, injected generate)
// ============================================================================
{
  const out = await expandQuery("original q", async () => '["alpha rewrite", "beta rewrite"]', { variants: 2 });
  check("expand: original query is always first", out[0] === "original q");
  check("expand: includes parsed variants", out.length === 3 && out.includes("alpha rewrite") && out.includes("beta rewrite"));
}
{
  const out = await expandQuery("q", async () => "not json at all", { variants: 2 });
  check("expand: garbage reply → [query] fallback", out.length === 1 && out[0] === "q");
}
{
  const out = await expandQuery("q", async () => { throw new Error("llm down"); }, { variants: 2 });
  check("expand: thrown error → [query] fallback (failure-isolated)", out.length === 1 && out[0] === "q");
}
{
  const out = await expandQuery("q", async () => '["Q", "unique one"]', { variants: 3 });
  check("expand: variant equal to original (case-insensitive) is deduped", out.filter((s) => s.toLowerCase() === "q").length === 1);
}
{
  const out = await expandQuery("q", async () => '["v1","v2","v3","v4","v5"]', { variants: 2 });
  check("expand: caps total at variants+1", out.length === 3);
}
{
  // Embedded in code fences + prose — still extracted.
  const out = await expandQuery("q", async () => 'Sure!\n```json\n["x rewrite"]\n```', { variants: 1 });
  check("expand: tolerates code-fence/prose around the JSON array", out.includes("x rewrite"));
}

// ============================================================================
// 3. Lexical query-aware reranker (ML) — uses the throwaway DB for state I/O.
// ============================================================================
const { openDb } = await import("../src/db/sqlite.js");
const { applyReranker, trainReranker, rerankFeatures, RERANKER_VERSION, WARM_AT, zeroWeights } = await import("../src/reasoning/rerankerModel.js");
const { loadRerankerState, saveRerankerState } = await import("../src/db/repositories/adaptive.js");
openDb();

function docHit(id: string, score: number, content: string, title?: string): VectorSearchHit {
  return { memory: { id, content, title: title ?? null } as unknown as VectorSearchHit["memory"], score };
}

{
  // features: [bias, termCoverage, termJaccard, titleCoverage, phraseMatch]
  const f = rerankFeatures("alpha beta", { content: "alpha beta gamma" });
  check("reranker features: full query-term coverage", f[1] === 1);
  check("reranker features: exact-phrase match flagged", f[4] === 1);
  const f2 = rerankFeatures("alpha beta", { content: "zulu yankee" });
  check("reranker features: zero overlap → coverage 0 / phrase 0", f2[1] === 0 && f2[4] === 0);
  const f3 = rerankFeatures("alpha beta", { content: "nope", title: "alpha beta heading" });
  check("reranker features: title coverage is query-aware", f3[3] === 1);
}
{
  // The WARM_AT gate must actually SUPPRESS a model that WOULD reorder — not pass
  // by the zero-weight coincidence (zero weights → prob 0.5 for all → stable sort
  // preserves order regardless of the guard, which proves nothing). Use NON-ZERO
  // weights that favor termCoverage so the model genuinely prefers "hi": held one
  // short of warm the order MUST still be preserved (gate suppresses); at warm it
  // reorders. This discriminates the trainedCount<WARM_AT branch from coincidence.
  const reorderingWeights = [0, 6, 0, 0, 0]; // strong on termCoverage
  const input = [docHit("lo", 0.5, "zulu yankee"), docHit("hi", 0.5, "alpha beta gamma")];
  const justUnderWarm = applyReranker("alpha beta gamma", input, { version: RERANKER_VERSION, weights: reorderingWeights, trainedCount: WARM_AT - 1 });
  check("reranker COLD (warm-1, REORDERING weights) → gate suppresses the reorder", justUnderWarm[0].memory.id === "lo", justUnderWarm.map((h) => h.memory.id).join(","));
  const atWarm = applyReranker("alpha beta gamma", input, { version: RERANKER_VERSION, weights: reorderingWeights, trainedCount: WARM_AT });
  check("reranker AT WARM_AT (same weights) → now reorders (gate is load-bearing)", atWarm[0].memory.id === "hi", atWarm.map((h) => h.memory.id).join(","));
  // zero-weight cold state is also a no-op (sanity).
  const zeroCold = applyReranker("alpha beta gamma", input, { version: RERANKER_VERSION, weights: zeroWeights(), trainedCount: 0 });
  check("reranker COLD (zero weights) → no-op", zeroCold[0].memory.id === "lo");
}
{
  // Train on a consistent lexical signal (high-overlap doc is the one cited),
  // then assert WARM reordering at EQUAL vec score (so only lexical decides).
  let state = loadRerankerState();
  const q = "alpha beta gamma";
  for (let i = 0; i < 25; i += 1) {
    const cands = [
      docHit("hi", 0.5, "alpha beta gamma delta epsilon"),
      docHit("lo", 0.5, "zulu yankee xray whiskey"),
    ];
    state = trainReranker(q, cands, new Set(["hi"]), state);
  }
  saveRerankerState(state);
  check("reranker trains (trainedCount advances on cited queries)", state.trainedCount >= 15);
  const reloaded = loadRerankerState();
  check("reranker state round-trips through brain_metadata", !!reloaded && reloaded.trainedCount === state.trainedCount);
  const input = [docHit("lo", 0.5, "zulu yankee xray whiskey"), docHit("hi", 0.5, "alpha beta gamma delta epsilon")];
  const out = applyReranker(q, input, reloaded);
  check("reranker WARM → high-lexical-overlap doc reordered first", out[0].memory.id === "hi", out.map((h) => h.memory.id).join(","));
}
{
  const after = trainReranker("q", [docHit("a", 0.5, "x")], new Set(), { version: RERANKER_VERSION, weights: zeroWeights(), trainedCount: 7 });
  check("reranker: query with NO citations does not advance trainedCount", after.trainedCount === 7);
}

try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(JSON.stringify({ failures, result: failures === 0 ? "PASS" : "FAIL" }, null, 2));
process.exit(failures === 0 ? 0 : 1);
