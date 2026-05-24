// AdvancedBrainCore — the orchestrator of the biologically-plausible brain
// ========================================================================
//
// This is the conductor. It owns the neuron population and every subsystem, and
// it implements the project's existing `BrainSimulation` interface so it drops
// straight into BrainScene wherever `SignalSimulation` plugged in — the renderer
// neither knows nor cares which engine is driving the buffers.
//
// THE LOOP (one call to `step(delta, elapsed)`):
//
//   1. SLOW SUBSYSTEMS advance on real wall-clock dt:
//        oscillations → neuromodulators → predictive coding → homeostasis
//   2. DRIVE is assembled per region from five sources, then gated:
//        drive = tonic + action + oscillation + cognitive-state + prediction-error
//        gated by  × neuromodulatory excitability  × homeostatic gain
//      and injected as external current into that region's neurons.
//   3. SYNAPTIC PROPAGATION of the PREVIOUS step's spikes through the CSR
//      connectome — O(spikes × out-degree), the cheap path that replaces the old
//      O(spikes × all-pathways) loop that froze the thread.
//   4. INTEGRATE one Izhikevich step → this step's spikes.
//   5. PLASTICITY: dopamine-gated, trace-based STDP on the spiking edges only.
//   6. COGNITION: feed spikes to memory (encode/replay) & predictive coding.
//   7. VISUAL BUFFERS: region intensities, membrane heatmap, travelling pulses,
//      neuromodulator scalars, oscillation phases, burst & memory traces.
//
// Everything here is allocation-conscious (reused scratch buffers, capped pulse
// pool) so a few thousand neurons sustain interactive frame-rates in a browser.

import { ACTION_BY_ID, REGION_INDEX, REGION_ORDER } from "./brainRegions";
import { LOGICAL_REGION_MAP } from "./logicalRegions";
import { getActionColor } from "../data/regionDefinitions";
import { BrainEventBus } from "./BrainEventBus";
import { BrainOscillations } from "./BrainOscillations";
import { BrainDynamics } from "./BrainDynamics";
import { IzhikevichNeuronEngine, type NeuronClass } from "./IzhikevichNeuron";
import { MemorySystem } from "./MemorySystem";
import { NeuromodulationSystem } from "./NeuromodulationSystem";
import { PredictiveCodingEngine } from "./PredictiveCodingEngine";
import { RealisticConnectome } from "./RealisticConnectome";
import type { CognitiveState } from "./cognitiveStates";
import type { LogicalRegionId } from "../../shared/pipeline";
import type { NeuromodSnapshot } from "../../shared/brainSnapshot";
import type {
  BrainActionId,
  BrainRegionId,
  BrainSimulation,
  NeuralGraph,
  SignalPulse,
} from "./types";

/**
 * Hippocampal-/neocortical-replay event. Mirrors the shape that flows over the
 * brain WS bus from the server's consolidation layer, but is declared here so
 * this engine has ZERO server-side imports (preserving the src ↔ server layer
 * boundary). `SpikingEngine.ts` re-exports this type for back-compat.
 */
export interface ReplayEvent {
  type: "replay";
  memoryIds: string[];
  region: "hippocampus" | "neocortex";
  thetaPhase: "peak" | "trough";
  timestamp: number | string;
}

// ── Fixed-step integration ────────────────────────────────────────────────────
// The neural ODE runs FIXED_SUBSTEPS sub-millisecond steps per render frame with
// the drive held constant across them. One 1 ms step per frame (the old path) left
// every neuron permanently sub-threshold AND ~16× desynced from theta. A 0.5 ms
// step is comfortably inside Euler's stability region for these parameters.
const SUB_DT_MS = 0.5; // Izhikevich integration timestep (ms)
const FIXED_SUBSTEPS = 8; // sub-steps per render frame → 4 ms sim-time/frame
const SUB_DT_S = SUB_DT_MS / 1000; // per-substep dt in seconds (trace/STDP decay)

// ── Drive scaling (in Izhikevich current units; RS cells fire tonically ~I=10) ─
const TONIC_DRIVE = 1.2; // keeps the net from going fully silent
const ACTION_DRIVE = 5.5; // current injected into the active action's regions
const OSC_SCALE = 1.8; // oscillatory drive amplitude
const PE_SCALE = 3.0; // prediction-error → bottom-up drive (surprise → bursts)
const WM_SCALE = 4.0; // working-memory sustained drive
const REPLAY_SCALE = 5.0; // replay reactivation drive
const MAX_DRIVE = 18; // hard ceiling per region

