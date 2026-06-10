// Neuromodulator bus — emotion as GLOBAL state that retunes computation.
//
// Real neuromodulators are not per-memory scores (saliency already has those);
// they are brain-wide scalars that change HOW every subsystem computes at once.
// Three are modelled, each with a baseline it decays back toward:
//
//   dopamine       — reward. Pulsed by 👍 feedback and by answers that actually
//                    cited memory (the dense reward the RL layer already uses).
//                    Consumer: the ranker's online learning rate scales with it
//                    (reward → consolidate harder; drought → learn cautiously).
//
//   norepinephrine — surprise/arousal. Pulsed by prediction error (the
//                    predictive-processing layer), contradictions from the
//                    error step, and immune events. Consumer: the retrieval
//                    BROADEN gate — high arousal forces multi-query expansion
//                    exactly like a low-confidence prior cycle does.
//
//   acetylcholine  — uncertainty / fresh-data hunger. Pulsed by low-confidence
//                    cycles. Consumer: the web-augment heuristic — a brain that
//                    keeps being uncertain starts preferring fresh perception
//                    (web research) over memory. Egress stays behind the
//                    existing hybridEnabled()/LOCAL_ONLY gate — ACh can only
//                    vote, never bypass.
//
// Design rules (the attention/saliency.ts discipline):
//   - The MATH is pure + exported: decay, pulses, and every consumer gate take
//     levels as arguments so the selfcheck drives them with no DB.
//   - The singleton persists one JSON row in brain_metadata (the adaptive-layer
//     pattern — no migration), decays lazily on read from the stored timestamp,
//     and is failure-isolated: any DB fault degrades to baseline levels, which
//     make every consumer a no-op (scale 1.0, gates closed).

import { openDb } from "../db/sqlite.js";
import { surfaceError } from "../util/diagnostics.js";

export interface ModulatorLevels {
  dopamine: number;
  norepinephrine: number;
  acetylcholine: number;
}

export interface ModulatorState {
  levels: ModulatorLevels;
  /** ms epoch of the last write — lazy decay is computed from this. */
  updatedAt: number;
  /** Total pulses applied, for the status surface. */
  pulses: number;
}

// Baselines. Dopamine sits mid-scale (its consumer is a symmetric ±scale);
// NE/ACh sit low (their consumers are high-water gates).
export const BASELINE: ModulatorLevels = {
  dopamine: 0.5,
  norepinephrine: 0.2,
  acetylcholine: 0.2,
};

// Half-life of the deviation from baseline. Arousal fades in minutes, reward
// tone fades slower — mirrors the real pharmacokinetics coarsely.
export const HALF_LIFE_MS: ModulatorLevels = {
  dopamine: 45 * 60_000,
  norepinephrine: 10 * 60_000,
  acetylcholine: 20 * 60_000,
};

// Consumer gates/scales (exported so the selfcheck pins them).
export const NE_BROADEN_FLOOR = 0.6; // ≥ this → force multi-query expansion
export const ACH_AUGMENT_FLOOR = 0.7; // ≥ this → vote for web augmentation
const LR_SCALE_MIN = 0.5; // dopamine 0 → half learning rate
const LR_SCALE_MAX = 1.5; // dopamine 1 → 1.5× learning rate

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// -----------------------------------------------------------------------------
// PURE math — the selfcheck drives these directly.
// -----------------------------------------------------------------------------

/** Exponential decay of one level toward its baseline. dt<=0 is a no-op. */
export function decayLevel(level: number, baseline: number, dtMs: number, halfLifeMs: number): number {
  if (!(dtMs > 0) || !(halfLifeMs > 0)) return clamp01(level);
  const factor = Math.pow(0.5, dtMs / halfLifeMs);
  return clamp01(baseline + (clamp01(level) - baseline) * factor);
}

/** Decay all three levels toward baseline. Pure. */
export function decayLevels(levels: ModulatorLevels, dtMs: number): ModulatorLevels {
  return {
    dopamine: decayLevel(levels.dopamine, BASELINE.dopamine, dtMs, HALF_LIFE_MS.dopamine),
    norepinephrine: decayLevel(levels.norepinephrine, BASELINE.norepinephrine, dtMs, HALF_LIFE_MS.norepinephrine),
    acetylcholine: decayLevel(levels.acetylcholine, BASELINE.acetylcholine, dtMs, HALF_LIFE_MS.acetylcholine),
  };
}

/** Additive pulse, clamped to [0,1]. Negative deltas (e.g. 👎) are allowed. */
export function applyPulse(level: number, delta: number): number {
  return clamp01(clamp01(level) + (Number.isFinite(delta) ? delta : 0));
}

/**
 * Dopamine consumer — scales the ranker/reranker online learning rate.
 * Baseline dopamine (0.5) → exactly 1.0, so the modulator is a strict no-op
 * until reward signal has actually moved it.
 */
export function learningRateScale(levels: ModulatorLevels): number {
  return LR_SCALE_MIN + clamp01(levels.dopamine) * (LR_SCALE_MAX - LR_SCALE_MIN);
}

/** Norepinephrine consumer — arousal-driven retrieval broadening. */
export function shouldBroadenFromArousal(levels: ModulatorLevels): boolean {
  return clamp01(levels.norepinephrine) >= NE_BROADEN_FLOOR;
}

