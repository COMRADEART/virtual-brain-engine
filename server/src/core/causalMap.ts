// Causal world model (blueprint §3 #7) — explicit cause→effect ledger.
//
// Each row tracks P(effect_class | cause_class) accumulated across
// imagination.reflect() observations. The reflection has a predicted future
// (cause = classifyAction(session.action)) and an observed outcome; we
// decompose that outcome into a small set of effect_classes and increment
// (observations, occurrences) independently for each one.
//
// The math:
//   strength   = (occurrences + α) / (observations + α + β),  α = β = 1
//                Laplace smoothing — a never-seen pair starts at 0.5 with
//                low confidence rather than 0/0.
//   confidence = 1 − exp(−observations / K),  K = 5
//                After 5 obs ≈ 0.63; after 15 ≈ 0.95. Used by callers to
//                gate whether to trust strength at all.
//
// Consumers:
//   • imagination.imagine() — uses predictEffects(causeClass) to blend
//     an empirical failure prior into base.riskScore once confidence
//     crosses MIN_USABLE_CONFIDENCE.
//   • selfcheck / debugging — getCausesForEffect / getEffectsForCause
//     surface the learned map for inspection.

import { ulid } from "ulid";
import { openDb } from "../db/sqlite.js";

export const EFFECT_CLASSES = [
  "success",
  "failure",
  "high-risk",
  "deps-changed",
  "prediction-divergent",
] as const;
export type EffectClass = (typeof EFFECT_CLASSES)[number];

export interface CausalLink {
  causeClass: string;
  effectClass: string;
  observations: number;
  occurrences: number;
  strength: number;
  confidence: number;
  lastObservedAt: string;
  source: string;
}

export interface CausalObservation {
  causeClass: string;
  effectClass: string;
  /** Did the effect actually occur this time? */
  occurred: boolean;
  source?: string;
}

export interface CausalForecast {
  causeClass: string;
  effects: CausalLink[];
  /**
   * P(failure | causeClass), Laplace-smoothed. `null` when the failure link
   * has not been observed at all — callers should keep the heuristic prior.
   */
  expectedFailureRate: number | null;
  /** Confidence of the failure-link estimate (0..1). */
  failureConfidence: number;
}

const ALPHA = 1;
const BETA = 1;
const CONF_K = 5;
export const MIN_USABLE_CONFIDENCE = 0.2; // ≈ 1 observation in: 1−exp(−1/5)=0.181

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return Math.round(value * 10000) / 10000;
}

function computeStrength(occurrences: number, observations: number): number {
  return clamp01((occurrences + ALPHA) / (observations + ALPHA + BETA));
}

function computeConfidence(observations: number): number {
  return clamp01(1 - Math.exp(-Math.max(0, observations) / CONF_K));
}

interface CausalRow {
  id: string;
  cause_class: string;
  effect_class: string;
  observations: number;
  occurrences: number;
  strength: number;
  confidence: number;
  last_observed_at: string;
  source: string;
}

function rowToLink(row: CausalRow): CausalLink {
  return {
    causeClass: row.cause_class,
    effectClass: row.effect_class,
    observations: row.observations,
    occurrences: row.occurrences,
    strength: row.strength,
    confidence: row.confidence,
    lastObservedAt: row.last_observed_at,
    source: row.source,
  };
}

/**
 * Record a single observation. Upserts the (cause, effect) row, increments
 * observations, increments occurrences when `occurred`, and recomputes
 * (strength, confidence). Idempotency: this is an aggregation — every call
 * adds one observation, callers should NOT call it twice for the same
 * underlying event.
 */