// ── Synaptic conductance increments per spike (scaled by plastic weight) ──────
const AMPA_GAIN = 0.09;
const NMDA_GAIN = 0.018;
const GABA_GAIN = 2.6;

// ── STDP ──────────────────────────────────────────────────────────────────
const STDP_LTP = 0.012; // potentiation rate (pre-before-post)
const STDP_LTD = 0.011; // depression rate (post-before-pre)
const TRACE_TAU = 0.025; // eligibility-trace time constant (s) ≈ 25 ms STDP window
const W_MIN = 0.02;
const W_MAX = 1.0;

const DEFAULT_MAX_PULSES = 260;
const MAX_NEW_PULSES_PER_FRAME = 10;

export class AdvancedBrainCore implements BrainSimulation {
  // ── Subsystems ────────────────────────────────────────────────────────────
  readonly bus = new BrainEventBus();
  private readonly connectome: RealisticConnectome;
  private readonly izh: IzhikevichNeuronEngine;
  private readonly neuromod: NeuromodulationSystem;
  private readonly oscillations: BrainOscillations;
  private readonly predictive: PredictiveCodingEngine;
  private readonly memory: MemorySystem;
  private readonly dynamics: BrainDynamics;

  // ── Config ────────────────────────────────────────────────────────────────
  private graph: NeuralGraph;
  private actionId: BrainActionId;
  private running = true;
  private speed = 1;
  private maxPulses = DEFAULT_MAX_PULSES;
  private cognitiveState: CognitiveState | null = null;
  private _memoryIntensity = 0;

  // ── BrainSimulation surface (read by the renderer) ─────────────────────────
  readonly regionIntensity: Float32Array;
  readonly regionFlashIntensity: Float32Array;
  readonly pathwayIntensity: Float32Array;
  readonly membranePotentialNorm: Float32Array;
  private readonly _pulses: SignalPulse[] = [];
  get pulses(): readonly SignalPulse[] {
    return this._pulses;
  }
  get memoryIntensity(): number {
    return this._memoryIntensity;
  }

  // ── Producer-side state read by BrainScene/BrainVisualEffects ───────────────
  /** +1 excitatory / −1 inhibitory, straight from the connectome (Dale). */
  readonly neuronType: Int8Array;
  private readonly burstStatus: Float32Array;
  /** Per-neuron "fired this frame" flash (1 on spike, decays). Overlaid onto
   *  membranePotentialNorm so a spike's +30 mV peak renders before the reset. */
  private readonly firedFlash: Float32Array;
  /** Reused per-frame list of unique neurons that spiked across this frame's
   *  substeps (drives region activity, bursts, and pulse spawning). */
  private readonly frameSpikes: number[] = [];

  // ── Scratch / precomputed (allocated once) ─────────────────────────────────
  private readonly R: number;
  private readonly N: number;
  /** neuron indices grouped by region order index (for cheap per-region drive). */
  private readonly regionNeurons: number[][];
  /** visual pathways grouped by their source node (for spike-driven pulses). */
  private readonly pathwaysBySource: number[][];
  /** action-eligible pathways for the spontaneous baseline visual flow. */
  private eligiblePathways: number[] = [];
  private readonly regionDrive: Float32Array; // per region, this frame
  private readonly regionSpikeCount: Float32Array; // per region, this frame
  private readonly regionNeuronCount: Float32Array;
  private readonly traceX: Float32Array; // STDP eligibility trace per neuron
  /** Per-(postsynaptic-)neuron metaplastic modulation of the STDP rate. Default
   *  1.0 (identity). The MetaLearningSystem writes this to implement a BCM-style
   *  sliding threshold (homeostatic metaplasticity). Read inside applyStdp. */
  private readonly metaplastic: Float32Array;
  /** Global STDP learning-rate multiplier set by the meta-learner. Default 1.0
   *  (identity) so the engine's stabilised dynamics are unchanged unless a
   *  HybridCognitiveCore opts in. Bounded by the caller. */
  private plasticityScale = 1;
  private prevSpikes: readonly number[] = [];
  private nextPulseId = 1;
  private spawnAccumulator = 0;
  // Reused conductance objects so propagation allocates nothing per synapse.
  private readonly excCond: { g_ampa: number; g_nmda: number } = { g_ampa: 0, g_nmda: 0 };
  private readonly inhCond: { g_gaba_a: number } = { g_gaba_a: 0 };

