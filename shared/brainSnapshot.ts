// BrainSnapshot — durable, cross-session learned state for the cognitive brain
// ============================================================================
//
// "Effective IQ grows over time" is only meaningful if the *learning* survives a
// page reload. This file is the persistence contract: a single serialisable
// payload that captures everything the brain has LEARNED (as opposed to its
// transient millisecond-scale dynamics, which re-equilibrate within a few frames
// and are deliberately NOT stored).
//
// What is durable (saved):
//   • connectomeWeights — the STDP-learned synaptic weights. This is "the whole
//     point": topology is regenerated deterministically from density+graphSeed,
//     so only the plastic weight vector needs to travel.
//   • valueFunction     — the reinforcement learner's V(state) table.
//   • hyperparams       — the meta-learner's current best genome.
//   • iqHistory         — the composite-IQ trajectory (so the growth curve is
//     continuous across sessions).
//   • ewcImportance     — per-synapse importance, so continual-learning protection
//     persists.
//   • neuromod          — tonic neuromodulator levels (cheap, gives continuity).
//
// What is intentionally NOT stored: per-neuron v/u membrane state, conductances,
// oscillation phases, pulse pool — all transient, all re-settle in milliseconds.
//
// Zero runtime dependencies (pure types + a plain interface) so both the Vite
// client and any Node tooling can import it without a build step, per the
// `shared/` convention.

/**
 * The meta-learner's tunable hyperparameter vector. Every field is bounded (see
 * GENOME_BOUNDS in the cognition layer) and chosen to be SAFE to mutate online —
 * deliberately excluding the just-stabilised E:I synaptic gains, which the
 * homeostatic controller already regulates and which would risk re-seizure.
 */
export interface CognitiveGenome {
  /** RL action/exploration noise temperature. Higher → more exploratory. */
  explorationTemp: number;
  /** Weight on intrinsic (curiosity) reward relative to extrinsic reward. */
  curiosityWeight: number;
  /** Uncertainty above which System 2 (deliberation) is engaged. */
  arbitrationThreshold: number;
  /** Per-frame time budget (ms) granted to System 2 when engaged. */
  system2BudgetMs: number;
  /** Global multiplier on the STDP learning rate (bounded). */
  plasticityScale: number;
  /** Tonic dopamine baseline the neuromodulator system relaxes toward. */
  dopamineBaseline: number;
  /** Tonic acetylcholine baseline (attention/encoding bias). */
  acetylcholineBaseline: number;
}

/** The four classical neuromodulator tonic levels. */
export interface NeuromodSnapshot {
  dopamine: number;
  acetylcholine: number;
  serotonin: number;
  norepinephrine: number;
}

/**
 * One complete, restorable snapshot of the brain's learned state.
 *
 * Restore is GATED on an exact topology match: a snapshot is only applied when
 * its `density` and `graphSeed` equal the live graph's, because the weight vector
 * is indexed by a synapse ordering that only the same seed reproduces.
 */
export interface BrainSnapshot {
  /** Bump when the shape changes; restore rejects mismatched versions. */
  version: 2;
  /** Neuron density the graph was built at (topology gate). */
  density: number;
  /** Deterministic graph seed (topology gate). */
  graphSeed: number;
  /** ISO timestamp of capture. */
  savedAt: string;

  /** STDP-learned synaptic weights, parallel to the connectome CSR ordering. */
  connectomeWeights: Float32Array;
  /** Tonic neuromodulator levels. */
  neuromod: NeuromodSnapshot;
  /** Reinforcement value function V(state) as [stateKey, value] pairs. */
  valueFunction: Array<[string, number]>;
  /** Meta-learner's current best hyperparameters. */
  hyperparams: CognitiveGenome;
  /** Composite-IQ history (oldest → newest), bounded length. */
  iqHistory: number[];
  /** Per-synapse EWC importance (Fisher proxy), parallel to connectomeWeights. */
  ewcImportance: Float32Array;
}
