// Homeostatic energy budget (H1) — make the organism's tracked energy ACTUALLY
// gate cognition. Energy was bookkeeping (consumed per category + logged) but
// never constrained a single reasoning step or retrieval — the brain could not
// tire or self-pace (zero `energy` refs existed in the pipeline). This maps the
// live energy fraction onto compute limits + a foraging-dampening deficit.
//
// NO-REGRESSION FLOOR: at or above FULL_FLOOR energy the budget is IDENTICAL to
// today's behavior (no penalty, full retrieval, optional subsystems on). Below
// it, compute ramps DOWN toward the floors — a tired brain thinks less hard,
// retrieves a little less, and rests its expensive optional cycles. OFF by
// default (CONFIG.energyBudget); every consumer reads currentEnergyBudget(),
// which returns a FULL budget both when the feature is off and on any read fault
// — so energy can only ever make the brain pace itself, never fail.

import { CONFIG } from "../config.js";
import { getPersistentOrganism } from "./organism.js";
import { surfaceError } from "../util/diagnostics.js";

export interface EnergyBudget {
  fraction: number; // current/capacity, [0,1]
  energyDeficit: number; // 1 − fraction; dampens active-inference foraging
  depthPenalty: number; // added to the depth gate (tired → more queries go shallow)
  retrievalScale: number; // multiplier on retrieval breadth, [MIN_RETRIEVAL_SCALE..1]
  mayRunOptional: boolean; // gate expensive OPTIONAL subsystems (creativity, …)
}

// At/above this fraction the brain is "rested" → the budget is a strict no-op.
export const FULL_FLOOR = 0.5;
export const OPTIONAL_FLOOR = 0.25;
export const MAX_DEPTH_PENALTY = 0.2;
export const MIN_RETRIEVAL_SCALE = 0.6;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// The full (rested) budget — also the failure-isolation + feature-off default,
// so nothing can make the brain think LESS than it does today.
export function fullEnergyBudget(): EnergyBudget {
  return { fraction: 1, energyDeficit: 0, depthPenalty: 0, retrievalScale: 1, mayRunOptional: true };
}

export function energyToBudget(fraction: number): EnergyBudget {
  const f = clamp01(fraction);
  const energyDeficit = clamp01(1 - f);
  if (f >= FULL_FLOOR) {
    return { fraction: f, energyDeficit, depthPenalty: 0, retrievalScale: 1, mayRunOptional: true };
  }
  const t = (FULL_FLOOR - f) / FULL_FLOOR; // 0 at FULL_FLOOR → 1 at empty
  return {
    fraction: f,
    energyDeficit,
    depthPenalty: t * MAX_DEPTH_PENALTY,
    retrievalScale: 1 - t * (1 - MIN_RETRIEVAL_SCALE),
    mayRunOptional: f >= OPTIONAL_FLOOR,
  };
}

// The live budget. A strict full budget when ENERGY_BUDGET is off (so every
// caller can call this unconditionally) and on any read fault.
export function currentEnergyBudget(): EnergyBudget {
  if (!CONFIG.energyBudget) return fullEnergyBudget();
  try {
    return energyToBudget(getPersistentOrganism().getEnergyFraction());
  } catch (err) {
    surfaceError("energyBudget.current", err);
    return fullEnergyBudget();
  }
}
