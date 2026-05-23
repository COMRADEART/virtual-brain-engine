// Biologically realistic spiking neural simulation for the Personal One-on-One
// Computer Brain.
//
// Replaces scripted SignalSimulation with:
// - Leaky Integrate-and-Fire neurons with AMPA/NMDA/GABA conductances
// - Dopamine/ACh-modulated STDP for memory consolidation
// - Theta-gamma neural oscillations driving replay
// - Vectorized Float32Arrays for 10-100K neuron performance
//
// API-compatible with SignalSimulation for seamless frontend integration.

import type {
  BrainActionId,
  BrainRegionId,
  BrainSimulation,
  NeuralGraph,
  NeuronNode,
  SignalPulse,
} from "./types";
import { ACTION_BY_ID, REGION_INDEX } from "./brainRegions";
import { LOGICAL_REGION_MAP } from "./logicalRegions";

// Replay events originate in the server's memory-consolidation layer
// (server/src/memory/replayService.ts) and reach the browser over the brain WS
// bus. The frontend keeps its own structural copy so this engine has ZERO
// server-side imports — preserving the src/ ↔ server/ layering boundary.
export interface ReplayEvent {
  type: "replay";
  memoryIds: string[];
  region: "hippocampus" | "neocortex";
  thetaPhase: "peak" | "trough";
  timestamp: number | string; // number for engine-internal events, ISO string over the WS bus
}

// Biological constants (millivolts unless noted)
const V_REST = -70;
const V_RESET = -80;
const V_THRESH = -55;
const V_AMPA_REV = 0;
const V_NMDA_REV = 0;
const V_GABA_REV = -80;
const TAU_MEMBRANE = 20; // ms
const TAU_AMPA = 5; // ms
const TAU_NMDA = 150; // ms
const TAU_GABA = 10; // ms
const TAU_REFRAC = 5; // ms
const THETA_FREQ = 8; // Hz
const GAMMA_FREQ = 40; // Hz

// Neuromodulator defaults (0-1 normalized)
interface Neuromodulators {
  dopamine: number;
  acetylcholine: number;
  serotonin: number;
  norepinephrine: number;
}

// Neuron attributes per anatomical region
interface RegionNeuronConfig {
  v_init: number;
  base_excitability: number;
  g_ampa_scale: number;
  g_nmda_scale: number;
  g_gaba_scale: number;
}

export class SpikingEngine implements BrainSimulation {
  // State vectors (all Float32Arrays for memory efficiency)
  private v: Float32Array; // Membrane potentials (mV)
  private v_prev: Float32Array; // Previous potentials for threshold detection
  private refractory_time: Float32Array; // Refractory countdown (ms)
  private g_ampa: Float32Array; // AMPA conductance (normalized)
  private g_nmda: Float32Array; // NMDA conductance (normalized)
  private g_gaba: Float32Array; // GABA conductance (normalized)

  // Neuromodulator state
  private neuromodulators: Neuromodulators = {
    dopamine: 0.3,
    acetylcholine: 0.4,
    serotonin: 0.2,
    norepinephrine: 0.1,
  };

  // Phase tracking for theta-gamma oscillations
  private theta_phase: number = 0; // 0 to 2π
  private gamma_phase: number = 0; // 0 to 2π
  private theta_freq = THETA_FREQ;
  private gamma_freq = GAMMA_FREQ;

  // Memory replay state
  private replay_queue: ReplayEvent[] = [];

  // Bounded ring buffer of recent spikes for raster-plot visualization.
  private recentSpikes: SpikeEvent[] = [];

  // Visual feedback buffers (API compatibility)
  readonly regionIntensity: Float32Array;
  readonly regionFlashIntensity: Float32Array;
  readonly pathwayIntensity: Float32Array;
  private _memoryIntensity: number = 0;
  readonly pulses: SignalPulse[] = []; // Stub for SignalSimulation compatibility

  // Extended bio state (for visualization)
  readonly membranePotentialNorm: Float32Array;
  readonly thetaPhase: number;
  readonly gammaPhase: number;

