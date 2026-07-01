// Developmental-stages + Brain-Kernel selfcheck — hermetic (throwaway DB via
// BRAIN_DB_PATH, NO LLM, NO network).
//
// Run: npm --prefix server run stages:selfcheck
//
// Asserts:
//   (A) PURE computeStage: fresh metrics ⇒ stage 1; full metrics ⇒ 9; every
//       boundary; gates are CONSECUTIVE (a hole stops the ladder).
//   (B) Persistence is MONOTONIC: an advance persists + emits a
//       `cognition stage-advance` event; lowering the metrics afterwards
//       holds the persisted stage (the ratchet).
//   (C) stageAllows: gates genuinely close on a young brain, open at the
//       feature's stage, and FAIL OPEN when brain_metadata is unreadable.
//   (D) Gating wire-ins: workspace's belief/curiosity bidders respect the
//       stage (young brain → no belief bid even with a contested belief).
//   (E) Kernel: registry lists modules; a THROWING statusFn reports
//       {ok:false} without propagating; bus activity is timestamped;
//       status() is JSON-serializable and carries the stage.
//   (F) Failure isolation: with brain_metadata dropped, recomputeStage and
//       stageAllows never throw (and stageAllows opens).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

const tmp = mkdtempSync(join(tmpdir(), "brain-stages-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const {
  computeStage,
  emptyStageMetrics,
  recomputeStage,
  loadPersistedStage,
  stageAllows,
  currentStage,
  STAGE_NAMES,
  FEATURE_STAGE,
  BELIEFS_FOR_STAGE_2,
  REFLECTIONS_FOR_STAGE_3,
  GOAL_DEPTH_FOR_STAGE_4,
  EXPLORATIONS_FOR_STAGE_5,
  SELF_OBS_FOR_STAGE_6,
  DAILY_THOUGHTS_FOR_STAGE_7,
  MATURE_BINS_FOR_STAGE_8,
  SELF_IMPROVEMENT_UPDATES_FOR_STAGE_9,
} = await import("../src/core/stages.js");
const { BrainKernel, getKernel, __resetKernelForTests } = await import("../src/core/kernel.js");
const { BrainBus } = await import("../src/core/eventBus.js");
const { getEventBus } = await import("../src/core/eventBus.js");
const { openDb } = await import("../src/db/sqlite.js");
import type { BrainEvent } from "../src/core/eventBus.js";
import type { StageMetrics } from "../src/core/stages.js";

const db = openDb();

// -----------------------------------------------------------------------------
// (A) PURE computeStage.
// -----------------------------------------------------------------------------

const full: StageMetrics = {
  memoryCount: 100,
  beliefCount: BELIEFS_FOR_STAGE_2,
  reflectionCount: REFLECTIONS_FOR_STAGE_3,
  goalTreeDepth: GOAL_DEPTH_FOR_STAGE_4,
  explorationEvents: EXPLORATIONS_FOR_STAGE_5,
  selfModelObservations: SELF_OBS_FOR_STAGE_6,
  autonomousThoughtsPerDay: DAILY_THOUGHTS_FOR_STAGE_7,
  matureCalibrationBins: MATURE_BINS_FOR_STAGE_8,
  selfImprovementUpdates: SELF_IMPROVEMENT_UPDATES_FOR_STAGE_9,
};

check("(A) fresh metrics ⇒ stage 1", computeStage(emptyStageMetrics()).stage === 1);
check("(A) stage 1 is named Memory", computeStage(emptyStageMetrics()).name === "Memory");
check("(A) full metrics ⇒ stage 9 (Self-Improvement)",
  computeStage(full).stage === 9 && computeStage(full).name === "Self-Improvement");
check("(A) STAGE_NAMES covers all 9", STAGE_NAMES.length === 9);

// Each boundary: satisfying gates 1..n yields exactly stage n.
{
  const ladder: Array<[keyof StageMetrics, number]> = [
    ["memoryCount", 1],
    ["beliefCount", BELIEFS_FOR_STAGE_2],
    ["reflectionCount", REFLECTIONS_FOR_STAGE_3],
    ["goalTreeDepth", GOAL_DEPTH_FOR_STAGE_4],
    ["explorationEvents", EXPLORATIONS_FOR_STAGE_5],
    ["selfModelObservations", SELF_OBS_FOR_STAGE_6],
    ["autonomousThoughtsPerDay", DAILY_THOUGHTS_FOR_STAGE_7],
    ["matureCalibrationBins", MATURE_BINS_FOR_STAGE_8],
    ["selfImprovementUpdates", SELF_IMPROVEMENT_UPDATES_FOR_STAGE_9],
  ];
  let allBoundariesHold = true;
  const m = emptyStageMetrics();
  for (let n = 0; n < ladder.length; n += 1) {
    m[ladder[n][0]] = ladder[n][1];
    if (computeStage(m).stage !== n + 1) allBoundariesHold = false;
    // One under the NEXT gate stays at n+1.
    if (n + 1 < ladder.length) {
      const under = { ...m, [ladder[n + 1][0]]: ladder[n + 1][1] - 1 };
      if (computeStage(under).stage !== n + 1) allBoundariesHold = false;
    }
  }
  check("(A) every stage boundary holds (at + one-under)", allBoundariesHold);
}

// Gates are consecutive: stage-5 metrics WITHOUT beliefs stall at stage 1.
{
  const holey = { ...full, beliefCount: 0 };
  check("(A) a hole in the ladder stops the climb", computeStage(holey).stage === 1);
}

// -----------------------------------------------------------------------------
// (B) Monotonic persistence + the advance event.
// -----------------------------------------------------------------------------

{
  // Fresh brain: gather (DB is empty) → stage 1, persisted.
  const first = recomputeStage();
  check("(B) fresh brain persists stage 1", first.stage === 1 && !first.advanced, JSON.stringify(first.computed.metrics));

  // Fabricate stage-2 reality: memories + beliefs.
  const now = new Date().toISOString();
  for (let i = 0; i < 3; i += 1) {
    db.prepare(
      `INSERT INTO memory_points (id, source_type, content, content_hash, importance, created_at, updated_at, metadata)
       VALUES (?, 'manual', ?, ?, 0.5, ?, ?, '{}')`,
    ).run(`mp-stage-${i}`, `memory ${i}`, `hash-${i}`, now, now);
  }
  for (let i = 0; i < BELIEFS_FOR_STAGE_2; i += 1) {
    db.prepare(
      `INSERT INTO beliefs (id, statement, statement_hash, confidence, status, supporting_ids, contradicting_ids, evidence_count, formed_at, last_updated)
       VALUES (?, ?, ?, 0.6, 'active', '[]', '[]', 1, ?, ?)`,
    ).run(`belief-stage-${i}`, `belief number ${i}`, `bh-${i}`, now, now);
  }

  const events: BrainEvent[] = [];
  const off = getEventBus().onAny((e) => events.push(e));
  const advanced = recomputeStage();
  off();
  check("(B) growth advances the persisted stage", advanced.stage === 2 && advanced.advanced, `stage=${advanced.stage}`);
  check("(B) the advance emits a cognition stage-advance event",
    events.some((e) => e.kind === "cognition" && e.event.kind === "stage-advance" && e.event.magnitude === 1));

  // The RATCHET: wipe the beliefs; the instantaneous stage falls, the
  // persisted stage holds.
  db.exec("DELETE FROM beliefs");
  const after = recomputeStage();
  check("(B) ratchet holds when metrics regress", after.stage === 2 && after.computed.stage === 1,
    `held=${after.stage} instantaneous=${after.computed.stage}`);
  check("(B) history records the climb", loadPersistedStage().history.some((h) => h.stage === 2));
}

// -----------------------------------------------------------------------------
// (C) stageAllows gates.
// -----------------------------------------------------------------------------

{
  // Persisted stage is 2 now: belief-bids (2) open, the stage-4/5 gates closed.
  check("(C) belief-bids open at stage 2", stageAllows("belief-bids") === true);
  check("(C) goal-decomposition closed below stage 3", stageAllows("goal-decomposition") === false);
  check("(C) curiosity-bids closed below stage 5", stageAllows("curiosity-bids") === false);
  check("(C) exploration closed below stage 5", stageAllows("exploration") === false);
  check("(C) FEATURE_STAGE shape", FEATURE_STAGE["curiosity-bids"] === 5 && FEATURE_STAGE["belief-bids"] === 2);
  // No-deadlock invariant: every feature that grows a stage-gate metric must
  // unlock BEFORE the stage requiring that metric (decompose grows depth,
  // stage 4 requires depth ≥ 2).
  check("(C) decompose unlocks before the stage that needs goal depth", FEATURE_STAGE["goal-decomposition"] < 4);

  // Push the persisted stage to 5 directly; everything opens.
  db.prepare(
    "INSERT INTO brain_metadata (key, value) VALUES ('developmental-stage-v1', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(JSON.stringify({ stage: 5, reachedAt: new Date().toISOString(), history: [] }));
  check("(C) all gates open at stage 5",
    stageAllows("goal-decomposition") && stageAllows("curiosity-bids") && stageAllows("exploration"));
  check("(C) currentStage reads the persisted value", currentStage() === 5);
}

// -----------------------------------------------------------------------------
// (D) Gating wire-ins — workspace bidders respect the stage.
// -----------------------------------------------------------------------------

{
  // A contested belief exists; at stage 1 the belief bidder must stay silent.
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO beliefs (id, statement, statement_hash, confidence, status, supporting_ids, contradicting_ids, evidence_count, formed_at, last_updated)
     VALUES ('belief-gated', 'a contested stance', 'bh-gated', 0.4, 'contested', '[]', '["m"]', 2, ?, ?)`,
  ).run(now, now);
  db.prepare(
    "UPDATE brain_metadata SET value = ? WHERE key = 'developmental-stage-v1'",
  ).run(JSON.stringify({ stage: 1, reachedAt: now, history: [] }));
  const { collectBids } = await import("../src/core/workspace.js");
  const young = collectBids();
  check("(D) stage 1 silences the belief bidder", !young.some((b) => b.kind === "belief"), JSON.stringify(young.map((b) => b.kind)));
  db.prepare(
    "UPDATE brain_metadata SET value = ? WHERE key = 'developmental-stage-v1'",
  ).run(JSON.stringify({ stage: 5, reachedAt: now, history: [] }));
  const mature = collectBids();
  check("(D) stage 5 admits the belief bidder", mature.some((b) => b.kind === "belief"));
}

// -----------------------------------------------------------------------------
// (E) Kernel.
// -----------------------------------------------------------------------------

{
  const bus = new BrainBus();
  const kernel = new BrainKernel(bus);
  kernel.observe();
  kernel.registerModule("healthy", () => ({ ok: true, detail: "fine" }));
  kernel.registerModule("broken", () => {
    throw new Error("probe exploded");
  });
  kernel.noteActivity("healthy");
  bus.emit({ kind: "idle-thought", memoryId: "m", preview: "p", importance: 0.5, reason: "r", at: "2026-06-01T00:00:00.000Z" });

  const status = kernel.status();
  check("(E) registry lists both modules", status.modules.length === 2);
  const broken = status.modules.find((m) => m.name === "broken");
  check("(E) a throwing statusFn reports ok:false without propagating",
    broken?.ok === false && /exploded/.test(broken?.detail ?? ""));
  check("(E) healthy module reports ok + activity",
    status.modules.find((m) => m.name === "healthy")?.ok === true &&
    status.modules.find((m) => m.name === "healthy")?.lastActivityAt !== null);
  check("(E) bus activity is timestamped per kind",
    status.recentEvents["idle-thought"] === "2026-06-01T00:00:00.000Z");
  check("(E) status carries the developmental stage", status.stage.stage >= 1 && typeof status.stage.name === "string");
  let serializable = true;
  try {
    JSON.parse(JSON.stringify(status));
  } catch {
    serializable = false;
  }
  check("(E) status is JSON-serializable", serializable);
  kernel.stop();

  __resetKernelForTests();
  check("(E) getKernel returns a singleton", getKernel() === getKernel());
  __resetKernelForTests();
}

// -----------------------------------------------------------------------------
// (F) Failure isolation — drop brain_metadata; everything degrades, gates OPEN.
// -----------------------------------------------------------------------------

{
  db.exec("DROP TABLE IF EXISTS brain_metadata");
  let threw = false;
  let report;
  try {
    report = recomputeStage();
    currentStage();
  } catch {
    threw = true;
  }
  check("(F) recomputeStage never throws without brain_metadata", threw === false && (report?.stage ?? 0) >= 1);
  check("(F) stageAllows FAILS OPEN on a broken tracker",
    stageAllows("curiosity-bids") === true && stageAllows("goal-decomposition") === true);
}

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
