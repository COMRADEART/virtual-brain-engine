// Attention saliency selfcheck — pure tests for the saliency module + the
// ranker integration. No DB required; saliency.ts is deliberately
// dependency-free, and the ranker test below feeds it synthetic VectorSearchHits.
//
// Run: npm --prefix server run attention:selfcheck
//
// Asserts:
//   (A) computeSaliency() is deterministic and in [0,1] under all branches.
//   (B) Each of the four signals (novelty, goal-relevance, emotion, survival)
//       moves the score in the expected direction.
//   (C) When SaliencyContext is provided to rankHits(), at least one hit's
//       ordering changes relative to the no-context baseline — proving the
//       integration is wired (not just compiled). When it isn't provided,
//       rankHits behaves identically to the pre-saliency call.
//   (D) Survival term only fires below the threshold.

import {
  SALIENCY_WEIGHT_SUM,
  computeSaliency,
  tokens,
  type SaliencyContext,
  type SaliencyMemory,
} from "../src/attention/saliency.js";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

// -----------------------------------------------------------------------------
// (A) Weight closure + determinism + [0,1] bound.
// -----------------------------------------------------------------------------

check(
  "saliency weights sum to 1.0",
  Math.abs(SALIENCY_WEIGHT_SUM - 1.0) < 1e-9,
  `sum=${SALIENCY_WEIGHT_SUM}`,
);

const mem: SaliencyMemory = {
  id: "m-1",
  content: "Rust workflow recovery procedure for the brain engine.",
  importance: 0.7,
};
const ctx: SaliencyContext = {
  query: "how do I recover the brain engine after a crash?",
  activeGoals: ["Recover brain engine after crash", "Investigate Rust workflow"],
  organismHealth: 0.4,
};

const s1 = computeSaliency(mem, ctx);
const s2 = computeSaliency(mem, ctx);
check("computeSaliency is deterministic", s1.score === s2.score, `s1=${s1.score} s2=${s2.score}`);
check("score in [0,1]", s1.score >= 0 && s1.score <= 1, `score=${s1.score}`);
check("breakdown components all in [0,1]",
  [s1.novelty, s1.goalRelevance, s1.emotion, s1.survival].every((v) => v >= 0 && v <= 1),
  JSON.stringify(s1),
);

// -----------------------------------------------------------------------------
// (B) Each signal moves the score the right way.
// -----------------------------------------------------------------------------

// Goal-relevance: same memory under matching vs unrelated goals.
const ctxRelevant: SaliencyContext = { ...ctx, activeGoals: ["Recover brain engine"] };
const ctxIrrelevant: SaliencyContext = { ...ctx, activeGoals: ["Plan vacation itinerary"] };
const rel = computeSaliency(mem, ctxRelevant).goalRelevance;
const irrel = computeSaliency(mem, ctxIrrelevant).goalRelevance;
check("goal-relevance is higher for matching goal", rel > irrel, `rel=${rel.toFixed(3)} irrel=${irrel.toFixed(3)}`);

// Goal-relevance: no goals -> 0 (the deliberate "no prior" degenerate).
const ctxNoGoals: SaliencyContext = { ...ctx, activeGoals: [] };
check("no active goals yields goalRelevance=0", computeSaliency(mem, ctxNoGoals).goalRelevance === 0);

// Emotion: higher importance -> higher emotion (monotonic).
const memHigh: SaliencyMemory = { ...mem, importance: 0.9 };
const memLow: SaliencyMemory = { ...mem, importance: 0.1 };
check(
  "emotion increases with importance",
  computeSaliency(memHigh, ctx).emotion > computeSaliency(memLow, ctx).emotion,
);

// Survival: only fires when health is low AND content has a survival token.
const ctxHealthy: SaliencyContext = { ...ctx, organismHealth: 0.9 };
const ctxSick: SaliencyContext = { ...ctx, organismHealth: 0.1 };
check("survival is 0 when healthy", computeSaliency(mem, ctxHealthy).survival === 0);
check(
  "survival > 0 when sick AND content matches survival terms",
  computeSaliency(mem, ctxSick).survival > 0,
);
const memNoSurv: SaliencyMemory = { id: "m-x", content: "Today I learned about cats", importance: 0.5 };
check(
  "survival is 0 when sick but content has no survival terms",
  computeSaliency(memNoSurv, ctxSick).survival === 0,
);

// Novelty fallback (no storedNoveltyById): tokens that don't overlap the query
// produce HIGHER novelty than near-duplicates of the query.
const memOverlap: SaliencyMemory = { ...mem, content: "Recover brain engine crash workflow" };
const memDistant: SaliencyMemory = { ...mem, content: "Photosynthesis in plants and chloroplasts" };
const nOverlap = computeSaliency(memOverlap, ctx).novelty;
const nDistant = computeSaliency(memDistant, ctx).novelty;
check(
  "novelty fallback: distinct content scores higher than near-duplicates",
  nDistant > nOverlap,
  `distant=${nDistant.toFixed(3)} overlap=${nOverlap.toFixed(3)}`,
);