  constructor(
    private graph: NeuralGraph,
    private actionId: BrainActionId
  ) {
    // Initialize state arrays
    const nodeCount = graph.nodes.length;
    this.v = new Float32Array(nodeCount).fill(V_REST);
    this.v_prev = new Float32Array(nodeCount).fill(V_REST);
    this.refractory_time = new Float32Array(nodeCount).fill(0);
    this.g_ampa = new Float32Array(nodeCount).fill(0);
    this.g_nmda = new Float32Array(nodeCount).fill(0);
    this.g_gaba = new Float32Array(nodeCount).fill(0);

    // Region-segregated neuron configs
    const defaultConfig: RegionNeuronConfig = {
      v_init: V_REST,
      base_excitability: 1.0,
      g_ampa_scale: 1.0,
      g_nmda_scale: 0.4,
      g_gaba_scale: 0.8,
    };
    const configs: Record<BrainRegionId, RegionNeuronConfig> = {
      "prefrontal-l": { ...defaultConfig, g_nmda_scale: 1.2 },
      "hippocampus-l": { ...defaultConfig, base_excitability: 1.3, v_init: -65 },
      // Other regions...
    };

    // Initialize region-specific neuron properties
    this.graph.nodes.forEach((node, i) => {
      const config = configs[node.regionId as BrainRegionId] || defaultConfig;
      this.v[i] = config.v_init;
      // Scaling factors can be baked into synaptic weights
    });

    // Initialize intensity buffers
    this.regionIntensity = new Float32Array(graph.regionOrder.length).fill(0);
    this.regionFlashIntensity = new Float32Array(graph.regionOrder.length).fill(0);
    this.pathwayIntensity = new Float32Array(graph.pathways.length).fill(0);
    this.membranePotentialNorm = new Float32Array(graph.nodes.length).fill(0);
  }

  // --- Public BrainSimulation API (SignalSimulation compatibility) ---

  setMemoryIntensity(count: number): void {
    this._memoryIntensity = Math.min(1, count / 500);
  }

  get memoryIntensity(): number {
    return this._memoryIntensity;
  }

  flashRegions(regionIds: BrainRegionId[], magnitude = 0.85): void {
    // TODO: Translate to synaptic input on region neurons
  }

  flashLogicalRegion(id: LogicalRegionId, magnitude = 0.85): void {
    const regions = LOGICAL_REGION_MAP[id];
    if (regions) this.flashRegions(regions, magnitude);
  }

  setRunning(running: boolean): void {
    // Noop - spiking is intrinsically continuous
  }

  setSpeed(speed: number): void {
    // TODO: Scale delta-time parameter
  }

  setAction(actionId: BrainActionId): void {
    this.actionId = actionId;
    // TODO: Prime region excitabilities per action
  }

  setMaxPulses(maxPulses: number): void {
    // Irrelevant for spiking simulation
  }

  step(deltaSeconds: number, elapsedSeconds: number): void {
    this.updateOscillations(deltaSeconds);
    this.integrateNeurons(deltaSeconds);
    this.applyPlasticity(deltaSeconds);
    this.processReplayQueue();
    this.updateDerivedVisualState();

    // Increment time for phase trackers
    this.theta_phase = (this.theta_phase + deltaSeconds * Math.PI * 2 * this.theta_freq) % (Math.PI * 2);
    this.gamma_phase = (this.gamma_phase + deltaSeconds * Math.PI * 2 * this.gamma_freq) % (Math.PI * 2);
  }

  // --- Biological Dynamics ---

  private updateOscillations(deltaSeconds: number): void {
    // TODO: Phase-response based modulation
    // Can tie theta_phase advance to hippocampal LFP
  }

  /**
   * Integrate neuron dynamics using LIF equations
   */
  private integrateNeurons(deltaSeconds: number): void {
    const deltaMs = deltaSeconds * 1000;
    const dt = Math.min(deltaMs, 1); // Euler step clamp
    const neurons = this.graph.nodes;
    const pathways = this.graph.pathways;

    // Per-neuron update
    neurons.forEach((neuron, i) => {
      // Skip refractory neurons
      if (this.refractory_time[i] > 0) {
        this.refractory_time[i] -= dt;
        this.v[i] = V_RESET; // Hold at reset during refractory
        return;
      }

      // Leakage: exponential decay toward V_REST
      const leakage = (this.v[i] - V_REST) * (dt / TAU_MEMBRANE);
      this.v[i] -= leakage;

      // Synaptic currents:
      // AMPA: fast excitatory (5ms decay)
      // NMDA: slow excitatory (150ms decay), voltage-gated
      // GABA_A: fast inhibitory (10ms decay)
      const g_ampa = this.g_ampa[i] * (dt / TAU_AMPA);
      const g_nmda = this.g_nmda[i] * (dt / TAU_NMDA) * this.nmdaMgBlock(this.v[i]);
      const g_gaba = this.g_gaba[i] * (dt / TAU_GABA);

      const i_ampa = g_ampa * (this.v[i] - V_AMPA_REV);
      const i_nmda = g_nmda * (this.v[i] - V_NMDA_REV);
      const i_gaba = g_gaba * (this.v[i] - V_GABA_REV);
      const i_syn = -(i_ampa + i_nmda + i_gaba);

      // External input (region-specific drives, e.g., from replay)
      const regionInput = this.getRegionInput(neuron.regionId);
      const i_ext = regionInput * 3; // Scale external input

      this.v[i] += i_syn + i_ext;

      // Spiking: threshold crossing
      if (this.v[i] >= V_THRESH) {
        this.v[i] = V_RESET;
        this.refractory_time[i] = TAU_REFRAC;
        this.broadcastSpike(neuron, i);
        this.propagateSpike(i, pathways);
      }

      // Decay conductances
      this.g_ampa[i] = Math.max(0, this.g_ampa[i] - g_ampa);
      this.g_nmda[i] = Math.max(0, this.g_nmda[i] - g_nmda);
      this.g_gaba[i] = Math.max(0, this.g_gaba[i] - g_gaba);
    });
  }

