// BrainOscillations — multi-band rhythms with cross-frequency coupling
// ====================================================================
//
// Cortical activity is organised by nested rhythms. Slow rhythms set the timing
// windows; fast rhythms do the local computation inside them. We model the four
// canonical bands and the single most important coupling between them:
//
//   • THETA (4–8 Hz)   — hippocampal/limbic "clock"; organises memory encoding
//     and sequence replay. Each theta cycle is a processing window.
//   • ALPHA (8–12 Hz)  — thalamo-cortical idling/inhibition; high in resting
//     visual cortex, suppressed by engagement ("alpha desynchronisation").
//   • BETA (13–30 Hz)  — sensorimotor "status quo"; sustained in motor cortex,
//     drops before movement.
//   • GAMMA (30–80 Hz) — local feature binding / active computation; the fast
//     carrier of bottom-up information.
//
// CROSS-FREQUENCY COUPLING (the headline feature): theta–gamma PHASE-AMPLITUDE
// COUPLING. Gamma power is not constant — it waxes and wanes locked to the phase
// of theta, so each theta cycle packs a burst of gamma. This is how the brain is
// thought to multiplex several items (one per gamma cycle) within a theta window
// (the basis of the theta–gamma working-memory model). We implement it directly:
// the gamma amplitude is gated by the theta phase.
//
// The engine consumes `getRegionDrive(regionId)` each step: a region-specific
// oscillatory current built from whichever bands dominate that area, already
// including the PAC modulation. Cognitive states retune the bands via
// `setBandGain` (e.g. Focus boosts gamma, Recall boosts theta).

import type { OscillationBand } from "./BrainEventBus";
import { REGION_BY_ID } from "./brainRegions";
import type { BrainRegionId } from "./types";

const BANDS: OscillationBand[] = ["theta", "alpha", "beta", "gamma"];

/** Centre frequencies (Hz) for each band. */
const FREQ: Record<OscillationBand, number> = {
  theta: 6,
  alpha: 10,
  beta: 20,
  gamma: 45,
};

/** Intrinsic amplitudes (relative power) for each band. */
const BASE_AMP: Record<OscillationBand, number> = {
  theta: 1.0,
  alpha: 0.8,
  beta: 0.6,
  gamma: 0.7,
};

export interface OscillationSnapshot {
  thetaPhase: number;
  alphaPhase: number;
  betaPhase: number;
  gammaPhase: number;
  bandPower: Record<OscillationBand, number>;
  /** Theta–gamma coupling strength in [0,1] (modulation index proxy). */
  pac: number;
}

export class BrainOscillations {
  // Phase accumulators (radians, wrapped to [0, 2π)).
  private phase: Record<OscillationBand, number> = { theta: 0, alpha: 0, beta: 0, gamma: 0 };
  // Per-band gain set by cognitive state (Focus → high gamma, Recall → high theta).
  private gain: Record<OscillationBand, number> = { theta: 1, alpha: 1, beta: 1, gamma: 1 };
  // Instantaneous gamma amplitude after theta gating (for telemetry).
  private gammaAmplitude = BASE_AMP.gamma;

  /** Advance every oscillator by `dtSeconds`. */
  update(dtSeconds: number): void {
    for (const band of BANDS) {
      this.phase[band] = (this.phase[band] + 2 * Math.PI * FREQ[band] * dtSeconds) % (2 * Math.PI);
    }
    // Theta-gated gamma envelope: gamma amplitude peaks at the theta crest.
    // env ∈ [0.25, 1]; the floor keeps a little gamma alive in every cycle.
    const env = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(this.phase.theta));
    this.gammaAmplitude = BASE_AMP.gamma * this.gain.gamma * env;
  }

  /** Retune a band's contribution (cognitive-state control). */
  setBandGain(band: OscillationBand, gain: number): void {
    this.gain[band] = Math.max(0, gain);
  }

  /** Reset every band gain to 1 (neutral / default-mode). */
  resetGains(): void {
    this.gain = { theta: 1, alpha: 1, beta: 1, gamma: 1 };
  }

  get thetaPhase(): number {
    return this.phase.theta;
  }
  get alphaPhase(): number {
    return this.phase.alpha;
  }
  get betaPhase(): number {
    return this.phase.beta;
  }
  get gammaPhase(): number {
    return this.phase.gamma;
  }

  /** Theta–gamma coupling strength: how strongly the current gamma envelope is
   *  driven by theta phase. Reported for the UI's "CFC" readout. */
  get pac(): number {
    const env =
      (this.gammaAmplitude / (BASE_AMP.gamma * Math.max(0.001, this.gain.gamma)) - 0.25) / 0.75;
    return Math.max(0, Math.min(1, env));
  }

  /**
   * Region-specific oscillatory drive for this instant. Each region is weighted
   * toward the bands that physiologically dominate it, then we sum the signed
   * band oscillations (so the drive rhythmically pushes the region's neurons
   * above and below their resting drive). The gamma term already carries the
   * theta-gated amplitude, giving real theta–gamma nesting in cortex.
   */
  getRegionDrive(regionId: BrainRegionId): number {
    const w = this.regionBandWeights(regionId);
    const theta = BASE_AMP.theta * this.gain.theta * Math.sin(this.phase.theta);
    const alpha = BASE_AMP.alpha * this.gain.alpha * Math.sin(this.phase.alpha);
    const beta = BASE_AMP.beta * this.gain.beta * Math.sin(this.phase.beta);
    const gamma = this.gammaAmplitude * Math.sin(this.phase.gamma);
    return w.theta * theta + w.alpha * alpha + w.beta * beta + w.gamma * gamma;
  }

  /** Per-region band mixture (which rhythms dominate which areas). */
  private regionBandWeights(regionId: BrainRegionId): Record<OscillationBand, number> {
    const lobe = REGION_BY_ID[regionId]?.lobe;
    if (regionId.startsWith("hippocampus")) {
      return { theta: 1.0, alpha: 0.1, beta: 0.1, gamma: 0.5 };
    }
    if (regionId.startsWith("thalamus")) {
      return { theta: 0.4, alpha: 0.9, beta: 0.2, gamma: 0.2 };
    }
    if (regionId.startsWith("prefrontal") || regionId.startsWith("frontal")) {
      return { theta: 0.5, alpha: 0.2, beta: 0.4, gamma: 0.9 };
    }
    if (regionId.startsWith("motor")) {
      return { theta: 0.1, alpha: 0.2, beta: 0.9, gamma: 0.4 };
    }
    if (lobe === "occipital") {
      return { theta: 0.1, alpha: 0.9, beta: 0.2, gamma: 0.8 };
    }
    if (lobe === "temporal" || regionId.startsWith("auditory")) {
      return { theta: 0.5, alpha: 0.3, beta: 0.3, gamma: 0.7 };
    }
    // Generic association cortex / subcortex: balanced.
    return { theta: 0.4, alpha: 0.4, beta: 0.4, gamma: 0.5 };
  }

  snapshot(): OscillationSnapshot {
    return {
      thetaPhase: this.phase.theta,
      alphaPhase: this.phase.alpha,
      betaPhase: this.phase.beta,
      gammaPhase: this.phase.gamma,
      bandPower: {
        theta: BASE_AMP.theta * this.gain.theta,
        alpha: BASE_AMP.alpha * this.gain.alpha,
        beta: BASE_AMP.beta * this.gain.beta,
        gamma: this.gammaAmplitude,
      },
      pac: this.pac,
    };
  }
}
