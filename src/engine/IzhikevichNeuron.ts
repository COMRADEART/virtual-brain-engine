// Izhikevich Spiking Neuron Model with Neuromodulation
// =====================================================
// 
// Core Model:
//   dv/dt = 0.04v² + 5v + 140 - u + I + synaptic_input
//   du/dt = a(bv - u)
//   if v ≥ 30 mV → spike, then v = c, u = u + d
// 
// Neuron Types (via parameter ranges):
//   - Regular Spiking (RS): Standard excitatory cortical neurons
//   - Intrinsically Bursting (IB): Bursting excitatory neurons (e.g., layer 5 pyramidal)
//   - Fast Spiking (FS): Inhibitory interneurons (e.g., PV+ basket cells)
//   - Chattering (CH): High-frequency bursting excitatory neurons
// 
// Neuromodulation:
//   - Dopamine (D1/D2): Modulates excitability and plasticity
//   - Acetylcholine (mAChR/nAChR): Alters firing patterns and synaptic efficacy
//   - Serotonin/Norepinephrine: Broad regulatory effects
// 
// Optimizations:
//   - Float32Arrays for performance-critical state variables
//   - Seeded RNG for deterministic initialization
//   - Conductance-based synapses with decay
//   - Batch update interface for GPU/WebGL compatibility

import { BrainRegionId } from "./types";

/**
 * Neuroscience-validated parameter ranges for Izhikevich neuron types.
 * All ranges based on original Izhikevich (2003) and cortical neuron studies.
 */
export const NEURON_PARAM_RANGES = {
  // Excitatory regular spiking (RS) - 80% of cortex
  excitatory: {
    a: { min: 0.02, max: 0.02 }, // Recovery time constant
    b: { min: 0.2,  max: 0.25 }, // Sensitivity of recovery variable
    c: { min: -65,  max: -63 },  // Reset potential after spike
    d: { min: 6,    max: 8 },    // Reset increment for recovery variable
  },
  // Inhibitory fast spiking (FS) - 20% of cortex
  inhibitory: {
    a: { min: 0.08,  max: 0.1 },  // Fast recovery → high-frequency spiking
    b: { min: 0.2,  max: 0.25 },
    c: { min: -65,  max: -65 },
    d: { min: 2,    max: 4 },
  },
  // Bursting neurons (intrinsically bursting, chattering)
  bursting: {
    a: { min: 0.01,  max: 0.03 },
    b: { min: 0.2,  max: 0.25 },
    c: { min: -55,  max: -50 },
    d: { min: 4,    max: 6 },
  }
} as const;

/** Widened (non-literal) shape of an Izhikevich parameter range. */
type IzhParamRange = {
  a: { min: number; max: number };
  b: { min: number; max: number };
  c: { min: number; max: number };
  d: { min: number; max: number };
};

/**
 * Neuromodulator receptor types and their qualitative effects.
 * Used for parameter modulation and plasticity rules.
 */
export type NeuromodulatorReceptor =
  | "DA_D1"   // Dopamine D1 receptor: typically excitatory
  | "DA_D2"   // Dopamine D2 receptor: typically inhibitory
  | "ACh_m1"  // Muscarinic AChR: slow metabotropic effects
  | "ACh_n"   // Nicotinic AChR: fast ionotropic effects
  | "5HT_2A"  // Serotonin: broad modulation
  | "NE_beta"; // Norepinephrine: arousal/attention

/**
 * Neuron classification with neuroscience annotations.
 * Used for visualization and region-specific behavior.
 */
export type NeuronClass =
  | "excitatory_rs"   // Regular spiking (e.g., cortical pyramidal cells)
  | "excitatory_ib"   // Intrinsically bursting (e.g., layer 5 pyramidal)
  | "inhibitory_fs"   // Fast spiking (e.g., PV+ basket cells)
  | "inhibitory_lts"  // Low-threshold spiking (e.g., SOM+ cells)
  | "excitatory_ch";  // Chattering (high-frequency burst)

/**
 * Synaptic conductance model parameters.
 * Represents AMPA (fast excitation), NMDA (slow excitation),
 * GABA_A (fast inhibition), and GABA_B (slow inhibition).
 */
