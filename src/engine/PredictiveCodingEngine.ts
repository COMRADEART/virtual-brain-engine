// PredictiveCodingEngine — hierarchical prediction & active inference
// ===================================================================
//
// The "predictive brain" view (Friston's Free-Energy Principle / predictive
// coding) says the cortex is a hierarchy of generative models. Each level tries
// to PREDICT the level below it; what flows UP the hierarchy is not raw data but
// PREDICTION ERROR — the part of the input the prediction failed to explain. The
// brain continuously adjusts its internal representations to minimise these
// errors, i.e. to minimise SURPRISE (variational free energy).
//
// Three ideas we implement, at the granularity of brain regions (fast + legible):
//
//   1. TOP-DOWN PREDICTIONS. Higher, more abstract regions (prefrontal →
//      association → sensory) send predictions downward. A region's prediction is
//      built from the current representations of the higher-level regions wired
//      to it (via the anatomical connectome).
//
//   2. BOTTOM-UP PREDICTION ERRORS. error = actual − predicted. Only the error
//      ascends. Each region updates its representation to reduce its own error
//      ("explain away" the input). Large errors mean "the world violated my
//      model" — these become extra drive, so the brain VISIBLY bursts where it is
//      surprised (the requested expectation-violation effect).
//
//   3. PRECISION WEIGHTING. Not all errors are trusted equally. Precision is the
//      inverse variance (confidence) of a region's error channel, scaled by
//      attention (ACh/NE). High precision = "pay attention to this error". This
//      is the gain-control knob that makes attention, in this framework, just a
//      special case of precision-weighting.
//
// FREE ENERGY is reported as the total precision-weighted squared error — the
// quantity the whole system is driving toward zero.

import type { BrainEventBus } from "./BrainEventBus";
import { REGION_BY_ID, REGION_CONNECTIONS, REGION_INDEX, REGION_ORDER } from "./brainRegions";
import type { BrainRegionId } from "./types";

/** Processing hierarchy level: 0 = sensory/input, 1 = association, 2 = executive. */
function hierarchyLevel(regionId: BrainRegionId): number {
  const lobe = REGION_BY_ID[regionId]?.lobe;
  if (regionId.startsWith("prefrontal")) return 2;
  if (
    lobe === "occipital" ||
    regionId.startsWith("auditory") ||
    regionId.startsWith("somatosensory") ||
    regionId.startsWith("thalamus") || // first cortical relay
    regionId === "brainstem" ||
    regionId === "cerebellum"
  ) {
    return 0;
  }
  // temporal, parietal, frontal, motor, hippocampus, amygdala, basal-ganglia
  return 1;
}

export class PredictiveCodingEngine {
  private readonly R: number;
  private readonly level: Int8Array;
  /** For each region, the indices of higher-level regions that predict it. */
  private readonly predictors: number[][];

  // Per-region state (indexed by region order index).
  /** Internal representation / belief about each region's "cause". */
  private readonly representation: Float32Array;
  /** Top-down prediction of each region's activity this step. */
  private readonly prediction: Float32Array;
  /** Signed prediction error = actual − predicted. */
  private readonly error: Float32Array;
  /** Running variance of the error channel (for precision = 1/variance). */
  private readonly errorVar: Float32Array;
  /** Precision (confidence) weight per region. */
  private readonly precision: Float32Array;
  /** Bottom-up extra drive produced by surprise (|precision-weighted error|). */
  readonly errorDrive: Float32Array;
  /** Externally clamped sensory expectations (NaN = no clamp). */
  private readonly sensoryClamp: Float32Array;

  private freeEnergy = 0;
  private readonly learningRate = 0.25;

  constructor(private readonly bus?: BrainEventBus) {
    this.R = REGION_ORDER.length;
    this.level = new Int8Array(this.R);
    this.predictors = new Array(this.R);
    this.representation = new Float32Array(this.R);
    this.prediction = new Float32Array(this.R);
    this.error = new Float32Array(this.R);
    this.errorVar = new Float32Array(this.R).fill(0.01);
    this.precision = new Float32Array(this.R).fill(1);
    this.errorDrive = new Float32Array(this.R);
    this.sensoryClamp = new Float32Array(this.R).fill(NaN);

    // Assign levels.
    for (let i = 0; i < this.R; i++) {
      this.level[i] = hierarchyLevel(REGION_ORDER[i]);
    }

    // Build, for each region, the set of connected HIGHER-level regions. These
    // are the sources of its top-down prediction. Falls back to any region one
    // level up if the anatomical adjacency gives none.
    const neighbours: Map<number, Set<number>> = new Map();
    const link = (a: number, b: number) => {
      if (!neighbours.has(a)) neighbours.set(a, new Set());
      neighbours.get(a)!.add(b);
    };
    for (const [from, to] of REGION_CONNECTIONS) {
      const a = REGION_INDEX[from];
      const b = REGION_INDEX[to];
      if (a === undefined || b === undefined) continue;
      link(a, b);
      link(b, a);
    }
    for (let i = 0; i < this.R; i++) {
      const higher: number[] = [];
      const set = neighbours.get(i);
      if (set) {
        for (const j of set) {
          if (this.level[j] > this.level[i]) higher.push(j);
        }
      }
      this.predictors[i] = higher;
    }
  }

