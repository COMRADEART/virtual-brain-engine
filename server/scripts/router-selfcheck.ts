// MoE query-router selfcheck — pure tests for server/src/reasoning/router.ts.
// HERMETIC: no DB, no Ollama, no network. routeQuery + cosineSim are pure, and
// we do not exercise getRegionPrototypes (which would need an embedder), so
// nothing here touches better-sqlite3.
//
// Run: npm --prefix server run router:selfcheck
//
// Asserts:
//   (A) Each brief routing case → routeQuery(q).experts[0] === expected region.
//   (B) Depth gate: easy lookup → "shallow", hard multi-clause → "full".
//   (C) Determinism: same query twice → deep-equal decision.
//   (D) All scores[].score and difficulty in [0,1] across the query set.
//   (E) cosineSim correctness: identical → ~1, orthogonal → ~0, mismatch → 0.
//   (F) Embedding blend: a prototype aligned with the query embedding raises
//       that region's score vs the no-embedding call, and usedEmbedding === true.
//   (G) experts.length >= 1 always.

import {
  cosineSim,
  routeQuery,
  type LogicalRegionId,
} from "../src/reasoning/router.js";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

// -----------------------------------------------------------------------------
// (A) Routing: top expert matches the expected cortex.
// -----------------------------------------------------------------------------
const routingCases: Array<[string, LogicalRegionId]> = [
  ["remember when I fixed the server crash", "memory-core"],
  ["is this contradictory with what I said?", "error-detection-center"],
  ["what is the status of the star project repo?", "project-cortex"],
  ["find the file where runPipeline is defined", "file-memory"],
  ["which ollama model should I use for embeddings?", "model-hub"],
  ["draft a reply to this email", "response-center"],
  ["give me feedback on how the ranker is learning", "learning-feedback-center"],
];

for (const [query, expected] of routingCases) {
  const decision = routeQuery(query);
  check(
    `route "${query}" → ${expected}`,
    decision.experts[0] === expected,
    `got ${decision.experts[0]} (scores: ${decision.scores
      .slice(0, 3)
      .map((s) => `${s.region}=${s.score.toFixed(2)}`)
      .join(", ")})`,
  );
}

// -----------------------------------------------------------------------------
// (B) Depth gate.
// -----------------------------------------------------------------------------
const easyQuery = "what is the capital of France";
const hardQuery =
  "why does the gate pass but the server crash at boot, and how do I fix it across the memory and pipeline modules?";

const easyDecision = routeQuery(easyQuery);
const hardDecision = routeQuery(hardQuery);
check(
  "easy lookup query routes shallow",
  easyDecision.depth === "shallow",
  `depth=${easyDecision.depth} difficulty=${easyDecision.difficulty.toFixed(2)}`,
);
check(
  "hard multi-clause query routes full",
  hardDecision.depth === "full",
  `depth=${hardDecision.depth} difficulty=${hardDecision.difficulty.toFixed(2)}`,
);

// -----------------------------------------------------------------------------
// (C) Determinism — same query twice → deep-equal decision.
// -----------------------------------------------------------------------------
const d1 = routeQuery(hardQuery);
const d2 = routeQuery(hardQuery);
check(
  "routeQuery is deterministic",
  JSON.stringify(d1) === JSON.stringify(d2),
  `d1=${JSON.stringify(d1)} d2=${JSON.stringify(d2)}`,
);

// -----------------------------------------------------------------------------
// (D) All scores + difficulty in [0,1] across the full query set.
// -----------------------------------------------------------------------------
const allQueries = [...routingCases.map(([q]) => q), easyQuery, hardQuery];
let allScoresInRange = true;
let allDifficultyInRange = true;
for (const q of allQueries) {
  const dec = routeQuery(q);
  if (!dec.scores.every((s) => s.score >= 0 && s.score <= 1)) {
    allScoresInRange = false;
  }
  if (!(dec.difficulty >= 0 && dec.difficulty <= 1)) {
    allDifficultyInRange = false;
  }
}
check("all scores in [0,1] across the query set", allScoresInRange);
check("all difficulties in [0,1] across the query set", allDifficultyInRange);

// scores must be sorted descending and cover all 8 regions.
{
  const dec = routeQuery(hardQuery);
  const sortedDesc = dec.scores.every(
    (s, i) => i === 0 || dec.scores[i - 1].score >= s.score,
  );
  check("scores sorted descending", sortedDesc);
  check("scores cover all 8 logical regions", dec.scores.length === 8);
}

// -----------------------------------------------------------------------------
// (E) cosineSim correctness.
// -----------------------------------------------------------------------------
check("cosineSim(identical) ≈ 1", Math.abs(cosineSim([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
check("cosineSim(orthogonal) ≈ 0", Math.abs(cosineSim([1, 0], [0, 1])) < 1e-9);
check("cosineSim(mismatched length) = 0", cosineSim([1, 2, 3], [1, 2]) === 0);
check("cosineSim(zero vector) = 0", cosineSim([0, 0, 0], [1, 2, 3]) === 0);
check("cosineSim(empty) = 0", cosineSim([], []) === 0);

// -----------------------------------------------------------------------------
// (F) Embedding blend raises an aligned region's score + sets usedEmbedding.
// -----------------------------------------------------------------------------
{
  // Pick a query whose lexical winner is NOT model-hub, so model-hub's
  // normalized lexical score is < 1 and the aligned-prototype blend has room
  // to raise it. (If model-hub were already the lexical winner at 1.0, the
  // blend with cos≈1 would stay pinned at 1.0 and could not rise.)
  const q = "remember when I fixed the server crash";
  const v = [0.4, 0.1, 0.9, 0.2];
  const vAligned = [0.4, 0.1, 0.9, 0.2]; // identical → cos ≈ 1, strongly aligned

  const noEmbed = routeQuery(q);
  const withEmbed = routeQuery(q, {
    queryEmbedding: v,
    regionPrototypes: { "model-hub": vAligned },
  });

  const noScore =
    noEmbed.scores.find((s) => s.region === "model-hub")?.score ?? 0;
  const withScore =
    withEmbed.scores.find((s) => s.region === "model-hub")?.score ?? 0;

  check("embedding blend sets usedEmbedding=true", withEmbed.usedEmbedding === true);
  check("no-embedding call has usedEmbedding=false", noEmbed.usedEmbedding === false);
  check(
    "aligned prototype raises model-hub score",
    withScore > noScore,
    `with=${withScore.toFixed(4)} no=${noScore.toFixed(4)}`,
  );
}

// -----------------------------------------------------------------------------
// (G) experts.length >= 1 always — including a query that matches nothing.
// -----------------------------------------------------------------------------
{
  const empty = routeQuery("");
  const gibberish = routeQuery("zzz qqq xyzzy");
  check("empty query yields >= 1 expert", empty.experts.length >= 1, `experts=${empty.experts.join(",")}`);
  check(
    "no-match query defaults to reasoning-cortex",
    gibberish.experts[0] === "reasoning-cortex",
    `experts=${gibberish.experts.join(",")}`,
  );
  let allNonEmpty = true;
  for (const q of allQueries) {
    if (routeQuery(q).experts.length < 1) allNonEmpty = false;
  }
  check("experts.length >= 1 across the query set", allNonEmpty);
}

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