  constructor(graph: NeuralGraph, actionId: BrainActionId) {
    this.graph = graph;
    this.actionId = actionId;
    this.R = graph.regionOrder.length;
    this.N = graph.nodes.length;

    // 1) Build the connectome first — it fixes each neuron's E/I identity.
    this.connectome = new RealisticConnectome(graph, { seed: 1337 });
    this.neuronType = this.connectome.neuronSign;

    // 2) Derive Izhikevich neuron classes from the connectome's signs and spin
    //    up the neuron engine (region assignment drives modulator baselines).
    const regionAssignments: BrainRegionId[] = graph.nodes.map((n) => n.regionId);
    const neuronClasses = this.assignNeuronClasses(this.neuronType, 4242);
    this.izh = new IzhikevichNeuronEngine(this.N, regionAssignments, neuronClasses, 19);

    // 3) Remaining subsystems share the bus.
    this.neuromod = new NeuromodulationSystem(this.bus);
    this.oscillations = new BrainOscillations();
    this.predictive = new PredictiveCodingEngine(this.bus);
    this.memory = new MemorySystem(graph, this.bus);
    this.dynamics = new BrainDynamics(this.N, {}, this.bus);

    // 4) BrainSimulation buffers.
    this.regionIntensity = new Float32Array(this.R);
    this.regionFlashIntensity = new Float32Array(this.R);
    this.pathwayIntensity = new Float32Array(graph.pathways.length);
    this.membranePotentialNorm = new Float32Array(this.N);
    this.burstStatus = new Float32Array(this.N);
    this.firedFlash = new Float32Array(this.N);

    // Run the neuron engine at the sub-millisecond fixed step (Euler-stable).
    this.izh.setTimestep(SUB_DT_MS);

    // 5) Scratch + precomputed lookups.
    this.regionDrive = new Float32Array(this.R);
    this.regionSpikeCount = new Float32Array(this.R);
    this.regionNeuronCount = new Float32Array(this.R);
    this.traceX = new Float32Array(this.N);
    this.metaplastic = new Float32Array(this.N).fill(1);
    this.regionNeurons = Array.from({ length: this.R }, () => [] as number[]);
    this.pathwaysBySource = Array.from({ length: this.N }, () => [] as number[]);
    for (let i = 0; i < this.N; i++) {
      const ri = graph.nodes[i].regionIndex;
      this.regionNeurons[ri].push(i);
      this.regionNeuronCount[ri]++;
    }
    for (let p = 0; p < graph.pathways.length; p++) {
      const src = graph.pathways[p].source;
      if (src >= 0 && src < this.N) this.pathwaysBySource[src].push(p);
    }
    this.rebuildEligiblePathways();
  }

  // ════════════════════════════════════════════════════════════════════════
  //  BrainSimulation API
  // ════════════════════════════════════════════════════════════════════════

  setRunning(running: boolean): void {
    this.running = running;
  }

  setSpeed(speed: number): void {
    this.speed = Math.max(0.1, speed);
  }

  setMaxPulses(maxPulses: number): void {
    this.maxPulses = Math.max(20, Math.round(maxPulses));
  }

  setAction(actionId: BrainActionId): void {
    if (this.actionId === actionId) return;
    this.actionId = actionId;
    this.rebuildEligiblePathways();
  }

  setMemoryIntensity(count: number): void {
    this._memoryIntensity = Math.min(1, count / 500);
    this.memory.setMemoryLoad(this._memoryIntensity);
  }

  flashRegions(regionIds: BrainRegionId[], magnitude = 0.85): void {
    for (const regionId of regionIds) {
      const index = REGION_INDEX[regionId];
      if (index !== undefined && this.regionFlashIntensity[index] < magnitude) {
        this.regionFlashIntensity[index] = magnitude;
      }
    }
  }

  flashLogicalRegion(id: LogicalRegionId, magnitude = 0.85): void {
    const regions = LOGICAL_REGION_MAP[id];
    if (regions) this.flashRegions(regions, magnitude);
  }

  // ════════════════════════════════════════════════════════════════════════
  //  Producer-side accessors (BrainScene / BrainVisualEffects / MemoryBrainBridge)
  // ════════════════════════════════════════════════════════════════════════

