// Developmental stages — the brain grows up through 7 stages, computed from
// REAL metrics of its own cognition (never a config flag):
//
//   1 Memory               — it remembers (any memory at all)
//   2 Memory + Beliefs     — distilled experience became stances (≥5 beliefs)
//   3 Beliefs + Reflection — it reflects on outcomes (≥10 reflections)
//   4 Reflection + Goals   — the goal tree has real structure (depth ≥2)
//   5 Goals + Curiosity    — curiosity initiates exploration (≥3 events)
//   6 Curiosity + SelfModel— the self-model is measured (≥20 observations)
//   7 Autonomous Growth    — it thinks on its own daily (≥6 thoughts/24h)
//
// The stage is MONOTONIC — growth is a ratchet. A demoted memory or a quiet
// week never regresses the organism (that would flap the UI and the gates);
// `computeStage` may report a lower instantaneous value, but the persisted
// stage only advances, emitting a `stage-advance` cognition event when it does.
//
// Stages GATE features (the "child learning" arc): curiosity bids and idle
// exploration unlock at stage 5, belief re-examination at 2, goal
// decomposition at 4. `stageAllows` FAILS OPEN — a broken tracker must never
// break cognition; gating is a maturation aesthetic, not a safety boundary.
//
// `computeStage` is pure (zero deps — the curiosity.ts design rule);
// `gatherStageMetrics` wraps every DB read in its own try/catch (the
// gatherCuriosity pattern). Persistence is one brain_metadata JSON row.

import { openDb } from "../db/sqlite.js";
import { surfaceError } from "../util/diagnostics.js";
import { getEventBus, nowIso } from "./eventBus.js";
import { regionsFor } from "../../../shared/cognition.js";
import { loadSelfModelState } from "./selfModel.js";
import { getGoalManager, EXPLORATION_EVENTS_KEY } from "./goalManager.js";
import { getBeliefEngine } from "./beliefs.js";

export interface StageMetrics {
  memoryCount: number;
  beliefCount: number;
  reflectionCount: number;
  goalTreeDepth: number;
  explorationEvents: number;
  selfModelObservations: number;
  autonomousThoughtsPerDay: number;
}

export interface StageResult {
  /** Instantaneous stage from the metrics (1-7). */
  stage: number;
  name: string;
  /** Per-stage gate satisfaction, index 0 = stage 1. */
  satisfied: boolean[];
  metrics: StageMetrics;
}

export interface PersistedStage {
  stage: number;
  reachedAt: string;
  history: Array<{ stage: number; at: string }>;
}

export const STAGE_NAMES = [
  "Memory",
  "Memory + Beliefs",
  "Beliefs + Reflection",
  "Reflection + Goals",
  "Goals + Curiosity",
  "Curiosity + Self-Model",
  "Autonomous Growth",
] as const;

// Gate thresholds (stage N requires gates 1..N).
export const BELIEFS_FOR_STAGE_2 = 5;
export const REFLECTIONS_FOR_STAGE_3 = 10;
export const GOAL_DEPTH_FOR_STAGE_4 = 2;
export const EXPLORATIONS_FOR_STAGE_5 = 3;
export const SELF_OBS_FOR_STAGE_6 = 20;
export const DAILY_THOUGHTS_FOR_STAGE_7 = 6;

export type GatedFeature =
  | "belief-bids"
  | "goal-decomposition"
  | "curiosity-bids"
  | "exploration";

/** Feature → the developmental stage at which it unlocks. NOTE: a feature
 *  that GROWS a stage metric must unlock BEFORE the stage that requires the
 *  metric — goal decomposition is the only tree-deepener and stage 4 requires
 *  depth ≥ 2, so it unlocks at 3 (gating it at 4 would deadlock the ladder). */
export const FEATURE_STAGE: Record<GatedFeature, number> = {
  "belief-bids": 2,
  "goal-decomposition": 3,
  "curiosity-bids": 5,
  exploration: 5,
};

const META_KEY = "developmental-stage-v1";

