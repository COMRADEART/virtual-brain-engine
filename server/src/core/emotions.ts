// Emotions — the named affective READ-MODEL.
//
// The master vision asks for eight emotions (curiosity, confidence, fear,
// frustration, satisfaction, excitement, uncertainty, motivation) that
// "emerge from experience" and "influence behavior".
//
// Both halves of that are ALREADY TRUE in this brain — but spread across two
// substrates that retune computation directly:
//   - neuromodulators.ts : dopamine (reward) scales the learning rate,
//     norepinephrine (arousal) broadens retrieval, acetylcholine (uncertainty)
//     votes for fresh input. These are pulsed by real cycle outcomes / feedback.
//   - cognitiveDna.ts    : the stable character that biases curiosity, blending,
//     and exploration.
//
// So rather than add a THIRD store that would double-count, this module DERIVES
// the eight named emotions as a pure read-model over those substrates plus the
// organism's vital state.
//
// HONEST SCOPE: this emotion vector is READ-ONLY. It adds NO new behavioral
// gate of its own — it would be double-counting to do so. The behaviour the
// master vision asks emotion to drive (learning speed, retrieval breadth,
// fresh-data hunger) is ALREADY driven by the substrates these emotions read:
// dopamine scales the learning rate, norepinephrine broadens retrieval,
// acetylcholine votes for fresh data — all in neuromodulators.ts. Emotion here
// is the interpretable NAME for that state, plus the dominant emotion feeds the
// self-representation voice (so it reaches the answer when narrative grounding
// is on). Emotion EMERGES from the same signals that already act; it is not a
// parallel invention and not a display-only afterthought.
//
// Discipline: deriveEmotions is PURE (selfcheck-driven, no DB); gatherEmotions
// is the thin wrapper that assembles inputs from the live singletons and NEVER
// throws (degrades to a calm baseline).

import { surfaceError } from "../util/diagnostics.js";
import { getNeuromodulators, BASELINE, type ModulatorLevels } from "./neuromodulators.js";
import { getCognitiveDna, NEUTRAL_TRAITS, type CognitiveTraits } from "./cognitiveDna.js";
import { getPersistentOrganism } from "./organism.js";

export interface EmotionState {
  curiosity: number;
  confidence: number;
  fear: number;
  frustration: number;
  satisfaction: number;
  excitement: number;
  uncertainty: number;
  motivation: number;
}

export const EMOTION_KEYS: ReadonlyArray<keyof EmotionState> = [
  "curiosity",
  "confidence",
  "fear",
  "frustration",
  "satisfaction",
  "excitement",
  "uncertainty",
  "motivation",
];

export interface EmotionInputs {
  modulators: ModulatorLevels;
  traits: CognitiveTraits;
  /** Organism vitality in [0,1]; 1 = healthy. */
  health: number;
  /** How many goals are currently active. */
  activeGoals: number;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Derive the eight emotions from the affective substrates + vitals. Pure.
 *
 * Each is a distinct, bounded blend (real affect is not orthogonal either):
 *   curiosity     — acetylcholine (info-hunger) × the stable curiosity trait
 *   confidence    — dopamine (reward tone) × the logic trait
 *   fear          — low vitality + arousal that reward is NOT keeping up with
 *   frustration   — arousal WITHOUT reward (NE high, dopamine low)
 *   satisfaction  — reward WITHOUT arousal (dopamine high, calm)
 *   excitement    — arousal WITH reward (NE high AND dopamine high)
 *   uncertainty   — acetylcholine (uncertainty) + reward drought
 *   motivation    — reward + having goals + being well
 */
export function deriveEmotions(input: EmotionInputs): EmotionState {
  const dop = clamp01(input.modulators.dopamine);
  const ne = clamp01(input.modulators.norepinephrine);
  const ach = clamp01(input.modulators.acetylcholine);
  const health = clamp01(input.health);
  const goals = clamp01(Math.max(0, input.activeGoals) / 3);
  const t = input.traits;
  const relu = (v: number): number => (v > 0 ? v : 0);

  return {
    curiosity: clamp01(0.55 * ach + 0.45 * clamp01(t.curiosity)),
    confidence: clamp01(0.6 * dop + 0.4 * clamp01(t.logic)),
    fear: clamp01(0.6 * (1 - health) + 0.4 * relu(ne - dop)),
    frustration: clamp01(ne * (1 - dop) * 1.5),
    satisfaction: clamp01(dop * (1 - ne)),
    excitement: clamp01(2 * ne * dop),
    uncertainty: clamp01(0.6 * ach + 0.4 * (1 - dop)),
    motivation: clamp01(0.4 * dop + 0.3 * goals + 0.3 * health),
  };
}

/** The single strongest emotion right now (for the self-narrative voice + UI). */
export function dominantEmotion(e: EmotionState): { name: keyof EmotionState; value: number } {
  let name: keyof EmotionState = "curiosity";
  let value = -1;
  for (const k of EMOTION_KEYS) {
    if (e[k] > value) {
      value = e[k];
      name = k;
    }
  }
  return { name, value: clamp01(value) };
}

/** A calm baseline emotion state (neutral substrates) — the degrade target. */
export function baselineEmotions(): EmotionState {
  return deriveEmotions({ modulators: BASELINE, traits: NEUTRAL_TRAITS, health: 1, activeGoals: 0 });
}

// -----------------------------------------------------------------------------
// Thin live wrapper — assembles inputs from the singletons; never throws.
// -----------------------------------------------------------------------------

export function gatherEmotions(): EmotionState {
  let modulators: ModulatorLevels = BASELINE;
  try {
    modulators = getNeuromodulators().levels();
  } catch (err) {
    surfaceError("emotions.modulators", err);
  }
  let traits: CognitiveTraits = NEUTRAL_TRAITS;
  try {
    traits = getCognitiveDna().traits();
  } catch (err) {
    surfaceError("emotions.traits", err);
  }
  let health = 1;
  let activeGoals = 0;
  try {
    const organism = getPersistentOrganism();
    health = organism.getHealthScore();
    activeGoals = organism.getActiveGoalTitles().length;
  } catch (err) {
    surfaceError("emotions.organism", err);
  }
  return deriveEmotions({ modulators, traits, health, activeGoals });
}

export function emotionStatus(): { emotions: EmotionState; dominant: { name: string; value: number } } {
  const emotions = gatherEmotions();
  return { emotions, dominant: dominantEmotion(emotions) };
}