/** Acetylcholine consumer — vote for fresh data (web augment) over memory. */
export function wantsFreshData(levels: ModulatorLevels): boolean {
  return clamp01(levels.acetylcholine) >= ACH_AUGMENT_FLOOR;
}

/**
 * Map one completed reasoning cycle onto pulses. Pure — the singleton applies
 * the result. Citations are the dense reward; a cited answer also relieves
 * uncertainty, an uncited one builds it; contradictions are arousing.
 */
export function pulsesForCycle(input: {
  confidence: number;
  citedCount: number;
  contradictions: number;
}): ModulatorLevels {
  const cited = Math.max(0, Math.floor(input.citedCount));
  const conf = clamp01(input.confidence);
  return {
    dopamine: cited > 0 ? Math.min(0.15, 0.05 * cited) : -0.03,
    norepinephrine: Math.min(0.3, 0.1 * Math.max(0, Math.floor(input.contradictions))),
    acetylcholine: cited > 0 && conf >= 0.5 ? -0.1 : (1 - conf) * 0.2,
  };
}

// -----------------------------------------------------------------------------
// Persisted singleton (brain_metadata KV, lazy decay).
// -----------------------------------------------------------------------------

const META_KEY = "neuromodulators-v1";

class NeuromodulatorBus {
  // `clock` injectable for the selfcheck; production uses the wall clock.
  constructor(private readonly clock: () => number = () => Date.now()) {}

  private readState(): ModulatorState {
    try {
      const row = openDb()
        .prepare("SELECT value FROM brain_metadata WHERE key = ?")
        .get(META_KEY) as { value: string } | undefined;
      if (row) {
        const parsed = JSON.parse(row.value) as Partial<ModulatorState>;
        if (parsed.levels && typeof parsed.updatedAt === "number") {
          return {
            levels: {
              dopamine: clamp01(parsed.levels.dopamine ?? BASELINE.dopamine),
              norepinephrine: clamp01(parsed.levels.norepinephrine ?? BASELINE.norepinephrine),
              acetylcholine: clamp01(parsed.levels.acetylcholine ?? BASELINE.acetylcholine),
            },
            updatedAt: parsed.updatedAt,
            pulses: parsed.pulses ?? 0,
          };
        }
      }
    } catch (err) {
      surfaceError("neuromodulators.read", err);
    }
    return { levels: { ...BASELINE }, updatedAt: this.clock(), pulses: 0 };
  }

  private writeState(state: ModulatorState): void {
    try {
      openDb()
        .prepare(
          "INSERT INTO brain_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(META_KEY, JSON.stringify(state));
    } catch (err) {
      surfaceError("neuromodulators.write", err);
    }
  }

  /** Current levels with lazy decay applied. Never throws — degrades to baseline. */
  levels(): ModulatorLevels {
    const state = this.readState();
    return decayLevels(state.levels, this.clock() - state.updatedAt);
  }

  /** Status surface for the route: levels + derived consumer signals. */
  status(): {
    levels: ModulatorLevels;
    baseline: ModulatorLevels;
    learningRateScale: number;
    broadenFromArousal: boolean;
    wantsFreshData: boolean;
    pulses: number;
  } {
    const state = this.readState();
    const levels = decayLevels(state.levels, this.clock() - state.updatedAt);
    return {
      levels,
      baseline: BASELINE,
      learningRateScale: learningRateScale(levels),
      broadenFromArousal: shouldBroadenFromArousal(levels),
      wantsFreshData: wantsFreshData(levels),
      pulses: state.pulses,
    };
  }

  private pulse(deltas: Partial<ModulatorLevels>): void {
    const state = this.readState();
    const decayed = decayLevels(state.levels, this.clock() - state.updatedAt);
    this.writeState({
      levels: {
        dopamine: applyPulse(decayed.dopamine, deltas.dopamine ?? 0),
        norepinephrine: applyPulse(decayed.norepinephrine, deltas.norepinephrine ?? 0),
        acetylcholine: applyPulse(decayed.acetylcholine, deltas.acetylcholine ?? 0),
      },
      updatedAt: this.clock(),
      pulses: state.pulses + 1,
    });
  }

  /** One completed reasoning cycle (pipeline learning step). */
  onCycle(input: { confidence: number; citedCount: number; contradictions: number }): void {
    this.pulse(pulsesForCycle(input));
  }

  /** Explicit 👍/👎 — the strongest reward signal the user can give. */
  onFeedback(rating: 1 | -1): void {
    this.pulse({ dopamine: rating > 0 ? 0.2 : -0.15 });
  }

  /** Prediction error from the predictive-processing layer ([0,1]). */
  onSurprise(magnitude: number): void {
    this.pulse({ norepinephrine: clamp01(magnitude) * 0.4 });
  }
}

export type { NeuromodulatorBus };

let singleton: NeuromodulatorBus | null = null;

export function getNeuromodulators(): NeuromodulatorBus {
  if (!singleton) singleton = new NeuromodulatorBus();
  return singleton;
}

/** Test-only: a fresh instance with an injectable clock (shares the DB). */
export function __createNeuromodulatorsForTests(clock?: () => number): NeuromodulatorBus {
  return new NeuromodulatorBus(clock);
}

/** Test-only: drop the singleton. */
export function __resetNeuromodulatorsForTests(): void {
  singleton = null;
}