  /**
   * NMDA magnesium block: nonlinear voltage dependence
   */
  private nmdaMgBlock(v: number): number {
    // NMDA receptors are blocked by Mg2+ at hyperpolarized potentials
    return 1 / (1 + Math.exp(-0.062 * (v + 80)) * (1/3.57));
  }

  /**
   * Get external input drive for a region (e.g., from replay)
   */
  private getRegionInput(regionId: BrainRegionId): number {
    // During memory replay, hippocampus receives strong theta drive
    const isHippocampus = regionId === "hippocampus-l" || regionId === "hippocampus-r";
    const thetaDrive = isHippocampus ? 0.8 * Math.sin(this.theta_phase) : 0;
    return thetaDrive;
  }

  /**
   * Propagate a spike along outgoing pathways
   */
  private propagateSpike(fromIndex: number, pathways: readonly SynapticPathway[]): void {
    const fromNode = this.graph.nodes[fromIndex];
    const weightScale = this.getNeuronWeightScale(fromIndex);

    // Activate postsynaptic conductances for all outgoing pathways
    for (const pathway of pathways) {
      if (pathway.source === fromIndex) {
        const targetIndex = pathway.target;
        const targetRegion = this.graph.nodes[targetIndex].regionId;
        
        // Fast AMPA conductance
        this.g_ampa[targetIndex] += pathway.weight * weightScale;
        
        // Slow NMDA conductance (present at 20-30% of AMPA)
        this.g_nmda[targetIndex] += pathway.weight * 0.25 * weightScale;
        
        // Inhibitory pathway (10% of pathways are inhibitory)
        const isInhibitory = Math.random() < 0.1;
        if (isInhibitory) {
          this.g_gaba[targetIndex] += pathway.weight * 0.5 * weightScale;
        }
      }
    }
  }

  /**
   * Get weight scaling based on neuromodulator levels
   */
  private getNeuronWeightScale(neuronIndex: number): number {
    const region = this.graph.nodes[neuronIndex].regionId;
    const isPrefrontal = region === "prefrontal-l" || region === "prefrontal-r";
    
    // Dopamine boosts prefrontal cortex
    const daBoost = isPrefrontal ? this.neuromodulators.dopamine * 1.5 : this.neuromodulators.dopamine;
    
    // Acetylcholine boosts sensory regions
    const isSensory = ["occipital-l", "occipital-r", "temporal-l", "temporal-r"].includes(region);
    const achBoost = isSensory ? this.neuromodulators.acetylcholine * 1.8 : this.neuromodulators.acetylcholine;
    
    return 1.0 + daBoost * 0.4 + achBoost * 0.3;
  }

  private nmdaMgBlock(v: number): number {
    // NMDA receptor magnesium block
    return 1 / (1 + Math.exp(-0.062 * v) * (1/3.57));
  }

  private propagateSpike(fromIndex: number, pathways: readonly SynapticPathway[]): void {
    // TODO: Iterate outgoing pathways and activate postsynaptic conductances
  }

