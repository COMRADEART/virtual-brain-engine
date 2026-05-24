// ReinforcementSystem — TD/RPE reward learning + curiosity + emotion
// ==================================================================
//
// This is the brain's VALUE machinery. It turns rewards (and the absence of
// expected rewards) into a dopaminergic teaching signal that gates the existing
// STDP — completing the biologically-canonical "three-factor" learning rule
// (Hebbian coincidence × eligibility trace × reward-prediction-error).
//
//   1. VALUE LEARNING (temporal-difference). We keep V(s), an estimate of the
//      long-run reward available from each coarse brain STATE s (a quantised
//      signature of region activity). The TD error
//          δ = r + γ·V(s′) − V(s)
//      is the reward-prediction error (RPE): positive when the world was better
//      than expected, negative when worse. This is exactly what midbrain
//      dopamine neurons (VTA/SNc) encode.
//
//   2. DOPAMINE COUPLING. δ is mapped onto a phasic dopamine level on the inner
//      engine. Because AdvancedBrainCore's STDP rate already scales with
//      dopamine (NeuromodulationSystem.getPlasticityGain), a positive surprise
//      now literally *writes* the synapses that led to it — reward-modulated
//      plasticity, for free, through the existing seam.
//
//   3. CURIOSITY / INTRINSIC MOTIVATION. Extrinsic reward is sparse, so we add an
//      intrinsic drive built from two classic signals:
//        • novelty        — a bonus for rarely-visited states (1/√visits), and
//        • learning progress — a bonus when prediction error (free energy) is
//          *falling*, i.e. the brain is successfully learning something.
//      Curiosity is what makes the system explore what it doesn't yet understand
//      rather than sitting in a comfortable local minimum.
//
//   4. EMOTION. A 2-D affect state (valence, arousal) is derived here: reward
//      shapes valence, surprise shapes arousal. Affect is read by the arbiter to
//      bias decisions (emotional influence on cognition) and exported for the HUD.
//
// Pure logic, allocation-light, no rendering. One `update(dt)` per frame.

import type { AdvancedBrainCore } from "../AdvancedBrainCore";
import type { BrainEventBus } from "../BrainEventBus";
import { REGION_ORDER } from "../brainRegions";
import type { Affect } from "./cognitionTypes";

const GAMMA = 0.95; // discount factor for future value
const VALUE_LR = 0.1; // TD learning rate
const MAX_STATES = 6000; // cap on the value/visit tables (bounded memory)
const DOPAMINE_DEADBAND = 0.02; // |δ| below this leaves dopamine to relax tonically

export class ReinforcementSystem {
  /** V(s): expected long-run reward per coarse state signature. */
  private readonly value = new Map<string, number>();
  /** Visit counts per state (novelty denominator). */
  private readonly visits = new Map<string, number>();

  private prevState: string | null = null;
  private extrinsic = 0; // accumulated extrinsic reward since last update
  private feEma = 0; // EMA of free energy (for learning-progress detection)

  private readonly affect: Affect = { valence: 0, arousal: 0 };

  // Meta-learnable knob (set by MetaLearningSystem via the genome).
  private curiosityWeight = 0.6;

  // Telemetry the HUD / metrics read.
  private lastDelta = 0;
  private lastNovelty = 0;
  private lastLearningProgress = 0;
  /** EMA of "success" (positive RPE rate) — a problem-solving proxy. */
  private successEma = 0;
  /** EMA of |δ| — reward volatility, used by the arbiter's uncertainty signal. */
  private rpeVolatility = 0;

  constructor(
    private readonly core: AdvancedBrainCore,
    private readonly bus: BrainEventBus,
  ) {}

  // ── Public reward entry point ───────────────────────────────────────────────

  /** Report an extrinsic reward (task success +, failure −) from app/pipeline. */
  addExtrinsicReward(value: number, _reason = "extrinsic"): void {
    this.extrinsic += value;
  }

  setCuriosityWeight(w: number): void {
    this.curiosityWeight = w < 0 ? 0 : w;
  }

  // ── Per-frame update ────────────────────────────────────────────────────────