  get dopamine(): number {
    return this.neuromod.dopamine;
  }
  get acetylcholine(): number {
    return this.neuromod.acetylcholine;
  }
  get serotonin(): number {
    return this.neuromod.serotonin;
  }
  get norepinephrine(): number {
    return this.neuromod.norepinephrine;
  }
  get thetaPhase(): number {
    return this.oscillations.thetaPhase;
  }
  get gammaPhase(): number {
    return this.oscillations.gammaPhase;
  }

  /** Per-neuron burst engagement [0,1] for the shader (sustained firing). */
  getBurstStatus(): Float32Array | null {
    return this.burstStatus;
  }

  /** Per-neuron memory engagement [0,1] for the shader. */
  getMemoryTrace(): Float32Array | null {
    return this.memory.memoryTrace;
  }

  setDopamine(v: number): void {
    this.neuromod.setLevel("dopamine", v);
  }
  setAcetylcholine(v: number): void {
    this.neuromod.setLevel("acetylcholine", v);
  }

  // ════════════════════════════════════════════════════════════════════════
  //  Cognition seams — read/written by HybridCognitiveCore's subsystems. These
  //  are additive and default to identity behaviour; they do NOT alter the
  //  stabilised dynamics unless a wrapper deliberately drives them.
  // ════════════════════════════════════════════════════════════════════════

  /** Variational free energy from the predictive-coding hierarchy (surprise). */
  getFreeEnergy(): number {
    return this.predictive.getFreeEnergy();
  }
  /** Criticality score 0..1 (1 = poised at σ≈1). */
  getCriticalityScore(): number {
    return this.dynamics.getCriticalityScore();
  }
  /** Population mean firing fraction per step (homeostatic target ≈0.02). */
  getMeanRate(): number {
    return this.dynamics.getMeanRate();
  }
  /** Branching-ratio σ estimate from the homeostasis controller. */
  getBranchingRatio(): number {
    return this.dynamics.getBranchingRatio();
  }
  /** Top-down predicted activity for a region (by REGION_ORDER index). */
  getRegionPrediction(regionIndex: number): number {
    return this.predictive.getPrediction(regionIndex);
  }
  /** Signed prediction error for a region (by REGION_ORDER index). */
  getRegionError(regionIndex: number): number {
    return this.predictive.getPredictionError(regionIndex);
  }
  /** Bias a region's top-down prior — the System 2 → System 1 injection path. */
  setExpectation(regionId: BrainRegionId, value: number): void {
    this.predictive.setExpectation(regionId, value);
  }
  /** The plastic connectome weight vector (learned by STDP; the durable payload). */
  getConnectomeWeights(): Float32Array {
    return this.connectome.weight;
  }
  /** Per-neuron metaplastic rate array the meta-learner writes (BCM threshold). */
  getMetaplasticArray(): Float32Array {
    return this.metaplastic;
  }

  /**
   * Apply a bounded, SAFE subset of meta-learned hyperparameters. Deliberately
   * excludes the E:I synaptic gains: those stay fixed and the homeostatic
   * controller regulates overall gain, so meta-tuning them is redundant and
   * risks re-seizing the freshly-stabilised network.
   */
  applyMetaTuning(t: {
    plasticityScale?: number;
    dopamineBaseline?: number;
    acetylcholineBaseline?: number;
  }): void {
    if (t.plasticityScale !== undefined) this.plasticityScale = clamp(t.plasticityScale, 0.25, 3);
    if (t.dopamineBaseline !== undefined) this.neuromod.setBaseline("dopamine", t.dopamineBaseline);
    if (t.acetylcholineBaseline !== undefined) {
      this.neuromod.setBaseline("acetylcholine", t.acetylcholineBaseline);
    }
  }

  /** Capture the durable core state (learned weights + tonic neuromodulators). */
  serializeCore(): { connectomeWeights: Float32Array; neuromod: NeuromodSnapshot } {
    return {
      connectomeWeights: this.connectome.weight.slice(),
      neuromod: {
        dopamine: this.neuromod.dopamine,
        acetylcholine: this.neuromod.acetylcholine,
        serotonin: this.neuromod.serotonin,
        norepinephrine: this.neuromod.norepinephrine,
      },
    };
  }