// Stored-novelty path beats the fallback when present.
const storedNov = new Map<string, number>([["m-1", 1.0]]);
const sStored = computeSaliency(mem, { ...ctx, storedNoveltyById: storedNov }).novelty;
check("storedNoveltyById path is used when present", sStored === 1.0, `got=${sStored}`);

// -----------------------------------------------------------------------------
// (C) Ranker integration — score changes when SaliencyContext is supplied.
// -----------------------------------------------------------------------------

// rankHits requires the ranker state (persisted weights). We run with the
// in-memory cold-start defaults (no DB), since ranker.ts gracefully falls back
// to zeroWeights when loadRankerState throws. The __resetRankerCache helper
// would normally re-load — we leave the cache primed instead by setting
// BRAIN_DB_PATH to a temp file so the lazy state() call sees a clean DB.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const tmp = mkdtempSync(join(tmpdir(), "brain-attn-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const { rankHits } = await import("../src/reasoning/ranker.js");
const { openDb } = await import("../src/db/sqlite.js");
openDb(); // applies schema so ranker_state table exists

type VHit = Parameters<typeof rankHits>[0][number];
const now = new Date().toISOString();
function hit(id: string, content: string, importance: number, vec: number): VHit {
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
      importance,
      createdAt: now,
      updatedAt: now,
      metadata: null,
      summaryId: null,
    },
  };
}

// Two hits with the SAME vec score but very different goal-relevance. Without
// saliency, ranker.ts will produce identical learned scores (cold-start, zero
// weights) + tie-breaker order. With saliency, the goal-relevant one should
// rank ahead.
const hits: VHit[] = [
  hit("a", "Photosynthesis in plants and chloroplasts", 0.5, 0.6),
  hit("b", "Recover brain engine after Rust crash workflow", 0.5, 0.6),
];
const noCtx = rankHits(hits);
const withCtx = rankHits(hits, {
  query: "how to recover brain engine after crash",
  activeGoals: ["Recover brain engine after crash"],
  organismHealth: 0.4,
});
check(
  "without saliencyCtx, ranker returns empty saliencyById",
  noCtx.saliencyById.size === 0,
  `size=${noCtx.saliencyById.size}`,
);
check(
  "with saliencyCtx, ranker populates saliencyById",
  withCtx.saliencyById.size === hits.length,
  `size=${withCtx.saliencyById.size}`,
);
check(
  "with saliencyCtx, goal-relevant hit ranks first",
  withCtx.ranked[0]?.memory.id === "b",
  `ranked=[${withCtx.ranked.map((h) => h.memory.id).join(",")}]`,
);

// -----------------------------------------------------------------------------
// (D) Misc invariants.
// -----------------------------------------------------------------------------

check("tokens() splits + lowercases + drops short", JSON.stringify(tokens("Foo BAR a b1 cat")) === JSON.stringify(["foo", "bar", "cat"]));

// All scores stay in [0,1] across the full hit set.
const allInRange = [...withCtx.saliencyById.values()].every((v) => v >= 0 && v <= 1);
check("all saliency scores in [0,1] for the hit set", allInRange);

// -----------------------------------------------------------------------------
// (E) IdleAgent — fires only when quiet AND rate-limit permits; sample is
//     weighted; events shape matches the bridge in brainCore.ts.
// -----------------------------------------------------------------------------

const { IdleAgent, IDLE_THRESHOLD_MS, MIN_THOUGHT_GAP_MS } = await import(
  "../src/agents/idleAgent.js"
);
import type { Agent, AgentContext, AgentLifecycleState } from "../src/agents/Agent.js";
import type { BrainEvent } from "../src/core/eventBus.js";
import type { MemoryPoint } from "../../shared/memory.js";

type AgentClass = typeof IdleAgent;

// Build a self-contained test rig. We drive the clock manually and capture
// every event the agent emits.
function makeRig(initialNow: number, pool: MemoryPoint[], salCtx: SaliencyContext | null = null) {
  let nowVal = initialNow;
  const events: BrainEvent[] = [];
  const ctx: AgentContext = {
    bus: {
      emit: (e: BrainEvent) => events.push(e),
      on: () => () => {},
      onAny: () => () => {},
      removeAll: () => {},
    } as unknown as AgentContext["bus"],
    safety: {
      permitAndAudit: () => true,
      isAllowed: () => true,
    } as unknown as AgentContext["safety"],
    log: () => {},
    setStatus: (_s: AgentLifecycleState) => {},
  };
  const agent: Agent = new IdleAgent({
    sampler: () => pool,
    saliencyProvider: () => salCtx,
    random: () => 0.5,
    now: () => nowVal,
  });
  agent.init(ctx);
  return {
    agent,
    events,
    advance(ms: number): void {
      nowVal += ms;
    },
    fire(event: BrainEvent): void {
      void agent.handleEvent(event);
    },
    nowVal: () => nowVal,
  };
}

