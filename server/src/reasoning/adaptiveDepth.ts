// Adaptive depth threshold — learns a small nudge to the pipeline's depth gate
// from observed outcomes, with a no-regression warm-start floor.
//
// The pipeline decides depth via: depth = difficulty >= threshold ? "full" : "shallow"
//   • LOWERING the threshold → more queries become FULL (thorough, slower)
//   • RAISING the threshold → more queries stay SHALLOW (faster)
//
// This module watches what happened after each depth decision and nudges the
// threshold within ±MAX_NUDGE.  Until enough observations accrue (observations
// < warmAt) it returns the base threshold EXACTLY — mirroring the bandit
// warm-start in adaptiveController.ts.

import { openDb } from "../db/sqlite.js";
import { surfaceError } from "../util/diagnostics.js";

// ---------------------------------------------------------------------------
// Types + constants
// ---------------------------------------------------------------------------

export interface AdaptiveDepthState {
  shallowWellCited: number;   // shallow answers that DID cite memory
  shallowPoorlyCited: number; // shallow answers that cited nothing
  fullAddedCitations: number; // full answers that cited memory
  fullNoGain: number;         // full answers that cited nothing (full was wasteful)
  observations: number;
}

export const DEFAULT_WARM_AT = 20;
export const MAX_NUDGE = 0.15;

const META_KEY = "adaptive-depth-v1";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function emptyAdaptiveDepthState(): AdaptiveDepthState {
  return {
    shallowWellCited: 0,
    shallowPoorlyCited: 0,
    fullAddedCitations: 0,
    fullNoGain: 0,
    observations: 0,
  };
}

/**
 * PURE: returns `base` EXACTLY when cold (observations < warmAt).
 * Once warm, nudges within ±MAX_NUDGE and clamps to [0, 1].
 */
export function adjustThreshold(
  base: number,
  state: AdaptiveDepthState,
  warmAt: number = DEFAULT_WARM_AT,
): number {
  if (state.observations < warmAt) {
    return base;
  }

  const lowerPressure =
    state.shallowPoorlyCited /
    Math.max(1, state.shallowWellCited + state.shallowPoorlyCited);

  const raisePressure =
    state.fullNoGain /
    Math.max(1, state.fullAddedCitations + state.fullNoGain);

  // nudge is already in ±MAX_NUDGE because each pressure is in [0,1]
  const nudge = MAX_NUDGE * (raisePressure - lowerPressure);

  return Math.min(1, Math.max(0, base + nudge));
}

/**
 * PURE: fold one observed outcome into the state.  Returns a NEW object.
 */
export function observeDepthOutcome(
  state: AdaptiveDepthState,
  outcome: { depth: "shallow" | "full"; citedCount: number },
): AdaptiveDepthState {
  const next = { ...state, observations: state.observations + 1 };

  if (outcome.depth === "shallow") {
    if (outcome.citedCount > 0) {
      next.shallowWellCited = state.shallowWellCited + 1;
    } else {
      next.shallowPoorlyCited = state.shallowPoorlyCited + 1;
    }
  } else {
    if (outcome.citedCount > 0) {
      next.fullAddedCitations = state.fullAddedCitations + 1;
    } else {
      next.fullNoGain = state.fullNoGain + 1;
    }
  }

  return next;
}

// ---------------------------------------------------------------------------
// Persistence — brain_metadata KV, failure-isolated
// ---------------------------------------------------------------------------

function isValidState(v: unknown): v is AdaptiveDepthState {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.shallowWellCited === "number" &&
    typeof o.shallowPoorlyCited === "number" &&
    typeof o.fullAddedCitations === "number" &&
    typeof o.fullNoGain === "number" &&
    typeof o.observations === "number"
  );
}

export function loadAdaptiveDepthState(): AdaptiveDepthState {
  try {
    const row = openDb()
      .prepare("SELECT value FROM brain_metadata WHERE key = ?")
      .get(META_KEY) as { value: string } | undefined;
    if (row) {
      const parsed: unknown = JSON.parse(row.value);
      if (isValidState(parsed)) {
        return parsed;
      }
    }
  } catch (err) {
    surfaceError("adaptiveDepth.load", err);
  }
  return emptyAdaptiveDepthState();
}

export function saveAdaptiveDepthState(state: AdaptiveDepthState): void {
  try {
    openDb()
      .prepare(
        "INSERT INTO brain_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(META_KEY, JSON.stringify(state));
  } catch (err) {
    surfaceError("adaptiveDepth.save", err);
  }
}