export interface SynapticConductance {
  /** Fast excitatory conductance (AMPA-like) */
  g_ampa: number;
  /** Slow excitatory conductance (NMDA-like) */
  g_nmda: number;
  /** Fast inhibitory conductance (GABA_A-like) */
  g_gaba_a: number;
  /** Slow inhibitory conductance (GABA_B-like) */
  g_gaba_b: number;
  /** Decay time constants for each conductance (ms) */
  tau_ampa: number;
  tau_nmda: number;
  tau_gaba_a: number;
  tau_gaba_b: number;
}

/**
 * Izhikevich neuron state with neuromodulation.
 * All values in physiological units (mV, pA, ms).
 */
export interface IzhikevichNeuronState {
  /** Membrane potential (mV) */
  v: number;
  /** Recovery variable (dimensionless) */
  u: number;
  /** Total input current (pA) */
  I: number;
  /** Synaptic conductances */
  g: SynapticConductance;
  /** Neuromodulator sensitivities (baseline levels) */
  mod_sensitivity: Record<NeuromodulatorReceptor, number>;
  /** Current neuromodulator levels (dynamic) */
  mod_current: Record<NeuromodulatorReceptor, number>;
}

/**
 * Batch-optimized Izhikevich neuron implementation.
 * Designed for integration with the BrainSimulation interface.
 */
export class IzhikevichNeuronEngine {
  // Core parameters (4 per neuron)
  private readonly a: Float32Array;
  private readonly b: Float32Array;
  private readonly c: Float32Array;
  private readonly d: Float32Array;

  // State variables (updated every timestep)
  private readonly v: Float32Array; // Membrane potential (mV)
  private readonly u: Float32Array; // Recovery variable
  private readonly I: Float32Array; // Total input current (pA)

  // Synaptic conductances (dynamic decay)
  private readonly g_ampa: Float32Array;
  private readonly g_nmda: Float32Array;
  private readonly g_gaba_a: Float32Array;
  private readonly g_gaba_b: Float32Array;

  // Neuromodulation
  private mod_baseline: Record<NeuromodulatorReceptor, Float32Array>;
  private mod_current: Record<NeuromodulatorReceptor, Float32Array>;
  private readonly regionModLevels: Record<BrainRegionId, Record<NeuromodulatorReceptor, number>>;

  // Spike detection
  private readonly lastSpikeTime: Float32Array; // ms
  private readonly spikeBuffer: Uint8Array;      // Circular buffer for visualization
  private spikeBufferPtr: number = 0;

  // Performance/integration
  private readonly neuronClass: NeuronClass[];
  private readonly regionAssignment: BrainRegionId[];
  private readonly rng: () => number;
  private dt: number = 1.0; // Integration timestep (ms) — adjustable via setTimestep

  // Indices of neurons that spiked during the most recent update() call. Exposed
  // via getLastStepSpikes() so an orchestrator can propagate them through its own
  // connectome without re-scanning the population.
  private lastSpikes: number[] = [];

  /**
   * Initialize a population of Izhikevich neurons.
   * 
   * @param count Total number of neurons
   * @param regionAssignments Array of BrainRegionId for each neuron
   * @param neuronClasses Array specifying neuron class for each neuron
   * @param seed RNG seed for deterministic initialization
   */
  constructor(
    count: number,
    regionAssignments: BrainRegionId[],
    neuronClasses: NeuronClass[],
    seed: number = 19
  ) {
    if (regionAssignments.length !== count || neuronClasses.length !== count) {
      throw new Error("Mismatch between neuron count and assignment arrays");
    }

    // Initialize Float32Arrays
    this.a = new Float32Array(count);
    this.b = new Float32Array(count);
    this.c = new Float32Array(count);
    this.d = new Float32Array(count);
    this.v = new Float32Array(count);
    this.u = new Float32Array(count);
    this.I = new Float32Array(count);
    this.g_ampa = new Float32Array(count);
    this.g_nmda = new Float32Array(count);
    this.g_gaba_a = new Float32Array(count);
    this.g_gaba_b = new Float32Array(count);
    this.lastSpikeTime = new Float32Array(count);
    this.spikeBuffer = new Uint8Array(count * 10); // 10ms buffer
    this.neuronClass = [...neuronClasses];
    this.regionAssignment = [...regionAssignments];
    this.rng = this.seededRNG(seed);

    // Initialize neuromodulator tracking
    this.mod_baseline = {
      DA_D1: new Float32Array(count),
      DA_D2: new Float32Array(count),
      ACh_m1: new Float32Array(count),
      ACh_n: new Float32Array(count),
      "5HT_2A": new Float32Array(count),
      NE_beta: new Float32Array(count),
    };
    this.mod_current = { ...this.mod_baseline };
    this.regionModLevels = this.initializeRegionModulation();

    // Initialize parameters based on neuron class
    this.initializeParameters();
    this.initializeState();
  }