export function recordObservation(obs: CausalObservation): CausalLink {
  const db = openDb();
  const now = new Date().toISOString();
  const cause = obs.causeClass.trim();
  const effect = obs.effectClass.trim();
  if (!cause || !effect) {
    throw new Error("recordObservation: causeClass and effectClass are required");
  }
  const source = obs.source ?? "imagination-reflection";

  const existing = db
    .prepare<[string, string], CausalRow>(
      `SELECT id, cause_class, effect_class, observations, occurrences, strength, confidence,
              last_observed_at, source
         FROM causal_links WHERE cause_class = ? AND effect_class = ?`,
    )
    .get(cause, effect);

  const observations = (existing?.observations ?? 0) + 1;
  const occurrences = (existing?.occurrences ?? 0) + (obs.occurred ? 1 : 0);
  const strength = computeStrength(occurrences, observations);
  const confidence = computeConfidence(observations);

  if (existing) {
    db.prepare(
      `UPDATE causal_links
         SET observations = ?, occurrences = ?, strength = ?, confidence = ?,
             last_observed_at = ?, source = ?
       WHERE id = ?`,
    ).run(observations, occurrences, strength, confidence, now, source, existing.id);
    return {
      causeClass: cause,
      effectClass: effect,
      observations,
      occurrences,
      strength,
      confidence,
      lastObservedAt: now,
      source,
    };
  }

  const id = `causal-${ulid()}`;
  db.prepare(
    `INSERT INTO causal_links
       (id, cause_class, effect_class, observations, occurrences, strength, confidence,
        last_observed_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, cause, effect, observations, occurrences, strength, confidence, now, source);
  return {
    causeClass: cause,
    effectClass: effect,
    observations,
    occurrences,
    strength,
    confidence,
    lastObservedAt: now,
    source,
  };
}

/** All effects ever observed for a cause, ordered by strength × confidence. */
export function getEffectsForCause(causeClass: string): CausalLink[] {
  const db = openDb();
  const rows = db
    .prepare<[string], CausalRow>(
      `SELECT id, cause_class, effect_class, observations, occurrences, strength, confidence,
              last_observed_at, source
         FROM causal_links WHERE cause_class = ?`,
    )
    .all(causeClass);
  return rows
    .map(rowToLink)
    .sort((a, b) => b.strength * b.confidence - a.strength * a.confidence);
}

/** All causes ever observed for an effect, ordered by strength × confidence. */
export function getCausesForEffect(effectClass: string): CausalLink[] {
  const db = openDb();
  const rows = db
    .prepare<[string], CausalRow>(
      `SELECT id, cause_class, effect_class, observations, occurrences, strength, confidence,
              last_observed_at, source
         FROM causal_links WHERE effect_class = ?`,
    )
    .all(effectClass);
  return rows
    .map(rowToLink)
    .sort((a, b) => b.strength * b.confidence - a.strength * a.confidence);
}

/**
 * Forecast effects for an action class. The headline number is the smoothed
 * P(failure | cause); callers gate on `failureConfidence` to decide whether
 * to trust it over a heuristic prior.
 */
export function predictEffects(causeClass: string): CausalForecast {
  const effects = getEffectsForCause(causeClass);
  const failure = effects.find((link) => link.effectClass === "failure");
  return {
    causeClass,
    effects,
    expectedFailureRate: failure ? failure.strength : null,
    failureConfidence: failure ? failure.confidence : 0,
  };
}

/**
 * Extract effect labels from a reflection outcome. Pure; reusable by callers
 * that need to record from a path other than `imagination.reflect()`.
 *
 * Important: every effect class is recorded for every observation — that's
 * what makes the per-effect probabilities meaningful. Recording only the
 * effects that fired would bias every strength toward 1.0.
 */
export function extractEffectsFromReflection(input: {
  ok: boolean;
  actualRisk: number;
  accuracy: number;
  dependencyChanges: number;
}): Array<{ effectClass: EffectClass; occurred: boolean }> {
  return [
    { effectClass: "success", occurred: input.ok },
    { effectClass: "failure", occurred: !input.ok },
    { effectClass: "high-risk", occurred: input.actualRisk >= 0.5 },
    { effectClass: "deps-changed", occurred: input.dependencyChanges > 0 },
    { effectClass: "prediction-divergent", occurred: input.accuracy < 0.3 },
  ];
}
