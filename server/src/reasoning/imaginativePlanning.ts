// Imaginative planning (H3) — imagination → decision coupling (advisory foresight).
//
// The brain has been WRITING a causal world model that no decision ever READ:
// imagination.reflect() and the embodiment layer (actions/consequences.ts) both
// feed `causal_links` with per-action outcome statistics (`action:<id>` causes),
// but the agent loop chose its next tool blind to them. This closes the last
// open HIGH roadmap loop (docs/AGI_OS_REVIEW_AND_ROADMAP.md H3, design option
// (a)): before the loop executes a tool, FORESEE its outcome from the learned
// model; when the empirical failure rate is high — with enough observations to
// trust it — the call is deferred ONE round and a foresight warning enters the
// transcript, so the model can revise its plan (different args, a different
// approach) or insist (an immediate repeat proceeds).
//
// INVARIANTS:
//   • ADVISORY, never a privilege — foresight can only DEFER a call, never run
//     one. Every execution still goes through executeAction (allowlist + zod +
//     confirm gate + audit); with foresight on, strictly FEWER things execute.
//   • Bounded — at most one deferral per action id per run (the caller keeps
//     the warned set), so foresight can never live-lock the loop.
//   • No-regression floor — a cold ledger (no failure link, or confidence below
//     FORESIGHT_MIN_CONFIDENCE ≈ 4 real observations) yields no advisory, and
//     an inactive feature yields no advisory: the loop behaves exactly as today.
//   • Failure-isolated — a ledger fault yields null (surfaced), never a throw.

import { predictEffects, type CausalForecast } from "../core/causalMap.js";
import { isFeatureActive } from "../core/maturation.js";
import { surfaceError } from "../util/diagnostics.js";

// Warn only when the action fails MORE OFTEN THAN NOT by a clear margin…
export const FORESIGHT_FAILURE_THRESHOLD = 0.65;
// …and the estimate is grounded in real experience: confidence = 1 − exp(−n/5),
// so ≥ 0.5 requires n ≥ 4 observations. Deliberately stricter than causalMap's
// MIN_USABLE_CONFIDENCE (≈1 observation) — an advisory that redirects the
// model's plan needs more evidence than a score blend does.
export const FORESIGHT_MIN_CONFIDENCE = 0.5;

export interface ActionForesight {
  actionId: string;
  causeClass: string;
  /** Laplace-smoothed P(failure | action), from lived outcomes. */
  expectedFailureRate: number;
  /** Confidence of that estimate (0..1, saturating in observation count). */
  failureConfidence: number;
  /** True when the prediction is bad enough AND trusted enough to defer. */
  warn: boolean;
}

/** Pure: does this (failure rate, confidence) pair justify deferring the call? */
export function assessForesight(expectedFailureRate: number | null, failureConfidence: number): boolean {
  if (expectedFailureRate === null || !Number.isFinite(expectedFailureRate) || !Number.isFinite(failureConfidence)) {
    return false;
  }
  return expectedFailureRate >= FORESIGHT_FAILURE_THRESHOLD && failureConfidence >= FORESIGHT_MIN_CONFIDENCE;
}

/** Pure seam for the selfcheck: foresight from an already-fetched forecast. */
export function foresightFromForecast(actionId: string, forecast: CausalForecast): ActionForesight | null {
  if (forecast.expectedFailureRate === null) return null;
  return {
    actionId,
    causeClass: forecast.causeClass,
    expectedFailureRate: forecast.expectedFailureRate,
    failureConfidence: forecast.failureConfidence,
    warn: assessForesight(forecast.expectedFailureRate, forecast.failureConfidence),
  };
}

/** Is foresight effectively on (static flag OR grown into via maturation)? */
export function foresightActive(): boolean {
  return isFeatureActive("imaginative-planning");
}

/**
 * Foresee the outcome of running `actionId` from the causal ledger. Null when
 * the ledger has no failure history for it (cold floor) or on any fault.
 */
export function foresee(actionId: string): ActionForesight | null {
  try {
    return foresightFromForecast(actionId, predictEffects(`action:${actionId}`));
  } catch (err) {
    surfaceError("imaginativePlanning.foresee", err);
    return null;
  }
}

/** The transcript line the model sees in place of the deferred tool result. */
export function foresightNote(f: ActionForesight): string {
  const pct = Math.round(f.expectedFailureRate * 100);
  return (
    `FORESIGHT: from lived experience, "${f.actionId}" fails ~${pct}% of the time ` +
    `(confidence ${f.failureConfidence.toFixed(2)}), so it was NOT run. Revise the plan — ` +
    `different args or a different approach — or call it again unchanged to proceed anyway.`
  );
}
