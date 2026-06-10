// Phase 1b (improvement plan §18.5) — fed curiosity signal (CIG).
//
// Curiosity here is EXPECTED INFORMATION GAIN over the causal world model
// (core/causalMap.ts), not raw novelty or prediction-error. That distinction is
// the whole point: rewarding raw prediction-error is the "noisy-TV" trap — a
// truly-random source produces unbounded prediction-error forever, so an agent
// chasing it gets stuck staring at static. Information gain does not have that
// failure mode.
//
// Each CausalLink already carries the two numbers we need:
//   • confidence = 1 − exp(−observations/5)  — EPISTEMIC: how much we've
//     observed this cause→effect pair. Reducible by looking again.
//   • strength   = P(effect | cause)         — the estimate itself. NOT used
//     for curiosity, because variance in `strength` is exactly the noisy-TV
//     signal we want to ignore.
//
// The key move: curiosity value per link = (1 − confidence) × impact(effect).
//   - A FRESH high-impact link (observations≈1 → confidence≈0.18) has high
//     `1 − confidence` → high curiosity. Worth exploring.
//   - A SATURATED noisy link (observations≈25 → confidence≈0.99) has near-zero
//     `1 − confidence` EVEN IF its strength sits at a random-looking ~0.5. We
//     are CONFIDENT it's ~50/50; there is nothing left to learn. → near-zero
//     curiosity. This is the noisy-TV immunity, made explicit.
//
// Design rules (matching attention/saliency.ts, the sibling pure module):
//   - The CORE scorer (computeCuriosity) has ZERO runtime deps. No openDb(),
//     no organism import. The CALLER assembles CuriosityInput and passes it in.
//     This is what lets agents:selfcheck exercise it without a database.
//   - Deterministic. Same input → same result.
//   - A thin DB/organism-reading wrapper (gatherCuriosity) sits on top and must
//     NEVER throw — it wraps every read in try/catch and degrades to undefined.

import type { CausalLink } from "./causalMap.js";
import { getAllCausalLinks } from "./causalMap.js";
import { getPersistentOrganism } from "./organism.js";

export interface CuriosityInput {
  causalLinks: CausalLink[];
  /** [0,1], optional — system-wide saliency uncertainty, if cheaply available. */
  saliencyUncertainty?: number;
  /** [0,1], optional — learned-ranker score spread, if cheaply available. */
  rankerSpread?: number;
  /** [0,1], optional — organism health. A stressed organism explores LESS. */
  organismHealth?: number;
}

export interface CuriosityResult {
  /** Blended curiosity in [0,1]. ≥ CURIOSITY_EXPLORE_THRESHOLD ⇒ explore. */
  curiosity: number;
  /** The causal-IG component (max per-link information-gain value) in [0,1]. */
  frontier: number;
  /** causeClass of the most-informative link, or null if no links. */
  topTarget: string | null;
}

// Impact weights per effect class. A high-uncertainty link about FAILURE is
// worth more to resolve than one about routine SUCCESS — getting failure
// predictions right is where the survival payoff is. `prediction-divergent`
// and `deps-changed` sit in the middle; unknown effect classes default to 0.5.
const EFFECT_IMPACT: Record<string, number> = {
  failure: 1.0,
  "high-risk": 0.8,
  "prediction-divergent": 0.6,
  "deps-changed": 0.5,
  success: 0.4,
};
const DEFAULT_IMPACT = 0.5;

function impactFor(effectClass: string): number {
  return EFFECT_IMPACT[effectClass] ?? DEFAULT_IMPACT;
}

// Matches saliency.ts's clamp01 exactly (no rounding) so the two pure modules
// behave identically at the boundaries.
function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * The unified curiosity score. Pure, deterministic, zero deps.
 *
 *   per link:  value = (1 − confidence) × impact(effectClass)
 *   frontier:  max(value) over all links, 0 if none
 *   topTarget: causeClass of the argmax link, null if none
 *   modulation: average of the *provided* (saliencyUncertainty, rankerSpread),
 *               0 when neither is provided (NOT "missing counts as 0")
 *   healthFactor: 1 when health is undefined; otherwise 0.5 + 0.5·clamp01(health)
 *                 — a low-health organism explores less (survival > wandering)
 *   curiosity = clamp01((frontier + 0.15·modulation) · healthFactor)
 */
export function computeCuriosity(input: CuriosityInput): CuriosityResult {
  let frontier = 0;
  let topTarget: string | null = null;
  for (const link of input.causalLinks) {
    const epistemicUncertainty = clamp01(1 - link.confidence);
    const value = epistemicUncertainty * impactFor(link.effectClass);
    if (value > frontier) {
      frontier = value;
      topTarget = link.causeClass;
    }
  }
  frontier = clamp01(frontier);

  // Average over only the provided modulation signals.
  const provided: number[] = [];
  if (typeof input.saliencyUncertainty === "number" && Number.isFinite(input.saliencyUncertainty)) {
    provided.push(clamp01(input.saliencyUncertainty));
  }
  if (typeof input.rankerSpread === "number" && Number.isFinite(input.rankerSpread)) {
    provided.push(clamp01(input.rankerSpread));
  }
  const modulation = provided.length === 0 ? 0 : provided.reduce((a, b) => a + b, 0) / provided.length;

  const healthFactor =
    input.organismHealth === undefined ? 1 : 0.5 + 0.5 * clamp01(input.organismHealth);

  const curiosity = clamp01((frontier + 0.15 * modulation) * healthFactor);

  return { curiosity, frontier, topTarget };
}

/**
 * Thin DB/organism-reading wrapper over computeCuriosity. Reads the causal
 * ledger and the organism's current health, then scores. Best-effort on every
 * input and NEVER throws — a missing DB or un-awakened organism degrades to an
 * empty corpus / undefined health rather than blowing up the IdleAgent's seam.
 */
export function gatherCuriosity(): CuriosityResult {
  let causalLinks: CausalLink[];
  try {
    causalLinks = getAllCausalLinks();
  } catch {
    causalLinks = [];
  }

  let organismHealth: number | undefined;
  try {
    organismHealth = getPersistentOrganism().getHealthScore();
  } catch {
    organismHealth = undefined;
  }

  // saliencyUncertainty / rankerSpread are optional modulators. We do not block
  // on them — passing undefined is spec-compliant and avoids new coupling.
  return computeCuriosity({ causalLinks, organismHealth });
}