  /**
   * Restore durable core state. Weights are copied only when the length matches
   * (same topology); otherwise the restore is rejected and the caller keeps the
   * freshly-built brain. Returns whether the weights were applied.
   */
  loadCoreState(state: { connectomeWeights: Float32Array; neuromod: NeuromodSnapshot }): boolean {
    if (state.connectomeWeights.length !== this.connectome.weight.length) return false;
    this.connectome.weight.set(state.connectomeWeights);
    this.neuromod.setLevel("dopamine", state.neuromod.dopamine);
    this.neuromod.setLevel("acetylcholine", state.neuromod.acetylcholine);
    this.neuromod.setLevel("serotonin", state.neuromod.serotonin);
    this.neuromod.setLevel("norepinephrine", state.neuromod.norepinephrine);
    return true;
  }

  /**
   * Apply a cognitive-state overlay (Focus / Recall / Creative …). It retunes the
   * neuromodulatory baselines and the oscillation band gains, and stores the
   * extra per-region drive the state recruits (e.g. default-mode nodes).
   */
  applyCognitiveState(state: CognitiveState): void {
    this.cognitiveState = state;
    if (state.dopamine !== undefined) this.neuromod.setBaseline("dopamine", state.dopamine);
    if (state.acetylcholine !== undefined) this.neuromod.setBaseline("acetylcholine", state.acetylcholine);
    if (state.serotonin !== undefined) this.neuromod.setBaseline("serotonin", state.serotonin);
    if (state.norepinephrine !== undefined) this.neuromod.setBaseline("norepinephrine", state.norepinephrine);
    this.oscillations.setBandGain("theta", state.thetaGain ?? 1);
    this.oscillations.setBandGain("gamma", state.gammaGain ?? 1);
    this.bus.emit("state:change", { name: state.name });
  }

  /** Begin a hippocampal replay bout + a small dopamine consolidation pulse. */
  triggerMemoryReplay(): void {
    this.memory.triggerReplay();
    this.neuromod.pulse("dopamine", 0.2, "replay");
  }

  /** Forward a server/consolidation replay event into the memory subsystem. */
  handleReplayEvent(event: ReplayEvent): void {
    this.memory.triggerReplay();
    if (event.region === "hippocampus") this.flashRegions(["hippocampus-l", "hippocampus-r"], 0.7);
    this.neuromod.pulse("acetylcholine", 0.15, "replay");
  }

  /**
   * Treat external text (a user message / LLM reasoning step) as SENSORY input:
   * route it to the predictive-coding hierarchy (as observations that may violate
   * predictions) and encode it episodically. Deterministic word→region hashing.
   */
  injectSensoryText(text: string, surprise = false): void {
    const words = text.toLowerCase().split(/\W+/).filter(Boolean).slice(0, 24);
    if (words.length === 0) return;
    const regions = new Set<BrainRegionId>();
    for (const word of words) {
      let h = 0;
      for (let k = 0; k < word.length; k++) h = (h * 31 + word.charCodeAt(k)) | 0;
      const region = REGION_ORDER[Math.abs(h) % this.R];
      regions.add(region);
      this.predictive.injectSensory(region, 0.8, surprise);
    }
    this.memory.encodeEpisodic([...regions], Math.min(1, 0.3 + words.length * 0.03));
    this.neuromod.pulse("acetylcholine", 0.1, "sensory");
  }

  // ════════════════════════════════════════════════════════════════════════
  //  Simulation step
  // ════════════════════════════════════════════════════════════════════════

