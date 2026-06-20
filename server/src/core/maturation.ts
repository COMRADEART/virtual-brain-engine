// Developmental activation (H2) — the "infant → adult" arc for the brain's
// richest capabilities.
//
// The most brain-like subsystems (theory-of-mind, narrative grounding,
// imagination, creativity, the adaptive controller, the evolution loop, plus the
// LOOP-CLOSERS active-inference and the event-driven workspace) shipped as static
// default-OFF env flags — so the brain always ran in a reduced mode and never
// GREW into them, despite a real 9-stage developmental ladder existing
// (core/stages.ts). MATURATION now defaults ON so the brain actually grows into
// these; with it on, a young brain is still provably unchanged (stage gate) and
// the loop-closers keep their own cold=heuristic warm-start floors. This resolves
// each cognitive feature's EFFECTIVE enablement:
//
//     active = staticFlag                       (the env override always wins)
//              OR (MATURATION && stage ≥ S)      (it has GROWN into the feature)
//     AND (not an EXPENSIVE feature while energy-depleted)   (H1 composes in)
//
// INVARIANTS:
//   • No-regression — with MATURATION off, isFeatureActive(x) === CONFIG.x
//     exactly (the maturation term is dead), so the default brain is unchanged.
//   • Security is NEVER developmental — localOnly / allowShell / civilization
//     are NOT in this map and can never be auto-enabled by maturity. Growth
//     unlocks COGNITION, never a trust boundary or an egress gate.
//   • Pure + failure-isolated — reads currentStage()/currentEnergyBudget(),
//     both of which already fail-open to "allow / full".

import { CONFIG } from "../config.js";
import { currentStage } from "./stages.js";
import { currentEnergyBudget } from "./energyBudget.js";

export type MaturationFeature =
  | "theory-of-mind"
  | "narrative-grounding"
  | "imagination"
  | "creativity"
  | "adaptive-controller"
  | "evolution-loop"
  // Loop-closers — enacted cognition that was built with a no-regression
  // warm-start floor but shipped static-OFF. Routed through maturation so a
  // genuinely matured brain EARNS them (the stage gate is a second safety layer
  // on top of each feature's own cold=heuristic floor); a young brain is
  // provably unchanged.
  | "active-inference"
  | "event-workspace";

// The developmental stage at which each dark feature is EARNED. Chosen to match
// the ladder's meaning: self-model maturity → ToM; autonomous growth → a self to
// narrate; goals → imagination; curiosity → creativity; self-improvement → the
// learned controller + the evolution loop.
export const MATURATION_STAGE: Record<MaturationFeature, number> = {
  imagination: 4,
  creativity: 5,
  "theory-of-mind": 6,
  // event-driven workspace (reactive consciousness) earns on with autonomous
  // growth; active inference (acting on its own predictions) needs metacognition.
  "event-workspace": 7,
  "narrative-grounding": 7,
  "active-inference": 8,
  "adaptive-controller": 9,
  "evolution-loop": 9,
};

// The static env flag behind each feature (the hard override / off-switch).
const STATIC_FLAG: Record<MaturationFeature, () => boolean> = {
  imagination: () => CONFIG.enablePerRequestImagination,
  creativity: () => CONFIG.creativityEnabled,
  "theory-of-mind": () => CONFIG.theoryOfMind,
  "narrative-grounding": () => CONFIG.narrativeGrounding,
  "adaptive-controller": () => CONFIG.adaptiveController,
  "evolution-loop": () => CONFIG.enableEvolutionLoop,
  "active-inference": () => CONFIG.activeInference,
  "event-workspace": () => CONFIG.workspaceEventDriven,
};

// LLM/compute-heavy features a depleted brain should REST (H1 composition).
const EXPENSIVE: ReadonlySet<MaturationFeature> = new Set<MaturationFeature>([
  "imagination",
  "creativity",
  "evolution-loop",
]);

/**
 * Is this cognitive feature effectively active right now? Composes the static
 * flag, developmental maturity, and (for expensive features) the energy budget.
 */
export function isFeatureActive(feature: MaturationFeature): boolean {
  const staticOn = STATIC_FLAG[feature]();
  const matured = CONFIG.maturation && currentStage() >= MATURATION_STAGE[feature];
  if (!staticOn && !matured) return false;
  // H1: an expensive optional feature rests when the brain is depleted — but
  // only when the energy budget is actually on (currentEnergyBudget is a full
  // no-op otherwise, so this is a no-op when ENERGY_BUDGET is off).
  if (EXPENSIVE.has(feature) && !currentEnergyBudget().mayRunOptional) return false;
  return true;
}

export interface MaturationFeatureStatus {
  feature: MaturationFeature;
  active: boolean;
  staticFlag: boolean;
  requiredStage: number;
  matured: boolean; // unlocked by developmental stage (independent of the static flag)
  expensive: boolean;
  reason: string;
}

export interface MaturationStatus {
  enabled: boolean; // CONFIG.maturation
  stage: number;
  features: MaturationFeatureStatus[];
}

/** Full per-feature status for GET /api/brain/maturation. */
export function maturationStatus(): MaturationStatus {
  const stage = currentStage();
  const mayRunOptional = currentEnergyBudget().mayRunOptional;
  const features = (Object.keys(MATURATION_STAGE) as MaturationFeature[]).map((feature) => {
    const staticFlag = STATIC_FLAG[feature]();
    const requiredStage = MATURATION_STAGE[feature];
    const matured = CONFIG.maturation && stage >= requiredStage;
    const expensive = EXPENSIVE.has(feature);
    const energyBlocked = expensive && !mayRunOptional;
    const active = (staticFlag || matured) && !energyBlocked;
    const reason = staticFlag
      ? energyBlocked
        ? "on (env) — but resting (low energy)"
        : "on (env override)"
      : matured
        ? energyBlocked
          ? `grown into (stage ${stage} ≥ ${requiredStage}) — but resting`
          : `grown into (stage ${stage} ≥ ${requiredStage})`
        : CONFIG.maturation
          ? `locked until stage ${requiredStage} (now ${stage})`
          : "off (static flag + maturation both off)";
    return { feature, active, staticFlag, requiredStage, matured, expensive, reason };
  });
  return { enabled: CONFIG.maturation, stage, features };
}