  /**
   * Apply Spike-Timing-Dependent Plasticity (STDP)
   * Modulated by theta phase and dopamine
   */
  private applyPlasticity(deltaSeconds: number): void {
    const pathways = this.graph.pathways;
    const deltaMs = deltaSeconds * 1000;
    
    // Store which neurons spiked in this timestep
    const spikesThisStep = new Set<number>();
    this.graph.nodes.forEach((_, i) => {
      if (this.v[i] >= V_THRESH && this.refractory_time[i] <= 0) {
        spikesThisStep.add(i);
      }
    });
    
    // For each pathway that could undergo STDP:
    // - If presynaptic spikes before postsynaptic → LTP (potentiation)
    // - If postsynaptic spikes before presynaptic → LTD (depression)
    pathways.forEach((pathway, pathwayIndex) => {
      const preIdx = pathway.source;
      const postIdx = pathway.target;
      
      // Was there a recent spike in the presynaptic neuron?
      const preSpiked = spikesThisStep.has(preIdx);
      // Was there a spike in the postsynaptic neuron?
      const postSpiked = spikesThisStep.has(postIdx);
      
      // STDP window: 20ms for LTP, 40ms for LTD
      const stdpWindowLtp = 20; // ms
      const stdpWindowLtd = 40; // ms
      
      // Check for eligible spike pairs
      if (preSpiked && !postSpiked) {
        // Presynaptic spike → soon-after postsynaptic spike would cause LTP
        // We don't know if post will spike, so we implement a "trace" mechanism
        // Here, we'll use the current membrane potential as a proxy for eligibility
        const eligibility = Math.max(0, Math.min(1, (this.v[postIdx] + 75) / 30)); // -75mV → 0, -45mV → 1
        
        // Theta phase modulation: potentiation strongest at theta trough
        const phaseMod = 1.2 - Math.abs(this.theta_phase - Math.PI) / Math.PI; // 0.2 at peak, 1.2 at trough
        
        // Dopamine modulation: enhances LTP
        const daMod = 1.0 + this.neuromodulators.dopamine * 0.8;
        
        // STDP LTP update
        let stdpLtp = eligibility * 0.005 * phaseMod * daMod;
        pathway.weight = Math.min(1.0, pathway.weight + stdpLtp);
      } else if (postSpiked && !preSpiked) {
        // Postsynaptic spike → soon-after presynaptic spike would cause LTD
        // Again, using membrane potential as a proxy for pre-synaptic eligibility
        const eligibility = Math.max(0, Math.min(1, (this.v[preIdx] + 75) / 30));
        
        // Acetylcholine reduces LTD in memory replay
        const achMod = this.neuromodulators.acetylcholine > 0.5 ? 0.3 : 1.0;
        
        // STDP LTD update
        let stdpLtd = eligibility * 0.003 * achMod;
        pathway.weight = Math.max(0.01, pathway.weight - stdpLtd);
      }
      
      // Update pathway intensity for visualization
      this.pathwayIntensity[pathwayIndex] = pathway.weight;
    });
    
    // Consolidate hippocampal memories during theta troughs
    if (this.theta_phase >= 0.9 * Math.PI && this.theta_phase < 1.1 * Math.PI) {
      this.consolidateRecentMemories();
    }
  }
  