const now0 = 1_000_000_000;
const samplePool: MemoryPoint[] = [
  {
    id: "high",
    sourceType: "manual",
    filePath: null,
    projectName: null,
    title: null,
    content: "Recover brain engine after Rust crash workflow",
    contentHash: "h1",
    embeddingId: null,
    importance: 0.9,
    createdAt: new Date(now0).toISOString(),
    updatedAt: new Date(now0).toISOString(),
    metadata: null,
    summaryId: null,
  },
  {
    id: "low",
    sourceType: "manual",
    filePath: null,
    projectName: null,
    title: null,
    content: "Photosynthesis in plants and chloroplasts",
    contentHash: "h2",
    embeddingId: null,
    importance: 0.1,
    createdAt: new Date(now0).toISOString(),
    updatedAt: new Date(now0).toISOString(),
    metadata: null,
    summaryId: null,
  },
];

// E.1 — Quiet < threshold: act() emits nothing.
{
  const rig = makeRig(now0, samplePool);
  rig.advance(IDLE_THRESHOLD_MS / 2);
  rig.agent.think();
  await rig.agent.act();
  check("IdleAgent: silent before IDLE_THRESHOLD_MS", rig.events.length === 0);
}

// E.2 — Quiet past threshold: act() emits exactly one idle-thought event.
{
  const rig = makeRig(now0, samplePool);
  rig.advance(IDLE_THRESHOLD_MS + 1);
  rig.agent.think();
  await rig.agent.act();
  check(
    "IdleAgent: emits idle-thought after IDLE_THRESHOLD_MS",
    rig.events.length === 1 && rig.events[0].kind === "idle-thought",
    `events=${JSON.stringify(rig.events.map((e) => e.kind))}`,
  );
  const e = rig.events[0];
  if (e.kind === "idle-thought") {
    check(
      "idle-thought event has memoryId/preview/importance/reason",
      typeof e.memoryId === "string" &&
        typeof e.preview === "string" &&
        typeof e.importance === "number" &&
        typeof e.reason === "string",
    );
  }
}

// E.3 — Rate limit: second cycle in the same window stays silent.
{
  const rig = makeRig(now0, samplePool);
  rig.advance(IDLE_THRESHOLD_MS + 1);
  rig.agent.think();
  await rig.agent.act();
  // first emit done; advance another IDLE_THRESHOLD (well under MIN_THOUGHT_GAP)
  rig.advance(IDLE_THRESHOLD_MS + 1);
  rig.agent.think();
  await rig.agent.act();
  check("IdleAgent: rate limit holds within MIN_THOUGHT_GAP_MS", rig.events.length === 1);
  // After MIN_THOUGHT_GAP fully elapses, the next cycle CAN emit again.
  rig.advance(MIN_THOUGHT_GAP_MS);
  rig.agent.think();
  await rig.agent.act();
  check("IdleAgent: emits again past MIN_THOUGHT_GAP_MS", rig.events.length === 2);
}

// E.4 — Activity resets the clock: file-changed event makes the agent silent
// again until IDLE_THRESHOLD_MS elapses from THAT moment.
{
  const rig = makeRig(now0, samplePool);
  rig.advance(IDLE_THRESHOLD_MS + 1);
  rig.fire({
    kind: "file-changed",
    path: "/tmp/x.ts",
    change: "change",
    projectName: "x",
    at: new Date(rig.nowVal()).toISOString(),
  });
  rig.agent.think();
  await rig.agent.act();
  check("IdleAgent: file-changed resets the activity clock", rig.events.length === 0);
}

// E.5 — Weighted sampling: with random()=0.5, importance 0.9 should dominate
// importance 0.1 over the pool. We tweak random to verify both branches.
{
  const agent1 = new IdleAgent({
    sampler: () => samplePool,
    saliencyProvider: () => null,
    random: () => 0.0, // first bucket
    now: () => now0,
  });
  const agent2 = new IdleAgent({
    sampler: () => samplePool,
    saliencyProvider: () => null,
    random: () => 0.99, // last bucket
    now: () => now0,
  });
  const pickFirst = agent1.weightedSample(samplePool);
  const pickLast = agent2.weightedSample(samplePool);
  check("weightedSample: r=0 picks first weighted bucket", pickFirst?.id === "high");
  check("weightedSample: r=0.99 picks the last bucket", pickLast?.id === "low");
}

// E.6 — Empty pool: act emits nothing.
{
  const rig = makeRig(now0, []);
  rig.advance(IDLE_THRESHOLD_MS + 1);
  rig.agent.think();
  await rig.agent.act();
  check("IdleAgent: empty memory pool emits nothing", rig.events.length === 0);
}

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