  /**
   * Run one inference step.
   * @param actualActivity per-region observed activity (e.g. regionIntensity).
   * @param attention global attention gain in [0,1] (ACh/NE) — scales precision.
   * @param dtSeconds frame delta (for variance smoothing).
   */
  update(actualActivity: Float32Array, attention: number, dtSeconds: number): void {
    const varAlpha = Math.min(1, dtSeconds * 2); // EMA rate for error variance

    // 1) TOP-DOWN: each region's prediction = mean representation of its
    //    higher-level predictors (sensory regions with no higher connection keep
    //    a small default prediction so error == activity initially).
    for (let i = 0; i < this.R; i++) {
      const preds = this.predictors[i];
      if (preds.length === 0) {
        this.prediction[i] = this.representation[i] * 0.5;
        continue;
      }
      let sum = 0;
      for (const j of preds) sum += this.representation[j];
      this.prediction[i] = sum / preds.length;
    }

    // 2) BOTTOM-UP: error, precision, belief update, free energy.
    let fe = 0;
    for (let i = 0; i < this.R; i++) {
      const actual = Number.isNaN(this.sensoryClamp[i]) ? actualActivity[i] : this.sensoryClamp[i];
      const err = actual - this.prediction[i];
      this.error[i] = err;

      // Precision = attention-scaled inverse variance of this error channel.
      this.errorVar[i] += (err * err - this.errorVar[i]) * varAlpha;
      const baseP = 1 / (this.errorVar[i] + 0.02);
      this.precision[i] = baseP * (0.5 + attention);

      const pe = this.precision[i] * err; // precision-weighted error
      fe += this.precision[i] * err * err;

      // Belief update: move the representation to explain away the error.
      this.representation[i] += this.learningRate * pe;
      if (this.representation[i] < 0) this.representation[i] = 0;
      if (this.representation[i] > 1.5) this.representation[i] = 1.5;

      // Surprise → bottom-up drive. Only POSITIVE errors (more than expected)
      // boost drive — that's the "this is unexpectedly active, attend to it"
      // signal that makes surprised regions burst.
      this.errorDrive[i] = Math.max(0, Math.min(1.5, pe * 0.6));

      // Emit notable errors so the visualiser / neuromodulation can react.
      if (this.errorDrive[i] > 0.6) {
        this.bus?.emit("predict:error", {
          regionId: REGION_ORDER[i],
          magnitude: err,
          precision: this.precision[i],
        });
      }
    }

    this.freeEnergy = fe;
    this.bus?.emit("predict:freeEnergy", { value: fe });

    // Sensory clamps are one-shot per injection: they decay back to "no clamp"
    // so a violation is a transient, not a permanent override.
    for (let i = 0; i < this.R; i++) {
      if (!Number.isNaN(this.sensoryClamp[i])) {
        // relax 30% per step toward release
        const v = this.sensoryClamp[i];
        this.sensoryClamp[i] = v < 0.02 ? NaN : v * 0.7;
      }
    }
  }

  /**
   * Inject an external sensory observation. If `surprise` is true the value is
   * forced FAR from the current prediction (an expectation violation), producing
   * a large, visible prediction error.
   */
  injectSensory(regionId: BrainRegionId, value: number, surprise = false): void {
    const i = REGION_INDEX[regionId];
    if (i === undefined) return;
    if (surprise) {
      // Drive the clamp to the opposite extreme of the current prediction.
      this.sensoryClamp[i] = this.prediction[i] > 0.5 ? 0.0 : 1.3;
    } else {
      this.sensoryClamp[i] = Math.max(0, value);
    }
  }

  /** Bias a region's prior expectation (top-down) without an observation. */
  setExpectation(regionId: BrainRegionId, value: number): void {
    const i = REGION_INDEX[regionId];
    if (i === undefined) return;
    this.representation[i] = Math.max(0, Math.min(1.5, value));
  }

  getPredictionError(regionIndex: number): number {
    return this.error[regionIndex] ?? 0;
  }

  getPrediction(regionIndex: number): number {
    return this.prediction[regionIndex] ?? 0;
  }

  getPrecision(regionIndex: number): number {
    return this.precision[regionIndex] ?? 1;
  }

  getFreeEnergy(): number {
    return this.freeEnergy;
  }
}