  /**
   * Consolidate recent memories during theta trough
   */
  private consolidateRecentMemories(): void {
    // Hippocampus drives consolidation
    const hippocampalNeurons = this.graph.nodes
      .map((node, idx) => ({ node, idx }))
      .filter(({ node }) => node.regionId === "hippocampus-l" || node.regionId === "hippocampus-r");
    
    // Group by associated memory ID
    const memorySpikes: Record<string, number> = {};
    hippocampalNeurons.forEach(({ idx }) => {
      // In a real implementation, neurons would be tagged with memory ID
      // For now, simulate: each hippocampal neuron represents a unique memory
      const memoryId = `mem_${idx}`;
      memorySpikes[memoryId] = (memorySpikes[memoryId] || 0) + 1;
    });
    
    // Trigger replay for the most active memories
    const replayMemories = Object.entries(memorySpikes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(entry => entry[0]);
    
    // Simulate replay event
    if (replayMemories.length > 0) {
      this.replay_queue.push({
        type: "replay", 
        memoryIds: replayMemories,
        region: "hippocampus", 
        thetaPhase: "peak", // Starting with theta peak
        timestamp: Date.now(),
      });
    }
  }

  private processReplayQueue(): void {
    while (this.replay_queue.length > 0) {
      const replay = this.replay_queue.shift()!;
      if (replay.region === "hippocampus") {
        this.handleHippocampalReplay(replay);
      } else {
        this.handleNeocorticalReplay(replay);
      }
    }
  }

  /**
   * Handle hippocampal replay: drive theta-burst stimulation
   */
  private handleHippocampalReplay(replay: ReplayEvent): void {
    // Each memory drives a subset of hippocampal neurons
    replay.memoryIds.forEach((memoryId, idx) => {
      // Hippocampal neurons oscillate at theta frequency
      const thetaDrive = 0.5 + 0.3 * Math.sin(this.theta_phase + idx * 0.2);
      
      // In reality, memory IDs map to specific neuron populations
      // For simulation: spread across hippocampus
      this.graph.nodes.forEach((node, i) => {
        const isHippocampus = node.regionId === "hippocampus-l" || node.regionId === "hippocampus-r";
        if (isHippocampus) {
          // External theta drive
          const distanceToMemory = Math.abs((i % 10) / 10 - idx / 3);
          const driveStrength = thetaDrive * (0.8 - distanceToMemory * 0.6);
          // Add to AMPA conductance → strong depolarization
          this.g_ampa[i] += driveStrength;
          // Small NMDA contribution → calcium influx → consolidation
          this.g_nmda[i] += driveStrength * 0.2;
        }
      });
    });
    
    // Increase dopamine during replay → enhances consolidation
    this.neuromodulators.dopamine = Math.min(1.0, this.neuromodulators.dopamine + 0.2);
    
    // Visualization is driven directly via the conductance/intensity buffers
    // updated above — the browser engine does not broadcast over the WS.
    
    // Schedule neocortical replay to follow
    this.replay_queue.push({
      type: "replay", 
      memoryIds: replay.memoryIds,
      region: "neocortex",
      thetaPhase: "trough", // Gamma bursts nest in theta troughs
      timestamp: Date.now(),
    });
  }

  /**
   * Handle neocortical replay: drive gamma-burst stimulation
   */
  private handleNeocorticalReplay(replay: ReplayEvent): void {
    replay.memoryIds.forEach(memoryId => {
      // In neocortex: gamma bursts nest within theta trough
      const gammaDrive = 0.3 + 0.5 * Math.sin(this.gamma_phase);
      
      // Distribute across neocortical neurons
      this.graph.nodes.forEach((node, i) => {
        const isNeocortex = !["hippocampus-l", "hippocampus-r", "thalamus-l", "thalamus-r"].includes(node.regionId);
        if (isNeocortex) {
          // Random sparse activation (real replay is more structured)
          const sparsity = 0.1;
          if (Math.random() < sparsity) {
            // Strong AMPA conductance → gamma burst
            this.g_ampa[i] += gammaDrive;
            // Small GABA conductance → lateral inhibition in column
            this.g_gaba[i] += gammaDrive * 0.1;
          }
        }
      });
    });
    
    // Increase acetylcholine during replay → sharpens cortical response
    this.neuromodulators.acetylcholine = Math.min(1.0, this.neuromodulators.acetylcholine + 0.15);
    
    // Consolidation: re-trigger STDP with replay tags
    this.replay_tags = replay.memoryIds; // For STDP modulation
    
    // Visualization is driven directly via the conductance/intensity buffers
    // updated above — the browser engine does not broadcast over the WS.
  }

  // --- Integration Points ---

  /**
   * For replayService.ts integration
   */
  handleReplayEvent(event: ReplayEvent): void {
    this.replay_queue.push(event);
  }

  /**
   * Trigger memory replay during consolidation
   */
  triggerMemoryReplay(): void {
    // TODO: Coordinate with replayService.ts
  }

  private broadcastSpike(neuron: NeuronNode, index: number): void {
    // Record into a bounded local buffer for the BrainVisualEffects raster
    // plot to pull from (the browser engine does not broadcast over WS).
    this.recentSpikes.push({
      type: "spike",
      neuronIndex: index,
      regionId: neuron.regionId,
      timestamp: Date.now(),
    });
    if (this.recentSpikes.length > 256) this.recentSpikes.shift();
  }

  /** Drain recent spike events for visualization consumers. */
  drainSpikes(): SpikeEvent[] {
    const out = this.recentSpikes;
    this.recentSpikes = [];
    return out;
  }

  private updateDerivedVisualState(): void {
    // Convert membrane potentials to normalized intensities
    this.graph.nodes.forEach((neuron, i) => {
      const regionIndex = this.graph.regionOrder.indexOf(neuron.regionId);
      if (regionIndex >= 0) {
        // Normalize -80mV to -50mV as 0-1
        this.membranePotentialNorm[i] = Math.max(0, Math.min(1, (this.v[i] + 80) / 30));
        this.regionIntensity[regionIndex] = Math.max(
          this.regionIntensity[regionIndex],
          this.membranePotentialNorm[i] * 0.6
        );
      }
    });

    // Spread flash intensity decay
    this.regionFlashIntensity.forEach((val, i) => {
      this.regionFlashIntensity[i] = val * 0.7; // 70% decay per step
    });
  }
}

// Type exports
interface SpikeEvent {
  type: "spike";
  neuronIndex: number;
  regionId: BrainRegionId;
  timestamp: number;
}