  step(deltaSeconds: number, elapsedSeconds: number): void {
    if (!this.running) return;
    const dt = Math.min(deltaSeconds, 0.05); // clamp huge frame gaps

    // 1) Slow subsystems advance ONCE per frame on real time (oscillation tempo
    //    scales with the user speed slider).
    this.oscillations.update(dt * this.speed);
    this.neuromod.update(dt);
    const attention = Math.min(1, (this.neuromod.acetylcholine + this.neuromod.norepinephrine) * 0.7);
    // Predictive coding observes LAST frame's region activity; its error drive
    // feeds THIS frame's input (surprise → bottom-up boost → bursts).
    this.predictive.update(this.regionIntensity, attention, dt);

    // 2) Assemble per-region drive once. It is held CONSTANT across the substeps —
    //    a sustained current is what actually lets a neuron climb to threshold
    //    (a single 1 ms kick that is then zeroed never does).
    this.computeDrive(elapsedSeconds);
    const homeostatic = this.dynamics.getHomeostaticGain();

    // 3) Fast neural dynamics: FIXED_SUBSTEPS sub-millisecond Izhikevich steps with
    //    spike propagation + STDP each substep. Collect the frame's unique firers.
    const frameSpikes = this.frameSpikes;
    frameSpikes.length = 0;
    let totalSpikes = 0;
    for (let k = 0; k < FIXED_SUBSTEPS; k++) {
      // Re-inject the drive every substep — izh.update() zeroes I after integrating.
      for (let ri = 0; ri < this.R; ri++) {
        const current = clamp(this.regionDrive[ri] * homeostatic, 0, MAX_DRIVE);
        if (current > 0.001) this.izh.applyCurrent(this.regionNeurons[ri], current);
      }
      this.propagateSpikes();        // previous substep's spikes → CSR connectome
      this.izh.update(null);         // one SUB_DT_MS integration step
      const spikes = this.izh.getLastStepSpikes();
      this.applyStdp(spikes, SUB_DT_S); // per-substep timing, NOT the frame dt
      for (const i of spikes) {
        if (this.firedFlash[i] < 1) frameSpikes.push(i); // unique within the frame
        this.firedFlash[i] = 1;
      }
      totalSpikes += spikes.length;
      this.prevSpikes = spikes;
    }

    // 4) Cognition once per frame on real time. dynamics sees the mean per-substep
    //    spike count so its activity/homeostasis target matches the old cadence.
    this.updateRegionActivity(frameSpikes, dt);
    const hippo = 0.5 * (this.regionIntensity[REGION_INDEX["hippocampus-l"]] + this.regionIntensity[REGION_INDEX["hippocampus-r"]]);
    this.memory.update(dt, hippo, this.regionIntensity);
    this.dynamics.update(totalSpikes / FIXED_SUBSTEPS, dt);
    // High free energy = the world surprised us → noradrenergic arousal burst.
    if (this.predictive.getFreeEnergy() > 6) this.neuromod.pulse("norepinephrine", 0.12, "surprise");

    // 5) Visual buffers once per frame. Overlay the fire flash: a neuron that
    //    spiked this frame has already reset to c by now, so its post-reset voltage
    //    would render dim — force its visual membrane to the firing colour, then
    //    fade so spikes read as bright flashes rather than vanishing.
    this.izh.writeMembranePotentialsNormalized(this.membranePotentialNorm);
    const flashDecay = Math.pow(0.02, dt); // ≈0.94/frame at 60 fps → ~0.15 s tail
    const mem = this.membranePotentialNorm;
    const flash = this.firedFlash;
    for (let i = 0; i < this.N; i++) {
      if (flash[i] > mem[i]) mem[i] = flash[i];
      flash[i] *= flashDecay;
    }
    this.updateBursts(frameSpikes, dt);
    this.advancePulses(dt);
    this.spawnPulses(frameSpikes, dt);
    this._memoryIntensity = Math.max(this._memoryIntensity * Math.pow(0.92, dt), this.memory.isReplaying() ? 0.6 : 0);
  }

  // ── Drive assembly ──────────────────────────────────────────────────────────

  private computeDrive(elapsedSeconds: number): void {
    const action = ACTION_BY_ID[this.actionId];
    const activeSet = action ? new Set(action.activeRegions) : new Set<BrainRegionId>();
    const stateDrive = new Map<BrainRegionId, number>();
    if (this.cognitiveState?.extraDrive) {
      for (const [region, value] of this.cognitiveState.extraDrive) stateDrive.set(region, value);
    }

    for (let ri = 0; ri < this.R; ri++) {
      const regionId = REGION_ORDER[ri];
      let drive = TONIC_DRIVE;

      // Action: the selected behaviour recruits its network (slow shimmer keeps
      // it from looking static).
      if (activeSet.has(regionId)) {
        drive += ACTION_DRIVE * (0.85 + 0.15 * Math.sin(elapsedSeconds * 3 + ri));
      }
      // Oscillatory drive (rhythmic push/pull; gamma already theta-nested).
      drive += OSC_SCALE * Math.max(0, this.oscillations.getRegionDrive(regionId));
      // Cognitive-state extra recruitment.
      const extra = stateDrive.get(regionId);
      if (extra) drive += ACTION_DRIVE * 0.6 * extra;
      // Working-memory + replay reactivation.
      drive += WM_SCALE * this.memory.getWorkingMemoryDrive(ri);
      drive += REPLAY_SCALE * this.memory.getReplayDrive(ri);
      // Bottom-up prediction error (the surprise → burst path).
      drive += PE_SCALE * this.predictive.errorDrive[ri];
      // Memory load lights the hippocampus.
      if (regionId.startsWith("hippocampus")) drive += this._memoryIntensity * 3;

      // Neuromodulatory excitability gate (attention/arousal/reward).
      this.regionDrive[ri] = drive * this.neuromod.getExcitability(regionId);
    }
  }

