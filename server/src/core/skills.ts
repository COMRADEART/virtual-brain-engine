// Skill registry — "what am I good at, and am I getting better?"
//
// The master vision asks for a skill store tracking mastery / usage / success /
// failure / last-practice / growth-trend. The brain ALREADY mines that data:
// procedural.ts learns recurring action sequences that WORK and scores them
// with a Laplace success estimate (successCount / failureCount / score /
// lastUsedAt). This module is the unifying READ-COMPOSER over that source — it
// reshapes procedural records into the skill vocabulary and adds the one field
// procedural memory lacks: a GROWTH TREND.
//
// Growth needs history, so a tiny KV (`skill-trends-v1`) snapshots each skill's
// mastery at consolidation time (sleep). The trend at read time is
// (current mastery − last snapshot): a skill the brain has been practising into
// reliability trends UP, one decaying from disuse trends DOWN. Snapshotting on
// sleep (not every read) is what makes the trend meaningful over a day, not noisy.
//
// Discipline: composeSkills is PURE (selfcheck-driven, no DB); gatherSkills and
// snapshotSkillTrends are the thin DB wrappers and NEVER throw.

import { openDb } from "../db/sqlite.js";
import { surfaceError } from "../util/diagnostics.js";
import { listProcedures, type ProcedureRecord } from "../memory/procedural.js";

export type GrowthDirection = "rising" | "steady" | "falling";

export interface SkillRecord {
  id: string;
  name: string;
  /** Laplace-smoothed reliability in [0,1] — the procedure's score. */
  mastery: number;
  /** Total times the skill has run (successes + failures). */
  usageFrequency: number;
  successRate: number;
  failureRate: number;
  lastPracticed: string | null;
  /** Signed change in mastery since the last consolidation snapshot. */
  growthTrend: number;
  growthDirection: GrowthDirection;
}

const TRENDS_KEY = "skill-trends-v1";
// A mastery change smaller than this counts as "steady" — below measurement noise.
const TREND_EPSILON = 0.02;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function directionOf(delta: number): GrowthDirection {
  if (delta > TREND_EPSILON) return "rising";
  if (delta < -TREND_EPSILON) return "falling";
  return "steady";
}

// -----------------------------------------------------------------------------
// PURE composition — the selfcheck drives this directly (no DB).
// -----------------------------------------------------------------------------

/**
 * Reshape procedural records into skill records, computing success/failure
 * rates and a growth trend against `priorMastery` (skill id → last snapshot;
 * a skill with no prior sample has trend 0). Pure.
 */
export function composeSkills(
  procedures: ReadonlyArray<ProcedureRecord>,
  priorMastery: Record<string, number>,
): SkillRecord[] {
  return procedures.map((p) => {
    const runs = Math.max(0, p.successCount) + Math.max(0, p.failureCount);
    const successRate = runs > 0 ? clamp01(p.successCount / runs) : 0;
    const mastery = clamp01(p.score);
    const prior = priorMastery[p.id];
    const delta = typeof prior === "number" && Number.isFinite(prior) ? mastery - clamp01(prior) : 0;
    return {
      id: p.id,
      name: p.title,
      mastery,
      usageFrequency: runs,
      successRate,
      failureRate: runs > 0 ? clamp01(p.failureCount / runs) : 0,
      lastPracticed: p.lastUsedAt,
      growthTrend: delta,
      growthDirection: directionOf(delta),
    };
  });
}

/** Summary line for the self-representation: top strength + clearest gap. */
export function skillSummary(skills: ReadonlyArray<SkillRecord>): { strongest: string | null; weakest: string | null } {
  if (skills.length === 0) return { strongest: null, weakest: null };
  const byMastery = [...skills].sort((a, b) => b.mastery - a.mastery);
  return { strongest: byMastery[0].name, weakest: byMastery[byMastery.length - 1].name };
}

// -----------------------------------------------------------------------------
// DB wrappers — never throw (degrade to empty / a no-op).
// -----------------------------------------------------------------------------

function loadTrends(): Record<string, number> {
  try {
    const row = openDb().prepare("SELECT value FROM brain_metadata WHERE key = ?").get(TRENDS_KEY) as
      | { value: string }
      | undefined;
    if (!row) return {};
    const parsed = JSON.parse(row.value) as unknown;
    if (parsed && typeof parsed === "object") return parsed as Record<string, number>;
    return {};
  } catch (err) {
    surfaceError("skills.loadTrends", err);
    return {};
  }
}

export function gatherSkills(limit = 50): SkillRecord[] {
  try {
    return composeSkills(listProcedures(limit), loadTrends());
  } catch (err) {
    surfaceError("skills.gather", err);
    return [];
  }
}

/**
 * Snapshot every skill's current mastery into the trends KV. Called at
 * consolidation (sleep) so the next read can show movement since. Returns the
 * number of skills snapshotted. Never throws.
 */
export function snapshotSkillTrends(): number {
  try {
    const snapshot: Record<string, number> = {};
    for (const p of listProcedures(200)) snapshot[p.id] = clamp01(p.score);
    openDb()
      .prepare(
        "INSERT INTO brain_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(TRENDS_KEY, JSON.stringify(snapshot));
    return Object.keys(snapshot).length;
  } catch (err) {
    surfaceError("skills.snapshot", err);
    return 0;
  }
}