  update(dtSeconds: number): void {
    const s = this.stateSignature();
    const fe = this.core.getFreeEnergy();

    const intrinsic = this.curiosityReward(s, fe, dtSeconds) * this.curiosityWeight;
    const r = this.extrinsic + intrinsic;
    this.extrinsic = 0;

    const vs = this.lookup(s);
    let delta = 0;
    if (this.prevState !== null) {
      const vPrev = this.lookup(this.prevState);
      delta = r + GAMMA * vs - vPrev;
      this.store(this.prevState, vPrev + VALUE_LR * delta);
    }
    this.prevState = s;
    this.lastDelta = delta;

    // Running stats for the arbiter + metrics.
    const a = Math.min(1, dtSeconds * 2);
    this.rpeVolatility += (Math.abs(delta) - this.rpeVolatility) * a;
    this.successEma += ((delta > 0.05 ? 1 : 0) - this.successEma) * Math.min(1, dtSeconds);

    // Phasic dopamine ∝ tanh(δ). Only nudge on a meaningful surprise; otherwise
    // leave the neuromodulator system to relax toward its tonic baseline.
    if (Math.abs(delta) > DOPAMINE_DEADBAND) {
      this.core.setDopamine(clamp01(0.3 + 0.6 * Math.tanh(2.5 * delta)));
    }

    this.updateAffect(delta, fe, dtSeconds);
    this.bus.emit("rl:rpe", {
      delta,
      value: vs,
      valence: this.affect.valence,
      arousal: this.affect.arousal,
    });
  }

  // ── Curiosity (intrinsic reward) ────────────────────────────────────────────

  private curiosityReward(state: string, freeEnergy: number, dtSeconds: number): number {
    // Novelty: rarely-seen states are intrinsically rewarding.
    const visits = this.visits.get(state) ?? 0;
    this.bumpVisit(state, visits);
    const novelty = 1 / Math.sqrt(1 + visits);

    // Learning progress: reward a *falling* free energy (we are explaining the
    // world better than a moment ago). Then update the EMA we compare against.
    const progress = Math.max(0, this.feEma - freeEnergy);
    this.feEma += (freeEnergy - this.feEma) * Math.min(1, dtSeconds * 1.5);
    const progressNorm = Math.min(1, progress / 3);

    this.lastNovelty = novelty;
    this.lastLearningProgress = progressNorm;
    return 0.5 * novelty + 0.5 * progressNorm;
  }

  // ── Emotion (valence/arousal) ───────────────────────────────────────────────

  private updateAffect(delta: number, freeEnergy: number, dtSeconds: number): void {
    const a = Math.min(1, dtSeconds * 2);
    // Valence tracks the sign/size of reward prediction error.
    this.affect.valence += (Math.tanh(2 * delta) - this.affect.valence) * a;
    // Arousal tracks surprise (free energy) and the magnitude of any RPE.
    const targetArousal = Math.min(1, 0.12 * freeEnergy + 0.6 * Math.abs(Math.tanh(2 * delta)));
    this.affect.arousal += (targetArousal - this.affect.arousal) * a;
  }

  // ── State signature ─────────────────────────────────────────────────────────

  /**
   * Compress the per-region activity into a coarse, discrete key. Quantising to
   * three levels keeps the value table bounded while still distinguishing the
   * gross "what is the brain doing" patterns the value function needs.
   */
  private stateSignature(): string {
    const intensity = this.core.regionIntensity;
    let key = "";
    for (let i = 0; i < REGION_ORDER.length; i++) {
      const v = intensity[i] ?? 0;
      key += v > 0.55 ? "2" : v > 0.2 ? "1" : "0";
    }
    return key;
  }

  // ── Bounded-map helpers ─────────────────────────────────────────────────────

  private lookup(state: string): number {
    return this.value.get(state) ?? 0;
  }

  private store(state: string, v: number): void {
    if (!this.value.has(state) && this.value.size >= MAX_STATES) this.evictOldest(this.value);
    this.value.set(state, v);
  }

  private bumpVisit(state: string, current: number): void {
    if (current === 0 && this.visits.size >= MAX_STATES) this.evictOldest(this.visits);
    this.visits.set(state, current + 1);
  }

  /** Map iteration order is insertion order; delete the first (oldest) key. */
  private evictOldest(map: Map<string, number>): void {
    const first = map.keys().next();
    if (!first.done) map.delete(first.value);
  }

  // ── Accessors (HUD / metrics / arbiter) ─────────────────────────────────────

  getAffect(): Readonly<Affect> {
    return this.affect;
  }
  getLastDelta(): number {
    return this.lastDelta;
  }
  getRpeVolatility(): number {
    return this.rpeVolatility;
  }
  getSuccessRate(): number {
    return this.successEma;
  }
  getNovelty(): number {
    return this.lastNovelty;
  }
  getLearningProgress(): number {
    return this.lastLearningProgress;
  }
  getValueTableSize(): number {
    return this.value.size;
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  exportValue(): Array<[string, number]> {
    return [...this.value.entries()];
  }

  importValue(entries: Array<[string, number]>): void {
    this.value.clear();
    for (const [k, v] of entries) this.value.set(k, v);
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
