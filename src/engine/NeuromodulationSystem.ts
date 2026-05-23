// NeuromodulationSystem — diffuse chemical control of the network
// ===============================================================
//
// Neuromodulators are slow, broadcast signals released from small brainstem /
// basal-forebrain nuclei that re-tune large swathes of cortex at once. Unlike
// fast synaptic transmission (one cell → one cell, milliseconds), they set the
// *regime* the network operates in over seconds. We model the four classical
// systems:
//
//   • DOPAMINE (DA)        — reward / incentive salience. Phasic bursts on
//     better-than-expected outcomes; gates plasticity (the "three-factor" rule:
//     a synapse only consolidates if Hebbian coincidence AND dopamine coincide).
//     Source: VTA/SNc → strongest effect on PFC and basal ganglia.
//   • ACETYLCHOLINE (ACh)  — attention / encoding. High ACh sharpens
//     stimulus-driven (bottom-up) responses, suppresses recurrent noise, and
//     biases the hippocampus toward ENCODING over retrieval. Source: basal
//     forebrain → strongest on sensory cortex + hippocampus.
//   • SEROTONIN (5-HT)     — mood / behavioural regulation; here a gentle global
//     damping + patience signal. Source: raphe nuclei.
//   • NOREPINEPHRINE (NE)  — arousal / network gain. Scales the gain of the whole
//     system (the "neural gain" hypothesis): high NE → crisp, high-contrast
//     responses; low NE → drowsy, low-gain. Source: locus coeruleus.
//
// Each modulator has a TONIC baseline it decays back toward and accepts PHASIC
// pulses (sharp transient releases). The system exposes two scalars the rest of
// the engine consumes every step: a per-region EXCITABILITY multiplier (how much
// external drive a region feels) and a global PLASTICITY gain (how strongly STDP
// writes).

import type { BrainEventBus, Neuromodulator } from "./BrainEventBus";
import { REGION_BY_ID } from "./brainRegions";
import type { BrainRegionId } from "./types";

const MODULATORS: Neuromodulator[] = ["dopamine", "acetylcholine", "serotonin", "norepinephrine"];

/** Tonic resting levels (normalised 0–1) the system relaxes toward. */
const BASELINES: Record<Neuromodulator, number> = {
  dopamine: 0.3,
  acetylcholine: 0.4,
  serotonin: 0.25,
  norepinephrine: 0.2,
};

/** Decay time constants toward baseline (seconds). Phasic DA/NE are fast; the
 *  tonic ACh/5-HT context drifts more slowly. */
const TAU_SECONDS: Record<Neuromodulator, number> = {
  dopamine: 1.2,
  acetylcholine: 4.0,
  serotonin: 8.0,
  norepinephrine: 1.5,
};

export class NeuromodulationSystem {
  private readonly levels: Record<Neuromodulator, number> = { ...BASELINES };
  private readonly baselines: Record<Neuromodulator, number> = { ...BASELINES };

  constructor(private readonly bus?: BrainEventBus) {}

  /** Relax every modulator toward its tonic baseline (exponential). */
  update(dtSeconds: number): void {
    for (const m of MODULATORS) {
      const tau = TAU_SECONDS[m];
      const alpha = 1 - Math.exp(-dtSeconds / tau);
      this.levels[m] += (this.baselines[m] - this.levels[m]) * alpha;
    }
  }

  /** Set the TONIC target a modulator decays toward (used by cognitive states). */
  setBaseline(m: Neuromodulator, value: number): void {
    this.baselines[m] = clamp01(value);
  }

  /** Force the CURRENT level (used for direct UI control / immediate effect). */
  setLevel(m: Neuromodulator, value: number): void {
    this.levels[m] = clamp01(value);
  }

  /** Inject a phasic burst on top of the current level; it then decays away. */
  pulse(m: Neuromodulator, amount: number, reason = "phasic"): void {
    this.levels[m] = clamp01(this.levels[m] + amount);
    this.bus?.emit("neuromod:release", { modulator: m, amount, reason });
  }

  get(m: Neuromodulator): number {
    return this.levels[m];
  }

  get dopamine(): number {
    return this.levels.dopamine;
  }
  get acetylcholine(): number {
    return this.levels.acetylcholine;
  }
  get serotonin(): number {
    return this.levels.serotonin;
  }
  get norepinephrine(): number {
    return this.levels.norepinephrine;
  }

  snapshot(): Record<Neuromodulator, number> {
    return { ...this.levels };
  }

  /**
   * Per-region excitability multiplier on external drive. Combines:
   *   • NE  — uniform network gain (arousal), applies everywhere.
   *   • DA  — boosts frontal cortex + basal ganglia (motivation/action gating).
   *   • ACh — boosts sensory cortex + hippocampus (attention/encoding).
   *   • 5-HT — gentle uniform damping (regulation).
   * Returns a value clamped to a sane band so the network can't be driven to
   * silence or runaway by the modulators alone.
   */
  getExcitability(regionId: BrainRegionId): number {
    const def = REGION_BY_ID[regionId];
    const lobe = def?.lobe;
    const da = this.levels.dopamine - this.baselines.dopamine;
    const ach = this.levels.acetylcholine - this.baselines.acetylcholine;
    const ne = this.levels.norepinephrine - this.baselines.norepinephrine;
    const ht = this.levels.serotonin - this.baselines.serotonin;

    let gain = 1.0;
    gain += ne * 0.8; // global arousal gain

    const isFrontal = regionId.startsWith("prefrontal") || regionId.startsWith("frontal");
    const isBasalGanglia = regionId.startsWith("basal-ganglia");
    if (isFrontal || isBasalGanglia) gain += da * 0.9;
    else gain += da * 0.2;

    const isSensory =
      lobe === "occipital" ||
      lobe === "temporal" ||
      regionId.startsWith("auditory") ||
      regionId.startsWith("somatosensory");
    const isHippocampus = regionId.startsWith("hippocampus");
    if (isSensory || isHippocampus) gain += ach * 0.7;
    else gain += ach * 0.15;

    gain -= ht * 0.25; // serotonergic damping

    return clamp(gain, 0.5, 2.5);
  }

  /**
   * Global plasticity gain for STDP. Dopamine is the dominant "write-enable"
   * (reward-gated learning); acetylcholine adds an encoding bias. At baseline
   * this is ≈1; a dopamine burst can roughly double the learning rate.
   */
  getPlasticityGain(): number {
    return clamp(1 + this.levels.dopamine * 1.2 + this.levels.acetylcholine * 0.4, 0.2, 3.0);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function clamp01(v: number): number {
  return clamp(v, 0, 1);
}