  /**
   * Deterministic seeded RNG for reproducible simulations.
   */
  private seededRNG(seed: number): () => number {
    // Mulberry32 algorithm
    let state = seed;
    return () => {
      state |= 0;
      state = state + 0x6d2b79f5 | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Initialize region-specific neuromodulator baselines.
   * Based on known cortical/subcortical neuromodulator receptor densities.
   */
  private initializeRegionModulation(): Record<BrainRegionId, Record<NeuromodulatorReceptor, number>> {
    const regionDefaults: Record<BrainRegionId, Record<NeuromodulatorReceptor, number>> = {
      // Prefrontal cortex - rich in DA and ACh
      "prefrontal-l": { DA_D1: 0.8, DA_D2: 0.7, ACh_m1: 0.6, ACh_n: 0.3, "5HT_2A": 0.4, NE_beta: 0.5 },
      "prefrontal-r": { DA_D1: 0.8, DA_D2: 0.7, ACh_m1: 0.6, ACh_n: 0.3, "5HT_2A": 0.4, NE_beta: 0.5 },
      // Motor cortex - lower neuromodulator sensitivity
      "motor-l": { DA_D1: 0.3, DA_D2: 0.2, ACh_m1: 0.3, ACh_n: 0.2, "5HT_2A": 0.3, NE_beta: 0.4 },
      "motor-r": { DA_D1: 0.3, DA_D2: 0.2, ACh_m1: 0.3, ACh_n: 0.2, "5HT_2A": 0.3, NE_beta: 0.4 },
      // Hippocampus - strong cholinergic input
      "hippocampus-l": { DA_D1: 0.4, DA_D2: 0.3, ACh_m1: 0.9, ACh_n: 0.7, "5HT_2A": 0.3, NE_beta: 0.2 },
      "hippocampus-r": { DA_D1: 0.4, DA_D2: 0.3, ACh_m1: 0.9, ACh_n: 0.7, "5HT_2A": 0.3, NE_beta: 0.2 },
      // Amygdala - high DA and 5HT sensitivity
      "amygdala-l": { DA_D1: 0.9, DA_D2: 0.8, ACh_m1: 0.4, ACh_n: 0.2, "5HT_2A": 0.8, NE_beta: 0.3 },
      "amygdala-r": { DA_D1: 0.9, DA_D2: 0.8, ACh_m1: 0.4, ACh_n: 0.2, "5HT_2A": 0.8, NE_beta: 0.3 },
      // Default for other regions
      "frontal-l": { DA_D1: 0.5, DA_D2: 0.4, ACh_m1: 0.4, ACh_n: 0.3, "5HT_2A": 0.3, NE_beta: 0.4 },
      "frontal-r": { DA_D1: 0.5, DA_D2: 0.4, ACh_m1: 0.4, ACh_n: 0.3, "5HT_2A": 0.3, NE_beta: 0.4 },
      "somatosensory-l": { DA_D1: 0.4, DA_D2: 0.3, ACh_m1: 0.4, ACh_n: 0.3, "5HT_2A": 0.3, NE_beta: 0.3 },
      "somatosensory-r": { DA_D1: 0.4, DA_D2: 0.3, ACh_m1: 0.4, ACh_n: 0.3, "5HT_2A": 0.3, NE_beta: 0.3 },
      "parietal-l": { DA_D1: 0.3, DA_D2: 0.2, ACh_m1: 0.3, ACh_n: 0.2, "5HT_2A": 0.3, NE_beta: 0.3 },
      "parietal-r": { DA_D1: 0.3, DA_D2: 0.2, ACh_m1: 0.3, ACh_n: 0.2, "5HT_2A": 0.3, NE_beta: 0.3 },
      "temporal-l": { DA_D1: 0.5, DA_D2: 0.4, ACh_m1: 0.5, ACh_n: 0.3, "5HT_2A": 0.4, NE_beta: 0.3 },
      "temporal-r": { DA_D1: 0.5, DA_D2: 0.4, ACh_m1: 0.5, ACh_n: 0.3, "5HT_2A": 0.4, NE_beta: 0.3 },
      "auditory-l": { DA_D1: 0.4, DA_D2: 0.3, ACh_m1: 0.4, ACh_n: 0.3, "5HT_2A": 0.3, NE_beta: 0.4 },
      "auditory-r": { DA_D1: 0.4, DA_D2: 0.3, ACh_m1: 0.4, ACh_n: 0.3, "5HT_2A": 0.3, NE_beta: 0.4 },
      "occipital-l": { DA_D1: 0.2, DA_D2: 0.1, ACh_m1: 0.5, ACh_n: 0.3, "5HT_2A": 0.2, NE_beta: 0.2 },
      "occipital-r": { DA_D1: 0.2, DA_D2: 0.1, ACh_m1: 0.5, ACh_n: 0.3, "5HT_2A": 0.2, NE_beta: 0.2 },
      "thalamus-l": { DA_D1: 0.3, DA_D2: 0.2, ACh_m1: 0.7, ACh_n: 0.4, "5HT_2A": 0.3, NE_beta: 0.2 },
      "thalamus-r": { DA_D1: 0.3, DA_D2: 0.2, ACh_m1: 0.7, ACh_n: 0.4, "5HT_2A": 0.3, NE_beta: 0.2 },
      "basal-ganglia-l": { DA_D1: 0.9, DA_D2: 0.8, ACh_m1: 0.3, ACh_n: 0.2, "5HT_2A": 0.4, NE_beta: 0.2 },
      "basal-ganglia-r": { DA_D1: 0.9, DA_D2: 0.8, ACh_m1: 0.3, ACh_n: 0.2, "5HT_2A": 0.4, NE_beta: 0.2 },
      "cerebellum": { DA_D1: 0.1, DA_D2: 0.1, ACh_m1: 0.2, ACh_n: 0.1, "5HT_2A": 0.1, NE_beta: 0.3 },
      "brainstem": { DA_D1: 0.2, DA_D2: 0.1, ACh_m1: 0.3, ACh_n: 0.2, "5HT_2A": 0.5, NE_beta: 0.9 },
    };

    return regionDefaults;
  }

  /**
   * Initialize neuron parameters based on class.
   * Uses neuroscience-validated ranges for cortical neuron types.
   */
  private initializeParameters(): void {
    for (let i = 0; i < this.a.length; i++) {
      const neuronClass = this.neuronClass[i];
      const range = this.getParamRange(neuronClass);

      switch (neuronClass) {
        case "excitatory_rs":
          this.a[i] = range.a.min;
          this.b[i] = this.rng() * (range.b.max - range.b.min) + range.b.min;
          this.c[i] = range.c.min;
          this.d[i] = this.rng() * (range.d.max - range.d.min) + range.d.min;
          break;
        
        case "excitatory_ib":
          this.a[i] = this.rng() * (range.a.max - range.a.min) + range.a.min;
          this.b[i] = this.rng() * (range.b.max - range.b.min) + range.b.min;
          this.c[i] = this.rng() * (range.c.max - range.c.min) + range.c.min;
          this.d[i] = this.rng() * (range.d.max - range.d.min) + range.d.min;
          break;
        
        case "inhibitory_fs":
          this.a[i] = this.rng() * (range.a.max - range.a.min) + range.a.min;
          this.b[i] = range.b.min;
          this.c[i] = range.c.min;
          this.d[i] = this.rng() * (range.d.max - range.d.min) + range.d.min;
          break;
        
        case "inhibitory_lts":
          this.a[i] = 0.02;
          this.b[i] = 0.25;
          this.c[i] = -65;
          this.d[i] = 2;
          break;
          
        case "excitatory_ch":
          this.a[i] = 0.02;
          this.b[i] = 0.2;
          this.c[i] = -50;
          this.d[i] = 2;
          break;
      }

      // Initialize neuromodulator sensitivities based on region
      const region = this.regionAssignment[i];
      const modLevels = this.regionModLevels[region];
      for (const [receptor, baseline] of Object.entries(modLevels)) {
        this.mod_baseline[receptor as NeuromodulatorReceptor][i] = baseline;
        this.mod_current[receptor as NeuromodulatorReceptor][i] = baseline;
      }
    }
  }

  /**
   * Get parameter range based on neuron class. The return type is the widened,
   * structural shape (plain numbers) so the inhibitory/bursting branches — whose
   * `as const` literal types differ from the excitatory one — remain assignable.
   */
  private getParamRange(neuronClass: NeuronClass): IzhParamRange {
    switch (neuronClass) {
      case "excitatory_rs":
      case "excitatory_ib":
        return NEURON_PARAM_RANGES.excitatory;
      case "inhibitory_fs":
      case "inhibitory_lts":
        return NEURON_PARAM_RANGES.inhibitory;
      case "excitatory_ch":
        return NEURON_PARAM_RANGES.bursting;
      default:
        throw new Error(`Unknown neuron class: ${neuronClass}`);
    }
  }

  /**
   * Initialize neuron state variables to resting values.
   */
  private initializeState(): void {
    for (let i = 0; i < this.v.length; i++) {
      // Start near resting potential (-65 mV)
      this.v[i] = -65 + (this.rng() * 5 - 2.5);
      // Initialize recovery variable
      this.u[i] = this.b[i] * this.v[i];
      // Zero input current
      this.I[i] = 0;
      // Zero synaptic conductances
      this.g_ampa[i] = 0;
      this.g_nmda[i] = 0;
      this.g_gaba_a[i] = 0;
      this.g_gaba_b[i] = 0;
      this.lastSpikeTime[i] = -Infinity;
    }
    // Clear spike buffer
    this.spikeBuffer.fill(0);
    this.spikeBufferPtr = 0;
  }

  /**
   * Update global neuromodulator levels for the entire population.
   * 
   * @param mod Levels of each neuromodulator (0-1)
   */
  public setNeuromodulators(mod: Record<NeuromodulatorReceptor, number>): void {
    for (const receptor of Object.keys(this.mod_current) as NeuromodulatorReceptor[]) {
      const level = Math.max(0, Math.min(1, mod[receptor]));
      for (let i = 0; i < this.v.length; i++) {
        // Dynamic modulation = baseline + current level
        this.mod_current[receptor][i] = this.mod_baseline[receptor][i] * (1 + level * 2);
      }
    }
  }

  /**
   * Set the integration timestep (ms).
   * Adaptive timestep can be used for performance optimization.
   */
  public setTimestep(dt: number): void {
    if (dt <= 0 || dt > 10) {
      throw new Error("Timestep must be between 0 and 10 ms");
    }
    this.dt = dt;
  }

  /**
   * Apply synaptic input to a specific neuron.
   * 
   * @param neuronIndex Target neuron index
   * @param conductance Synaptic conductance object
   * @param weight Multiplicative weight (default 1.0)
   */
  public applySynapticInput(
    neuronIndex: number,
    conductance: Partial<SynapticConductance>,
    weight: number = 1.0
  ): void {
    if (neuronIndex < 0 || neuronIndex >= this.v.length) return;

    // Apply weight to conductance
    if (conductance.g_ampa !== undefined) {
      this.g_ampa[neuronIndex] += conductance.g_ampa * weight;
    }
    if (conductance.g_nmda !== undefined) {
      this.g_nmda[neuronIndex] += conductance.g_nmda * weight;
    }
    if (conductance.g_gaba_a !== undefined) {
      this.g_gaba_a[neuronIndex] += conductance.g_gaba_a * weight;
    }
    if (conductance.g_gaba_b !== undefined) {
      this.g_gaba_b[neuronIndex] += conductance.g_gaba_b * weight;
    }
  }

  /**
   * Apply external current injection to a neuron or group.
   * 
   * @param neuronIndices Array of neuron indices to stimulate (empty = all)
   * @param current Current amplitude (pA)
   */
  public applyCurrent(
    neuronIndices: number[] | null,
    current: number
  ): void {
    if (neuronIndices === null) {
      // Stimulate all neurons
      for (let i = 0; i < this.I.length; i++) {
        this.I[i] += current;
      }
    } else {
      // Stimulate specific neurons
      for (const idx of neuronIndices) {
        if (idx >= 0 && idx < this.I.length) {
          this.I[idx] += current;
        }
      }
    }
  }

  /**
   * Update all neurons for one timestep using Euler integration.
   * 
   * @param externalInput Optional external input currents (pA)
   */
  public update(externalInput: Float32Array | null = null): void {
    const spikes: number[] = [];

    // Decay synaptic conductances
    this.decaySynapses();

    for (let i = 0; i < this.v.length; i++) {
      // Add external input if provided
      const I_external = externalInput ? externalInput[i] : 0;
      
      // Voltage-dependent Mg²⁺ block of the NMDA receptor (Jahr & Stevens 1990,
      // [Mg²⁺]=1 mM). At rest (−65 mV) the channel is ~94% blocked; it only opens
      // as the cell depolarises. Without this gate NMDA behaves like a second,
      // slowly-decaying AMPA and dominates the synaptic current, driving the whole
      // network into permanent epileptic runaway (every neuron firing every step).
      const mgBlock = 1 / (1 + Math.exp(-0.062 * this.v[i]) * 0.2805); // 1/3.57

      // Total synaptic current (conductance-based)
      const I_syn =
        this.g_ampa[i] * (0 - this.v[i]) +              // AMPA: E_rev = 0 mV
        this.g_nmda[i] * mgBlock * (0 - this.v[i]) +    // NMDA: E_rev = 0 mV, Mg-gated
        this.g_gaba_a[i] * (-70 - this.v[i]) +         // GABA_A: E_rev = -70 mV
        this.g_gaba_b[i] * (-90 - this.v[i]);          // GABA_B: E_rev = -90 mV

      // Total input current
      const I_total = this.I[i] + I_external + I_syn;

      // Izhikevich model equations
      const dv = 0.04 * this.v[i] ** 2 + 5 * this.v[i] + 140 - this.u[i] + I_total;
      const du = this.a[i] * (this.b[i] * this.v[i] - this.u[i]);

      // Euler integration
      this.v[i] += dv * this.dt;
      this.u[i] += du * this.dt;

      // Numerical safety net. Explicit Euler on the stiff Izhikevich ODE can
      // diverge under a strong transient (a single bad neuron then poisons every
      // I_syn it projects to via g·(0−v), cascading). A positive blow-up is caught
      // by the v≥30 spike reset below, but a negative runaway (v→−4000+) never is,
      // so clamp anything non-finite or grossly sub-physiological back to reset.
      if (!Number.isFinite(this.v[i]) || this.v[i] < -100) {
        this.v[i] = this.c[i];
        this.u[i] = this.b[i] * this.c[i];
      }

      // Spike detection
      if (this.v[i] >= 30) {
        spikes.push(i);
        this.v[i] = this.c[i];
        this.u[i] += this.d[i];
        this.lastSpikeTime[i] = 0;
        
        // Record spike in visualization buffer
        this.spikeBuffer[this.spikeBufferPtr * this.v.length + i] = 1;
      } else {
        this.spikeBuffer[this.spikeBufferPtr * this.v.length + i] = 0;
      }
      
      // Reset input current after integration
      this.I[i] = 0;
      if (I_external) externalInput![i] = 0;
    }

    // Update spike buffer pointer
    this.spikeBufferPtr = (this.spikeBufferPtr + 1) % 10;
    
    // Update spike timers
    for (let i = 0; i < this.lastSpikeTime.length; i++) {
      this.lastSpikeTime[i] += this.dt;
    }

    // Publish this step's spikes for an orchestrator to propagate.
    this.lastSpikes = spikes;
  }

  /**
   * Indices of neurons that spiked during the most recent update(). The array is
   * replaced each step, so callers may hold the reference until the next update.
   */
  public getLastStepSpikes(): readonly number[] {
    return this.lastSpikes;
  }

  /**
   * Fill `out` in place with membrane potentials normalised to [0,1] (−80 mV → 0,
   * +30 mV → 1). Allocation-free alternative to getMembranePotentialsNormalized()
   * for per-frame visualisation.
   */
  public writeMembranePotentialsNormalized(out: Float32Array): void {
    const n = Math.min(out.length, this.v.length);
    for (let i = 0; i < n; i++) {
      const vn = (this.v[i] + 80) / 110;
      out[i] = vn < 0 ? 0 : vn > 1 ? 1 : vn;
    }
  }

  /**
   * Decay synaptic conductances exponentially.
   */
  private decaySynapses(): void {
    // Typical decay time constants (ms)
    const tau_ampa = 5.0;
    const tau_nmda = 150.0;
    const tau_gaba_a = 6.0;
    const tau_gaba_b = 150.0;
    
    // Decay rates
    const decay_ampa = Math.exp(-this.dt / tau_ampa);
    const decay_nmda = Math.exp(-this.dt / tau_nmda);
    const decay_gaba_a = Math.exp(-this.dt / tau_gaba_a);
    const decay_gaba_b = Math.exp(-this.dt / tau_gaba_b);
    
    for (let i = 0; i < this.v.length; i++) {
      this.g_ampa[i] *= decay_ampa;
      this.g_nmda[i] *= decay_nmda;
      this.g_gaba_a[i] *= decay_gaba_a;
      this.g_gaba_b[i] *= decay_gaba_b;
    }
  }

  /**
   * Get membrane potentials normalized to [0, 1] for visualization.
   * Maps physiological range (-80 mV to +30 mV) to [0, 1].
   */
  public getMembranePotentialsNormalized(): Float32Array {
    const normalized = new Float32Array(this.v.length);
    for (let i = 0; i < this.v.length; i++) {
      // Clip and normalize: -80 mV → 0, +30 mV → 1
      const v_norm = Math.min(1, Math.max(0, (this.v[i] + 80) / 110));
      normalized[i] = v_norm;
    }
    return normalized;
  }

  /**
   * Get the spike buffer for visualization.
   * Returns a 10ms circular buffer of spikes (binary).
   */
  public getSpikeBuffer(): Uint8Array {
    return this.spikeBuffer;
  }

  /**
   * Get recent spikes (neurons that spiked in last timestep).
   */
  public getRecentSpikes(): number[] {
    const spikes: number[] = [];
    for (let i = 0; i < this.v.length; i++) {
      if (this.spikeBuffer[this.spikeBufferPtr * this.v.length + i] === 1) {
        spikes.push(i);
      }
    }
    return spikes;
  }

  /**
   * Serialize current state for persistence.
   */
  public serialize(): Record<string, unknown> {
    return {
      a: Array.from(this.a),
      b: Array.from(this.b),
      c: Array.from(this.c),
      d: Array.from(this.d),
      v: Array.from(this.v),
      u: Array.from(this.u),
      I: Array.from(this.I),
      g_ampa: Array.from(this.g_ampa),
      g_nmda: Array.from(this.g_nmda),
      g_gaba_a: Array.from(this.g_gaba_a),
      g_gaba_b: Array.from(this.g_gaba_b),
      mod_baseline: Object.fromEntries(
        Object.entries(this.mod_baseline).map(([k, v]) => [k, Array.from(v)])
      ),
      mod_current: Object.fromEntries(
        Object.entries(this.mod_current).map(([k, v]) => [k, Array.from(v)])
      ),
      lastSpikeTime: Array.from(this.lastSpikeTime),
      neuronClass: this.neuronClass,
      regionAssignment: this.regionAssignment,
    };
  }

  /**
   * Deserialize saved state.
   */
  public static deserialize(data: Record<string, unknown>): IzhikevichNeuronEngine {
    const count = (data.v as number[]).length;
    const neuronClasses = data.neuronClass as NeuronClass[];
    const regionAssignments = data.regionAssignment as BrainRegionId[];
    
    const engine = new IzhikevichNeuronEngine(count, regionAssignments, neuronClasses);
    
    // Restore parameters
    engine.a.set(data.a as number[]);
    engine.b.set(data.b as number[]);
    engine.c.set(data.c as number[]);
    engine.d.set(data.d as number[]);
    
    // Restore state
    engine.v.set(data.v as number[]);
    engine.u.set(data.u as number[]);
    engine.I.set(data.I as number[]);
    engine.g_ampa.set(data.g_ampa as number[]);
    engine.g_nmda.set(data.g_nmda as number[]);
    engine.g_gaba_a.set(data.g_gaba_a as number[]);
    engine.g_gaba_b.set(data.g_gaba_b as number[]);
    engine.lastSpikeTime.set(data.lastSpikeTime as number[]);
    
    // Restore modulation
    for (const [receptor, values] of Object.entries(data.mod_baseline as Record<string, number[]>)) {
      engine.mod_baseline[receptor as NeuromodulatorReceptor].set(values);
    }
    for (const [receptor, values] of Object.entries(data.mod_current as Record<string, number[]>)) {
      engine.mod_current[receptor as NeuromodulatorReceptor].set(values);
    }
    
    return engine;
  }
}