// -----------------------------------------------------------------------------
// PURE stage math (selfcheck-exercisable).
// -----------------------------------------------------------------------------

export function emptyStageMetrics(): StageMetrics {
  return {
    memoryCount: 0,
    beliefCount: 0,
    reflectionCount: 0,
    goalTreeDepth: 0,
    explorationEvents: 0,
    selfModelObservations: 0,
    autonomousThoughtsPerDay: 0,
  };
}

/**
 * Stage = the longest run of CONSECUTIVE satisfied gates from stage 1, never
 * below 1 (an empty brain is still at stage 1 — it is learning to remember).
 */
export function computeStage(m: StageMetrics): StageResult {
  const satisfied = [
    m.memoryCount > 0,
    m.beliefCount >= BELIEFS_FOR_STAGE_2,
    m.reflectionCount >= REFLECTIONS_FOR_STAGE_3,
    m.goalTreeDepth >= GOAL_DEPTH_FOR_STAGE_4,
    m.explorationEvents >= EXPLORATIONS_FOR_STAGE_5,
    m.selfModelObservations >= SELF_OBS_FOR_STAGE_6,
    m.autonomousThoughtsPerDay >= DAILY_THOUGHTS_FOR_STAGE_7,
  ];
  let stage = 0;
  for (const ok of satisfied) {
    if (!ok) break;
    stage += 1;
  }
  stage = Math.max(1, stage);
  return { stage, name: STAGE_NAMES[stage - 1], satisfied, metrics: m };
}

// -----------------------------------------------------------------------------
// Metric gathering — every read failure-isolated (gatherCuriosity pattern).
// -----------------------------------------------------------------------------

export function gatherStageMetrics(): StageMetrics {
  const m = emptyStageMetrics();
  const db = (() => {
    try {
      return openDb();
    } catch (err) {
      surfaceError("stages.openDb", err);
      return null;
    }
  })();
  if (!db) return m;

  try {
    m.memoryCount = (db.prepare("SELECT COUNT(*) AS n FROM memory_points").get() as { n: number }).n;
  } catch (err) {
    surfaceError("stages.memoryCount", err);
  }
  try {
    m.beliefCount = getBeliefEngine().beliefStats().total;
  } catch (err) {
    surfaceError("stages.beliefCount", err);
  }
  try {
    // Reflections = imagination reflections + workspace micro-thoughts (both
    // are the brain examining its own activity).
    const refl = (db.prepare("SELECT COUNT(*) AS n FROM imagination_reflections").get() as { n: number }).n;
    const thoughts = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM memory_points WHERE json_extract(metadata, '$.kind') = 'workspace-thought'`,
        )
        .get() as { n: number }
    ).n;
    m.reflectionCount = refl + thoughts;
  } catch (err) {
    surfaceError("stages.reflectionCount", err);
  }
  try {
    m.goalTreeDepth = getGoalManager().goalTreeDepth();
  } catch (err) {
    surfaceError("stages.goalDepth", err);
  }
  try {
    const row = db.prepare("SELECT value FROM brain_metadata WHERE key = ?").get(EXPLORATION_EVENTS_KEY) as
      | { value: string }
      | undefined;
    m.explorationEvents = Number(row?.value ?? 0) || 0;
  } catch (err) {
    surfaceError("stages.exploration", err);
  }
  try {
    m.selfModelObservations = loadSelfModelState().feedbackObservations;
  } catch (err) {
    surfaceError("stages.selfModel", err);
  }
  try {
    m.autonomousThoughtsPerDay = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM memory_points
           WHERE json_extract(metadata, '$.kind') = 'workspace-thought'
             AND datetime(created_at) >= datetime('now', '-1 day')`,
        )
        .get() as { n: number }
    ).n;
  } catch (err) {
    surfaceError("stages.dailyThoughts", err);
  }
  return m;
}

// -----------------------------------------------------------------------------
// Monotonic persistence + the advance event.
// -----------------------------------------------------------------------------

