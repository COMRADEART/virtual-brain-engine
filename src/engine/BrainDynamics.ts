// BrainDynamics — homeostasis & self-organised criticality
// =========================================================
//
// A spiking network left to itself does one of two ugly things: it falls silent
// (drive too weak) or it seizes (drive too strong, runaway excitation). Real
// brains avoid both by sitting near a CRITICAL POINT — the boundary between order
// and chaos — where activity is neither damped nor explosive. Two homeostatic
// mechanisms keep it there, and we model both at the population level:
//
//   1. FIRING-RATE HOMEOSTASIS. Neurons defend a target average firing rate over
//      slow timescales (synaptic scaling, intrinsic plasticity). We track the
//      population mean rate and output a single GLOBAL GAIN that the engine
//      multiplies into external drive: too quiet → gain up; too busy → gain down.
//      This is a slow integral controller, so it stabilises rather than
//      oscillates.
//
//   2. CRITICALITY. At criticality, one spike triggers on average exactly one
//      downstream spike — the BRANCHING RATIO σ ≈ 1. σ < 1 is subcritical
//      (activity dies out); σ > 1 is supercritical (activity blows up). We
//      estimate σ from successive spike counts (descendants / ancestors) and
//      report it as telemetry; the rate controller is what nudges the system
//      back toward σ ≈ 1.
//
// Pure logic, no rendering. The engine calls `update(spikeCount, dt)` once per
// step and reads `getHomeostaticGain()` when computing drive.

import type { BrainEventBus } from "./BrainEventBus";

export interface DynamicsOptions {
  /** Target fraction of the population spiking per step (e.g. 0.02 = 2%). */
  targetRate?: number;
  /** Integral-controller speed (per second). Small = slow, stable. */
  controlRate?: number;
  /** Clamp band for the global gain so the controller can't run away. */
  minGain?: number;
  maxGain?: number;
}

export class BrainDynamics {
  private readonly neuronCount: number;
  private readonly targetRate: number;
  private readonly controlRate: number;
  private readonly minGain: number;
  private readonly maxGain: number;

  private gain = 1.0; // homeostatic global drive multiplier
  private meanRate = 0; // EMA of fraction-of-population spiking per step
  private branchingRatio = 1.0; // σ estimate
  private prevSpikeCount = 0;
  private emitAccumulator = 0;

  constructor(neuronCount: number, options: DynamicsOptions = {}, private readonly bus?: BrainEventBus) {
    this.neuronCount = Math.max(1, neuronCount);
    this.targetRate = options.targetRate ?? 0.02;
    this.controlRate = options.controlRate ?? 0.6;
    this.minGain = options.minGain ?? 0.4;
    this.maxGain = options.maxGain ?? 3.0;
  }

  /**
   * @param spikeCount number of neurons that spiked this step
   * @param dtSeconds  frame delta
   */
  update(spikeCount: number, dtSeconds: number): void {
    const instRate = spikeCount / this.neuronCount;

    // EMA of mean firing rate (slow, ~0.5 s window).
    const alpha = Math.min(1, dtSeconds / 0.5);
    this.meanRate += (instRate - this.meanRate) * alpha;

    // Branching ratio σ ≈ spikes(t) / spikes(t-1). Only meaningful when the
    // ancestor generation actually fired; otherwise hold the previous estimate.
    if (this.prevSpikeCount > 0) {
      const sigma = spikeCount / this.prevSpikeCount;
      this.branchingRatio += (sigma - this.branchingRatio) * Math.min(1, dtSeconds * 4);
    }
    this.prevSpikeCount = spikeCount;

    // Integral controller: drive the mean rate toward target. Error > 0 (too
    // quiet) raises gain; error < 0 (too busy) lowers it.
    const error = this.targetRate - this.meanRate;
    this.gain += error * this.controlRate * dtSeconds * 40; // 40 scales rate-units → gain-units
    if (this.gain < this.minGain) this.gain = this.minGain;
    if (this.gain > this.maxGain) this.gain = this.maxGain;

    // Emit telemetry a few times per second (not every frame).
    this.emitAccumulator += dtSeconds;
    if (this.emitAccumulator >= 0.25) {
      this.emitAccumulator = 0;
      this.bus?.emit("dynamics:criticality", {
        branchingRatio: this.branchingRatio,
        meanRate: this.meanRate,
      });
    }
  }

  /** Global multiplier the engine applies to all external drive. */
  getHomeostaticGain(): number {
    return this.gain;
  }

  /** σ ≈ 1 means the network is poised at criticality. */
  getBranchingRatio(): number {
    return this.branchingRatio;
  }

  getMeanRate(): number {
    return this.meanRate;
  }

  /** How close to criticality, as a 0–1 score (1 = exactly σ=1). */
  getCriticalityScore(): number {
    return Math.max(0, 1 - Math.abs(this.branchingRatio - 1));
  }
}