  // ── Synaptic propagation (CSR) ──────────────────────────────────────────────

  private propagateSpikes(): void {
    const { outStart, outTarget, weight } = this.connectome;
    const sign = this.neuronType;
    for (const i of this.prevSpikes) {
      const start = outStart[i];
      const end = outStart[i + 1];
      if (sign[i] > 0) {
        for (let s = start; s < end; s++) {
          const w = weight[s];
          this.excCond.g_ampa = w * AMPA_GAIN;
          this.excCond.g_nmda = w * NMDA_GAIN;
          this.izh.applySynapticInput(outTarget[s], this.excCond, 1);
        }
      } else {
        for (let s = start; s < end; s++) {
          this.inhCond.g_gaba_a = weight[s] * GABA_GAIN;
          this.izh.applySynapticInput(outTarget[s], this.inhCond, 1);
        }
      }
    }
  }

  // ── Plasticity: trace-based, dopamine-gated STDP ────────────────────────────

  private applyStdp(spikes: readonly number[], dt: number): void {
    // Decay every eligibility trace toward zero.
    const decay = Math.exp(-dt / TRACE_TAU);
    for (let i = 0; i < this.N; i++) this.traceX[i] *= decay;

    if (spikes.length === 0) return;
    // Three-factor rate: Hebbian × neuromodulatory write-enable (dopamine-gated)
    // × global meta-learned plasticity scale. The per-neuron metaplastic factor
    // (BCM sliding threshold) is folded in below.
    const gain = this.neuromod.getPlasticityGain() * this.plasticityScale;
    const { outStart, outTarget, inStart, inSyn, synSource, weight } = this.connectome;
    const sign = this.neuronType;
    const meta = this.metaplastic;

    for (const i of spikes) {
      const rate = gain * meta[i]; // metaplasticity is indexed by the spiking cell
      // LTP at the POSTsynaptic spike: strengthen excitatory inputs whose
      // presynaptic cell fired recently (pre-before-post). Needs incoming edges.
      const inS = inStart[i];
      const inE = inStart[i + 1];
      for (let k = inS; k < inE; k++) {
        const s = inSyn[k];
        const pre = synSource[s];
        if (sign[pre] <= 0) continue; // only excitatory synapses are plastic here
        const w = weight[s] + STDP_LTP * this.traceX[pre] * rate;
        weight[s] = w > W_MAX ? W_MAX : w;
      }
      // LTD at the PREsynaptic spike: weaken this cell's outgoing excitatory
      // edges to targets that fired recently (post-before-pre).
      if (sign[i] > 0) {
        const os = outStart[i];
        const oe = outStart[i + 1];
        for (let s = os; s < oe; s++) {
          const w = weight[s] - STDP_LTD * this.traceX[outTarget[s]] * rate;
          weight[s] = w < W_MIN ? W_MIN : w;
        }
      }
    }

    // Each spiking neuron now leaves a fresh trace.
    for (const i of spikes) this.traceX[i] = Math.min(2, this.traceX[i] + 1);
  }

  // ── Region activity / intensity ─────────────────────────────────────────────

  private updateRegionActivity(spikes: readonly number[], dt: number): void {
    this.regionSpikeCount.fill(0);
    const nodes = this.graph.nodes;
    for (const i of spikes) this.regionSpikeCount[nodes[i].regionIndex]++;

    const decay = Math.pow(0.05, dt);
    const flashDecay = Math.pow(0.18, dt);
    for (let ri = 0; ri < this.R; ri++) {
      // Firing-rate fraction for this region, mapped into a visible 0–1 band.
      const rate = this.regionSpikeCount[ri] / Math.max(1, this.regionNeuronCount[ri]);
      const activity = Math.min(1, rate * 12);
      // Blend: decayed history + new activity + a faint floor from drive so the
      // structure is legible even before spikes build up.
      const driveFloor = Math.min(0.25, this.regionDrive[ri] * 0.02);
      const next = Math.max(this.regionIntensity[ri] * decay, activity, driveFloor);
      this.regionIntensity[ri] = next;
      this.regionFlashIntensity[ri] *= flashDecay;
    }
  }