/**
 * Read the persisted stage. `null` means the TRACKER IS BROKEN (the store is
 * unreadable) — distinct from a healthy cold brain, which returns stage 1.
 * The distinction is what lets `stageAllows` fail OPEN on faults while still
 * genuinely gating a young brain.
 */
export function loadPersistedStageOrNull(): PersistedStage | null {
  try {
    const row = openDb().prepare("SELECT value FROM brain_metadata WHERE key = ?").get(META_KEY) as
      | { value: string }
      | undefined;
    if (row) {
      const parsed = JSON.parse(row.value) as Partial<PersistedStage>;
      if (typeof parsed.stage === "number" && parsed.stage >= 1) {
        return {
          stage: Math.min(7, Math.round(parsed.stage)),
          reachedAt: parsed.reachedAt ?? nowIso(),
          history: Array.isArray(parsed.history) ? parsed.history : [],
        };
      }
    }
    return { stage: 1, reachedAt: nowIso(), history: [{ stage: 1, at: nowIso() }] };
  } catch (err) {
    surfaceError("stages.load", err);
    return null;
  }
}

export function loadPersistedStage(): PersistedStage {
  return loadPersistedStageOrNull() ?? { stage: 1, reachedAt: nowIso(), history: [{ stage: 1, at: nowIso() }] };
}

function savePersistedStage(p: PersistedStage): void {
  try {
    openDb()
      .prepare(
        "INSERT INTO brain_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(META_KEY, JSON.stringify(p));
  } catch (err) {
    surfaceError("stages.save", err);
  }
}

export interface StageReport {
  /** The persisted (monotonic) stage the brain HOLDS. */
  stage: number;
  name: string;
  reachedAt: string;
  /** The instantaneous computation behind it. */
  computed: StageResult;
  advanced: boolean;
}

/**
 * Recompute the instantaneous stage and ratchet the persisted one up if it
 * grew. Emits `cognition stage-advance` on a genuine advance. Never throws.
 */
export function recomputeStage(): StageReport {
  const computed = computeStage(gatherStageMetrics());
  const persisted = loadPersistedStage();
  let advanced = false;
  if (computed.stage > persisted.stage) {
    advanced = true;
    persisted.stage = computed.stage;
    persisted.reachedAt = nowIso();
    persisted.history = [...persisted.history, { stage: computed.stage, at: persisted.reachedAt }].slice(-14);
    savePersistedStage(persisted);
    try {
      getEventBus().emit({
        kind: "cognition",
        event: {
          kind: "stage-advance",
          label: `Developmental stage ${persisted.stage}: ${STAGE_NAMES[persisted.stage - 1]}`,
          detail: `gates: ${computed.satisfied.map((s) => (s ? "✓" : "·")).join(" ")}`,
          magnitude: 1,
          logicalRegions: regionsFor("stage-advance"),
          reason: "stage-tracker",
          at: persisted.reachedAt,
        },
        at: persisted.reachedAt,
      });
    } catch (err) {
      surfaceError("stages.emit", err);
    }
  } else if (persisted.history.length === 0) {
    savePersistedStage({ ...persisted, history: [{ stage: persisted.stage, at: persisted.reachedAt }] });
  }
  return {
    stage: persisted.stage,
    name: STAGE_NAMES[persisted.stage - 1],
    reachedAt: persisted.reachedAt,
    computed,
    advanced,
  };
}

/** The persisted (monotonic) stage. Never throws; a cold brain is stage 1. */
export function currentStage(): number {
  return loadPersistedStage().stage;
}

/**
 * Feature gate — REAL but FAIL-OPEN: a tracker FAULT (unreadable store)
 * allows the feature; a healthy young brain is genuinely gated. Cognition
 * must never be hostage to its own maturity bookkeeping.
 */
export function stageAllows(feature: GatedFeature): boolean {
  try {
    const persisted = loadPersistedStageOrNull();
    if (persisted === null) return true; // broken tracker → open
    return persisted.stage >= (FEATURE_STAGE[feature] ?? 1);
  } catch {
    return true;
  }
}