  // ── Burst tracking (sustained high-frequency firing) ────────────────────────

  private updateBursts(spikes: readonly number[], dt: number): void {
    const decay = Math.pow(0.1, dt);
    for (let i = 0; i < this.N; i++) this.burstStatus[i] *= decay;
    for (const i of spikes) {
      const v = this.burstStatus[i] + 0.4;
      this.burstStatus[i] = v > 1 ? 1 : v;
    }
  }

  // ── Pulse visualisation ─────────────────────────────────────────────────────

  private advancePulses(dt: number): void {
    const pathwayDecay = Math.pow(0.08, dt);
    for (let i = 0; i < this.pathwayIntensity.length; i++) this.pathwayIntensity[i] *= pathwayDecay;

    for (let index = this._pulses.length - 1; index >= 0; index--) {
      const pulse = this._pulses[index];
      pulse.progress += dt * pulse.velocity * this.speed;
      const pi = pulse.pathwayIndex;
      const glow = pulse.intensity * (0.35 + Math.sin(Math.min(1, pulse.progress) * Math.PI) * 0.65);
      if (glow > this.pathwayIntensity[pi]) this.pathwayIntensity[pi] = glow;

      if (pulse.progress >= 1) {
        const last = this._pulses.pop()!;
        if (index < this._pulses.length) this._pulses[index] = last;
      }
    }
  }

  private spawnPulses(spikes: readonly number[], dt: number): void {
    const color = getActionColor(this.actionId);

    // Spike-driven pulses: real spikes that have an outgoing visual pathway emit
    // a travelling pulse, capped per frame and by the pool size.
    let made = 0;
    for (const i of spikes) {
      if (made >= MAX_NEW_PULSES_PER_FRAME || this._pulses.length >= this.maxPulses) break;
      const out = this.pathwaysBySource[i];
      if (out.length === 0) continue;
      const p = out[(this.nextPulseId + i) % out.length];
      this.pushPulse(p, color);
      made++;
    }

    // Spontaneous baseline flow along the action's network so the selected
    // behaviour always reads visually, even when spiking is sparse.
    const action = ACTION_BY_ID[this.actionId];
    this.spawnAccumulator += dt * (action?.impulseRate ?? 6) * this.speed * 0.6;
    while (this.spawnAccumulator >= 1) {
      this.spawnAccumulator -= 1;
      if (this._pulses.length >= this.maxPulses || this.eligiblePathways.length === 0) break;
      const p = this.eligiblePathways[Math.floor(Math.random() * this.eligiblePathways.length)];
      this.pushPulse(p, color);
    }
  }

  private pushPulse(pathwayIndex: number, color: string): void {
    const pathway = this.graph.pathways[pathwayIndex];
    if (!pathway) return;
    this._pulses.push({
      id: this.nextPulseId++,
      pathwayIndex,
      fromNode: pathway.source,
      toNode: pathway.target,
      progress: 0,
      velocity: 0.6 + Math.random() * 0.8,
      intensity: 0.6 + Math.random() * 0.4,
      colorRegionId: pathway.sourceRegionId,
      colorRegionIndex: pathway.sourceRegionIndex,
      reverse: false,
      actionColor: color,
    });
  }

  private rebuildEligiblePathways(): void {
    this.eligiblePathways = [];
    const action = ACTION_BY_ID[this.actionId];
    if (!action) return;
    const activeSet = new Set(action.activeRegions);
    for (let p = 0; p < this.graph.pathways.length; p++) {
      const pw = this.graph.pathways[p];
      if (activeSet.has(pw.sourceRegionId) || activeSet.has(pw.targetRegionId)) {
        this.eligiblePathways.push(p);
      }
    }
  }

  // ── Neuron-class assignment (Dale-consistent) ───────────────────────────────

  private assignNeuronClasses(sign: Int8Array, seed: number): NeuronClass[] {
    let s = seed >>> 0;
    const rng = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const classes: NeuronClass[] = new Array(sign.length);
    for (let i = 0; i < sign.length; i++) {
      if (sign[i] > 0) {
        const r = rng();
        // Most excitatory cells are regular-spiking; a minority burst.
        classes[i] = r < 0.78 ? "excitatory_rs" : r < 0.92 ? "excitatory_ib" : "excitatory_ch";
      } else {
        classes[i] = rng() < 0.8 ? "inhibitory_fs" : "inhibitory_lts";
      }
    }
    return classes;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
