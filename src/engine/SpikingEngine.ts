// SpikingEngine — biologically-grounded leaky integrate-and-fire (LIF) simulation
// that drops in where SignalSimulation used to sit. The public surface
// (regionIntensity / pathwayIntensity / pulses / step / setAction / ...) is
// identical so the NeuralGraph renderer doesn't need to change.
//
// What's modelled (and why each piece is here):
//
//   • Leaky integrate-and-fire neurons. Vm decays toward V_rest with time
//     constant τ_m; presynaptic spikes push current that decays with τ_syn;
//     when Vm crosses threshold we emit a spike, reset Vm, and hold the
//     neuron refractory. This is the workhorse spiking abstraction in
//     computational neuroscience — cheap, well-characterised, and enough
//     to produce realistic firing statistics and avalanche dynamics.
//
//   • 80% excitatory / 20% inhibitory split. Cortex is roughly that ratio,
//     and the E/I balance regime is what gives cortical-style irregular
//     spiking instead of either silence or runaway synchrony.
//
//   • Trace-based STDP (online, dopamine-modulated). Each neuron carries
//     two synaptic eligibility traces; on every spike we walk outgoing
//     synapses to apply LTD (post-fired-before-pre) and incoming synapses
//     to apply LTP (pre-fired-before-post). Dopamine scales the LTP/LTD
//     gains — the classic "three-factor" reward-modulated Hebbian rule.
//
//   • Neuromodulators. Dopamine and acetylcholine are stored as global
//     scalars decaying toward their baselines (phasic + tonic). Dopamine
//     gates plasticity and adds a small excitability boost; acetylcholine
//     raises gain and lowers spontaneous noise (a passable proxy for the
//     attentional "signal-to-noise" effect ACh has in real cortex).
//
//   • Theta (6 Hz) and gamma (40 Hz) oscillations. Two global phases drive
//     a small additive current per region; their per-region gain lets us
//     express e.g. "hippocampus rides on theta during memory recall" or
//     "PFC gates attention via gamma."
//
// Performance posture:
//   • Struct-of-arrays Float32/Int8 typed arrays — no per-neuron objects.
//   • Forward + reverse CSR built once at construction (transposed in O(E)).
//   • Hot loops never allocate. Vector / matrix / colour scratch lives on the
//     instance.
//   • Fixed 2 ms LIF substep, capped at 16 substeps per frame so a paused
//     tab can't drown in catch-up steps.
//   • Visual pulses are decoupled from synaptic transmission: the simulation
//     always delivers current; the visual pool just caps how many spikes get
//     a glowing dot rendered along their pathway.

import { ACTION_BY_ID, REGION_INDEX } from "./brainRegions";
import { LOGICAL_REGION_MAP } from "./logicalRegions";
import type { LogicalRegionId } from "../../shared/pipeline";
import type { CognitiveState } from "./cognitiveStates";
import type {
  BrainActionId,
  BrainRegionId,
  NeuralGraph,
  SignalPulse,
} from "./types";

// ────────────────────────────────────────────────────────────────────────────
// Biological constants. Values are typical of layer-2/3 pyramidal cells and
// fast-spiking interneurons unless noted. Membrane voltages are in millivolts;
// time constants in seconds.
// ────────────────────────────────────────────────────────────────────────────

const TAU_M_EXC = 0.020;            // 20 ms — pyramidal cell membrane τ
const TAU_M_INH = 0.010;            // 10 ms — fast-spiking interneuron τ

const V_REST = -70.0;
const V_RESET = -75.0;              // after-spike hyperpolarization
const V_THRESHOLD = -52.0;          // ~18 mV above rest is a typical threshold

const REFRACTORY_EXC = 0.002;       // 2 ms
const REFRACTORY_INH = 0.001;       // 1 ms

// Synaptic kernel: single-exponential decay of post-synaptic current.
const TAU_SYN_EXC = 0.005;          // AMPA-like (≈5 ms)
const TAU_SYN_INH = 0.010;          // GABA-A-like (≈10 ms)

const EXCITATORY_FRACTION = 0.80;   // 80/20 cortical-style E/I balance

// Synaptic weight scaling. The big inhibitory gain is what lets a 20%
// interneuron population balance the 80% excitatory drive.
const W_EXC_INIT = 0.35;
const W_EXC_MIN = 0.02;
const W_EXC_MAX = 1.30;
const W_INH_GAIN = 4.0;             // inhibitory weights are 4× excitatory

// External drive. The background current keeps every neuron near threshold so
// the network has the spontaneous low-rate firing real cortex shows; the
// per-region drive adds an action-specific kick on top.
const I_BACKGROUND_BASE = 12.0;     // mV-equivalent steady push toward threshold
const I_DRIVE_GAIN = 14.0;          // additional drive when a region is "active"
const I_NOISE = 6.5;                // Gaussian-ish noise amplitude

// STDP (online, trace-based).
const TAU_TRACE_PRE = 0.020;
const TAU_TRACE_POST = 0.020;
const A_PLUS_BASE = 0.0040;         // LTP step (per unit trace)
const A_MINUS_BASE = 0.0045;        // LTD slightly larger — guards against runaway potentiation

// Neuromodulators. Both decay toward their baselines so phasic boosts wear
// off naturally. Dopamine baseline ~0.3 keeps default learning rate modest.
const DA_BASELINE = 0.30;
const DA_DECAY_PER_SEC = 0.55;
const ACH_BASELINE = 0.40;
const ACH_DECAY_PER_SEC = 0.55;

// Oscillations.
const THETA_HZ = 6.0;
const GAMMA_HZ = 40.0;
const THETA_AMPLITUDE = 2.6;        // base amplitude of theta drive (mV-equiv)
const GAMMA_AMPLITUDE = 1.5;

// Integration / pool sizing.
const SUB_DT = 0.002;               // 2 ms LIF substep
const MAX_SUBSTEPS = 16;
const DEFAULT_MAX_PULSES = 260;

// Visual pulses are eye-candy; the simulation still delivers synaptic current
// for every outgoing connection on a spike. We just cap how many of those
// get a glowing dot, otherwise the renderer pool would saturate instantly.
const VISUAL_PULSES_PER_SPIKE_MAX = 3;
const VISUAL_PULSE_BASE_SPEED = 2.4;       // 1/seconds — pulse traverses ~once / 0.4 s
const VISUAL_PULSE_SPEED_JITTER = 1.0;

// Spike-rate smoothing for the visualization "region intensity" channel.
const REGION_ACTIVITY_RISE = 0.45;  // EMA toward fresh activity
const REGION_ACTIVITY_DECAY = 0.05; // base ^ deltaSeconds — fast decay so panel feels responsive

// Module-scope scratch used by SpikingEngine.fire() to pick which outgoing
// synapses get a visual pulse on each spike. Size is fixed at the spike-cap
// constant so we never reallocate during simulation.
const visualScratch = new Int32Array(VISUAL_PULSES_PER_SPIKE_MAX);

function mulberry32(seed: number): () => number {
  return () => {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller transform for ~N(0,1) noise. We use it for membrane noise so the
// drive isn't uniformly distributed — real synaptic input has Gaussian-ish
// fluctuations and the spike timing distribution comes out more realistic.
function gaussian(random: () => number): number {
  const u = Math.max(1e-9, random());
  const v = random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// ────────────────────────────────────────────────────────────────────────────
// Engine
// ────────────────────────────────────────────────────────────────────────────

export class SpikingEngine {
  // ── Public state mirroring SignalSimulation, read by NeuralGraph ──────────
  // Identity is *not* readonly: setGraph() may swap these out when the
  // neuron / pathway count changes (e.g. density slider tick).
  regionIntensity: Float32Array;
  regionFlashIntensity: Float32Array;
  pathwayIntensity: Float32Array;
  readonly pulses: SignalPulse[] = [];

  // ── Extra public state useful for visualization / debugging ───────────────
  // Vm normalised to [0,1]: 0 ≈ V_RESET, 1 ≈ V_THRESHOLD. Renderer can lerp
  // a per-neuron colour off this if it wants membrane-potential heatmap.
  membranePotentialNorm: Float32Array;
  // Per-neuron type: 1 = excitatory, -1 = inhibitory.
  neuronType: Int8Array;
  // Total spikes since construction (epoch counter for the UI).
  spikeCount = 0;

  // ── Memory-channel mirror (hippocampal glow tied to retrieval count) ──────
  private _memoryIntensity = 0;
  get memoryIntensity(): number {
    return this._memoryIntensity;
  }

  // ── Engine config ─────────────────────────────────────────────────────────
  private graph: NeuralGraph;
  private actionId: BrainActionId;
  private running = true;
  private speed = 1;
  private maxPulses = DEFAULT_MAX_PULSES;
  private nextPulseId = 1;
  private readonly random: () => number;

  // ── Neuron arrays (struct-of-arrays) ──────────────────────────────────────
  private V!: Float32Array;             // membrane potential (mV)
  private iSynExc!: Float32Array;       // current excitatory synaptic input
  private iSynInh!: Float32Array;       // current inhibitory synaptic input
  private tauM!: Float32Array;          // membrane time constant per neuron
  private refractoryUntil!: Float32Array;
  private refractoryDur!: Float32Array;
  private xPre!: Float32Array;          // STDP pre-trace per neuron
  private xPost!: Float32Array;         // STDP post-trace per neuron
  private regionIdx!: Int16Array;       // region index per neuron
  private excitability!: Float32Array;  // per-neuron excitability multiplier

  // ── Forward CSR (outgoing synapses) ───────────────────────────────────────
  private outOffset!: Uint32Array;      // (n+1) — outOffset[i]..outOffset[i+1] = synapses leaving neuron i
  private outTarget!: Uint32Array;
  private outWeight!: Float32Array;
  private outPathway!: Uint32Array;     // index into graph.pathways for visual pulse spawn

  // ── Reverse CSR (incoming synapses) ───────────────────────────────────────
  private inOffset!: Uint32Array;       // (n+1)
  private inSource!: Uint32Array;
  private inSynapseIdx!: Uint32Array;   // index into outTarget/outWeight (so LTP updates the same weight)

  // ── Region-driven drive set by setAction(). ───────────────────────────────
  private regionDrive!: Float32Array;

  // ── Neuromodulator and oscillation state ──────────────────────────────────
  private dopamine = DA_BASELINE;
  private acetylcholine = ACH_BASELINE;
  private thetaPhase = 0;
  private gammaPhase = 0;
  private thetaGain = 1.0;
  private gammaGain = 1.0;
  // Per-region oscillation routing: how strongly each region listens to
  // theta vs gamma. Real brains: hippocampus → theta; sensory cortex → gamma.
  private regionThetaWeight!: Float32Array;
  private regionGammaWeight!: Float32Array;

  // ── Region activity EMA used for the visual regionIntensity channel ──────
  private regionActivity!: Float32Array;

  // ── Scratch ───────────────────────────────────────────────────────────────
  private elapsed = 0;

  constructor(graph: NeuralGraph, actionId: BrainActionId, seed = 91) {
    this.random = mulberry32(seed);
    this.graph = graph;
    this.actionId = actionId;
    this.regionIntensity = new Float32Array(graph.regionOrder.length);
    this.regionFlashIntensity = new Float32Array(graph.regionOrder.length);
    this.pathwayIntensity = new Float32Array(graph.pathways.length);
    this.membranePotentialNorm = new Float32Array(graph.nodes.length);
    this.neuronType = new Int8Array(graph.nodes.length);
    this.buildFromGraph(graph);
    this.applyAction(actionId);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Public API (SignalSimulation-compatible)
  // ──────────────────────────────────────────────────────────────────────

  setGraph(graph: NeuralGraph): void {
    this.graph = graph;
    this.pulses.length = 0;
    this.nextPulseId = 1;
    // Region / pathway / neuron counts may all differ — reallocate the
    // visible Float32 channels so the renderer's index math stays sound.
    this.regionIntensity = new Float32Array(graph.regionOrder.length);
    this.regionFlashIntensity = new Float32Array(graph.regionOrder.length);
    this.pathwayIntensity = new Float32Array(graph.pathways.length);
    this.membranePotentialNorm = new Float32Array(graph.nodes.length);
    this.neuronType = new Int8Array(graph.nodes.length);
    this.buildFromGraph(graph);
    this.applyAction(this.actionId);
  }

  setAction(actionId: BrainActionId): void {
    if (this.actionId === actionId) {
      return;
    }
    this.actionId = actionId;
    // applyAction() clears regionDrive entirely. If a CognitiveState had
    // added extraDrive on top, callers must re-apply it after switching
    // actions. (Modulators / oscillation gains are NOT cleared.)
    this.applyAction(actionId);
    // A small phasic dopamine bump on action switch — proxies the
    // anticipatory ramp seen when monkeys are cued for a new task.
    this.dopamine = Math.min(1, this.dopamine + 0.25);
  }

  setRunning(running: boolean): void {
    this.running = running;
  }

  setSpeed(speed: number): void {
    this.speed = Math.max(0, speed);
  }

  setMaxPulses(maxPulses: number): void {
    this.maxPulses = Math.max(20, Math.round(maxPulses));
  }

  setMemoryIntensity(count: number): void {
    this._memoryIntensity = Math.min(1, count / 500);
  }

  flashRegions(regionIds: BrainRegionId[], magnitude = 0.85): void {
    for (const regionId of regionIds) {
      const index = this.graph.regionOrder.indexOf(regionId);
      if (index < 0) {
        continue;
      }
      if (this.regionFlashIntensity[index] < magnitude) {
        this.regionFlashIntensity[index] = magnitude;
      }
    }
  }

  flashLogicalRegion(id: LogicalRegionId, magnitude = 0.85): void {
    const regions = LOGICAL_REGION_MAP[id];
    if (regions) {
      this.flashRegions(regions, magnitude);
    }
  }

  step(deltaSeconds: number, elapsedSeconds: number): void {
    this.elapsed = elapsedSeconds;

    // Visual channels decay every frame regardless of run state so the brain
    // settles cleanly when paused.
    const flashDecay = Math.pow(0.18, deltaSeconds);
    const activityDecay = Math.pow(REGION_ACTIVITY_DECAY, deltaSeconds);
    const pathwayDecay = Math.pow(0.08, deltaSeconds);

    for (let i = 0; i < this.regionIntensity.length; i += 1) {
      this.regionFlashIntensity[i] *= flashDecay;
      this.regionActivity[i] *= activityDecay;
      // regionIntensity = recent spike activity + hippocampal memory channel.
      // We rewrite it from scratch each frame (instead of decaying in place)
      // because regionActivity is already an EMA.
      this.regionIntensity[i] = this.regionActivity[i];
    }

    for (let i = 0; i < this.pathwayIntensity.length; i += 1) {
      this.pathwayIntensity[i] *= pathwayDecay;
    }

    this._memoryIntensity *= Math.pow(0.92, deltaSeconds);

    // Decay neuromodulators toward their baselines.
    const daRate = Math.pow(DA_DECAY_PER_SEC, deltaSeconds);
    const achRate = Math.pow(ACH_DECAY_PER_SEC, deltaSeconds);
    this.dopamine = DA_BASELINE + (this.dopamine - DA_BASELINE) * daRate;
    this.acetylcholine = ACH_BASELINE + (this.acetylcholine - ACH_BASELINE) * achRate;

    // Memory channel keeps hippocampal regions visibly lit during recall.
    if (this._memoryIntensity > 0.005) {
      const hippoL = REGION_INDEX["hippocampus-l"];
      const hippoR = REGION_INDEX["hippocampus-r"];
      const m = this._memoryIntensity * 0.72;
      if (hippoL !== undefined) {
        this.regionIntensity[hippoL] = Math.max(this.regionIntensity[hippoL], m);
      }
      if (hippoR !== undefined) {
        this.regionIntensity[hippoR] = Math.max(this.regionIntensity[hippoR], m);
      }
    }

    // Advance visual pulses — they live in display time, not biological time.
    this.advanceVisualPulses(deltaSeconds);

    if (!this.running || this.speed <= 0) {
      return;
    }

    // Fixed-step LIF integration. Effective simulation time per frame is
    // deltaSeconds × speed; we floor the substep count and run that many
    // 2 ms ticks. A paused tab can't dump >MAX_SUBSTEPS catch-up steps.
    const wantedTime = deltaSeconds * this.speed;
    const substeps = Math.max(1, Math.min(MAX_SUBSTEPS, Math.ceil(wantedTime / SUB_DT)));
    const subDt = wantedTime / substeps;

    for (let s = 0; s < substeps; s += 1) {
      this.integrate(subDt);
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // SpikingEngine-specific helpers (call these to expose neuromod / state
  // overlay on top of the standard action selection).
  // ──────────────────────────────────────────────────────────────────────

  setDopamine(level: number): void {
    this.dopamine = Math.max(0, Math.min(1, level));
  }

  setAcetylcholine(level: number): void {
    this.acetylcholine = Math.max(0, Math.min(1, level));
  }

  setOscillationGains(theta: number, gamma: number): void {
    this.thetaGain = Math.max(0, theta);
    this.gammaGain = Math.max(0, gamma);
  }

  applyCognitiveState(state: CognitiveState): void {
    if (state.dopamine !== undefined) {
      this.setDopamine(state.dopamine);
    }
    if (state.acetylcholine !== undefined) {
      this.setAcetylcholine(state.acetylcholine);
    }
    this.setOscillationGains(state.thetaGain ?? 1.0, state.gammaGain ?? 1.0);

    if (state.extraDrive) {
      for (const [regionId, drive] of state.extraDrive) {
        const idx = this.graph.regionOrder.indexOf(regionId);
        if (idx >= 0) {
          this.regionDrive[idx] = Math.max(this.regionDrive[idx], drive);
        }
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Construction
  // ──────────────────────────────────────────────────────────────────────

  private buildFromGraph(graph: NeuralGraph): void {
    const n = graph.nodes.length;

    this.V = new Float32Array(n);
    this.iSynExc = new Float32Array(n);
    this.iSynInh = new Float32Array(n);
    this.tauM = new Float32Array(n);
    this.refractoryUntil = new Float32Array(n);
    this.refractoryDur = new Float32Array(n);
    this.xPre = new Float32Array(n);
    this.xPost = new Float32Array(n);
    this.regionIdx = new Int16Array(n);
    this.excitability = new Float32Array(n);

    const regionCount = graph.regionOrder.length;
    this.regionDrive = new Float32Array(regionCount);
    this.regionActivity = new Float32Array(regionCount);
    this.regionThetaWeight = new Float32Array(regionCount);
    this.regionGammaWeight = new Float32Array(regionCount);

    // Per-region oscillation routing. Hippocampus and PFC ride theta;
    // sensory cortices and parietal favour gamma; subcortical structures
    // mostly ignore both (apart from a small thalamic gamma component).
    for (let r = 0; r < regionCount; r += 1) {
      const regionId = graph.regionOrder[r];
      this.regionThetaWeight[r] = oscWeights(regionId).theta;
      this.regionGammaWeight[r] = oscWeights(regionId).gamma;
    }

    // Assign E/I, initialise membrane state.
    for (let i = 0; i < n; i += 1) {
      const isExc = this.random() < EXCITATORY_FRACTION;
      this.neuronType[i] = isExc ? 1 : -1;
      this.tauM[i] = isExc ? TAU_M_EXC : TAU_M_INH;
      this.refractoryDur[i] = isExc ? REFRACTORY_EXC : REFRACTORY_INH;
      this.V[i] = V_REST + (this.random() - 0.5) * 4.0; // small jitter
      this.regionIdx[i] = graph.nodes[i].regionIndex;
      // Per-neuron excitability lognormal-ish — gives a long tail of
      // hyperactive cells, characteristic of real cortex.
      this.excitability[i] = 0.85 + this.random() * 0.45;
    }

    // ── Build forward CSR. Each pathway becomes one directional synapse.
    // We count outgoing degree per neuron, prefix-sum, then fill.
    const synapseCount = graph.pathways.length;
    const outDegree = new Uint32Array(n);
    for (let p = 0; p < synapseCount; p += 1) {
      outDegree[graph.pathways[p].source] += 1;
    }
    this.outOffset = new Uint32Array(n + 1);
    let cursor = 0;
    for (let i = 0; i < n; i += 1) {
      this.outOffset[i] = cursor;
      cursor += outDegree[i];
      outDegree[i] = 0; // reused as fill cursor
    }
    this.outOffset[n] = cursor;

    this.outTarget = new Uint32Array(synapseCount);
    this.outWeight = new Float32Array(synapseCount);
    this.outPathway = new Uint32Array(synapseCount);

    // ── Build reverse CSR (incoming synapses) by transposing the forward CSR.
    const inDegree = new Uint32Array(n);
    for (let p = 0; p < synapseCount; p += 1) {
      inDegree[graph.pathways[p].target] += 1;
    }
    this.inOffset = new Uint32Array(n + 1);
    cursor = 0;
    for (let i = 0; i < n; i += 1) {
      this.inOffset[i] = cursor;
      cursor += inDegree[i];
      inDegree[i] = 0;
    }
    this.inOffset[n] = cursor;
    this.inSource = new Uint32Array(synapseCount);
    this.inSynapseIdx = new Uint32Array(synapseCount);

    for (let p = 0; p < synapseCount; p += 1) {
      const pathway = graph.pathways[p];
      const src = pathway.source;
      const dst = pathway.target;

      const fwdPos = this.outOffset[src] + outDegree[src];
      outDegree[src] += 1;
      this.outTarget[fwdPos] = dst;
      // Initial weight nudged by pathway.strength so the graph's bundle
      // weights translate into the spiking layer.
      this.outWeight[fwdPos] = W_EXC_INIT * pathway.strength;
      this.outPathway[fwdPos] = p;

      const revPos = this.inOffset[dst] + inDegree[dst];
      inDegree[dst] += 1;
      this.inSource[revPos] = src;
      this.inSynapseIdx[revPos] = fwdPos;
    }

    this.spikeCount = 0;
  }

  // Set the per-region external drive vector from an action definition.
  private applyAction(actionId: BrainActionId): void {
    const action = ACTION_BY_ID[actionId];
    this.regionDrive.fill(0);
    for (const regionId of action.activeRegions) {
      const idx = this.graph.regionOrder.indexOf(regionId);
      if (idx >= 0) {
        this.regionDrive[idx] = 1.0;
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Inner loop: one LIF substep.
  // ──────────────────────────────────────────────────────────────────────

  private integrate(dt: number): void {
    const n = this.V.length;
    const t = this.elapsed;

    // Advance global oscillation phases.
    this.thetaPhase = (this.thetaPhase + 2 * Math.PI * THETA_HZ * dt) % (2 * Math.PI);
    this.gammaPhase = (this.gammaPhase + 2 * Math.PI * GAMMA_HZ * dt) % (2 * Math.PI);
    const thetaSignal = Math.sin(this.thetaPhase) * THETA_AMPLITUDE * this.thetaGain;
    const gammaSignal = Math.sin(this.gammaPhase) * GAMMA_AMPLITUDE * this.gammaGain;

    // Effective neuromodulator scalars for this substep.
    // ACh raises gain (sharpens responses, lowers spontaneous noise).
    const achGain = 0.7 + this.acetylcholine * 0.9;
    const noiseScale = I_NOISE * (1.2 - this.acetylcholine * 0.7);
    // DA gates plasticity and adds a mild tonic excitability boost.
    const daBoost = (this.dopamine - DA_BASELINE) * 4.0;
    const aPlus = A_PLUS_BASE * (0.4 + this.dopamine * 1.8);
    const aMinus = A_MINUS_BASE * (0.4 + this.dopamine * 1.8);

    // Decay synaptic currents and STDP traces. We use exact exponentials so
    // the decay is independent of step size.
    const excDecay = Math.exp(-dt / TAU_SYN_EXC);
    const inhDecay = Math.exp(-dt / TAU_SYN_INH);
    const xPreDecay = Math.exp(-dt / TAU_TRACE_PRE);
    const xPostDecay = Math.exp(-dt / TAU_TRACE_POST);

    for (let i = 0; i < n; i += 1) {
      this.iSynExc[i] *= excDecay;
      this.iSynInh[i] *= inhDecay;
      this.xPre[i] *= xPreDecay;
      this.xPost[i] *= xPostDecay;
    }

    // Integrate Vm and detect spikes.
    for (let i = 0; i < n; i += 1) {
      if (t < this.refractoryUntil[i]) {
        this.V[i] = V_RESET;
        this.membranePotentialNorm[i] = 0;
        continue;
      }

      const region = this.regionIdx[i];
      const drive = this.regionDrive[region];
      const oscDrive =
        thetaSignal * this.regionThetaWeight[region] +
        gammaSignal * this.regionGammaWeight[region];

      // External drive = baseline + action drive + oscillation + Gaussian noise.
      const iExt =
        (I_BACKGROUND_BASE + daBoost) * this.excitability[i] +
        I_DRIVE_GAIN * drive * achGain +
        oscDrive +
        gaussian(this.random) * noiseScale;

      // Net synaptic input (exc positive, inh negative).
      const iSyn = this.iSynExc[i] - this.iSynInh[i];

      // dV/dt = -(V - V_rest)/τ_m + (iSyn + iExt) / τ_m_norm
      // We fold τ_m into the integration to keep units self-consistent.
      const leak = -(this.V[i] - V_REST) / this.tauM[i];
      // The synaptic + external currents are treated as "scaled current" —
      // numerically convenient: 1 unit ≈ 1 mV / τ_m for a quick perceptual map.
      const drivedV = (iSyn + iExt) / this.tauM[i];

      this.V[i] += (leak + drivedV) * dt;

      if (this.V[i] >= V_THRESHOLD) {
        this.fire(i, t, aPlus, aMinus);
        this.membranePotentialNorm[i] = 1;
      } else {
        // Normalise Vm to [0,1] for renderer convenience.
        this.membranePotentialNorm[i] =
          Math.max(0, Math.min(1, (this.V[i] - V_RESET) / (V_THRESHOLD - V_RESET)));
      }
    }
  }

  // Handle a neuron firing: refractory + reset, dispatch to outgoing synapses
  // (delivering current + LTD), apply LTP to incoming synapses, update traces,
  // bookkeeping for the visualization layer.
  private fire(neuron: number, t: number, aPlus: number, aMinus: number): void {
    this.V[neuron] = V_RESET;
    this.refractoryUntil[neuron] = t + this.refractoryDur[neuron];
    this.spikeCount += 1;
    const sign = this.neuronType[neuron]; // +1 / -1

    // ── Outgoing: deliver current to each target + LTD on this synapse.
    const outStart = this.outOffset[neuron];
    const outEnd = this.outOffset[neuron + 1];
    const outDeg = outEnd - outStart;

    // Pick which outgoing slots get a visual pulse. We choose up to N evenly-
    // spaced slots from [0, outDeg) starting at a random offset, then sort
    // ascending so we can match them in lockstep with the forward iteration
    // below. (Sorted-match also means O(outDeg) — no inner search.)
    const visualCount = Math.min(VISUAL_PULSES_PER_SPIKE_MAX, outDeg);
    const visualSlots = visualScratch;
    if (visualCount > 0) {
      const stride = outDeg / visualCount;
      const startOffset = Math.floor(this.random() * outDeg);
      for (let k = 0; k < visualCount; k += 1) {
        visualSlots[k] = Math.floor(startOffset + k * stride) % outDeg;
      }
      // Tiny in-place sort — visualCount is always ≤ VISUAL_PULSES_PER_SPIKE_MAX
      // so insertion sort is unbeatable here.
      for (let k = 1; k < visualCount; k += 1) {
        const v = visualSlots[k];
        let j = k - 1;
        while (j >= 0 && visualSlots[j] > v) {
          visualSlots[j + 1] = visualSlots[j];
          j -= 1;
        }
        visualSlots[j + 1] = v;
      }
    }
    let visualCursor = 0;

    for (let s = outStart; s < outEnd; s += 1) {
      const target = this.outTarget[s];
      const wRaw = this.outWeight[s];

      // Inhibitory synapses inject GABA current; excitatory inject AMPA.
      if (sign > 0) {
        this.iSynExc[target] += wRaw;
      } else {
        this.iSynInh[target] += wRaw * W_INH_GAIN;
      }

      // LTD: post-fired-before-pre → weaken. Only meaningful for excitatory
      // synapses (inhibitory plasticity has different rules; we skip for
      // simplicity and biological correctness — inhibitory STDP is its own
      // research area).
      if (sign > 0) {
        const dW = -aMinus * this.xPost[target];
        const newW = this.outWeight[s] + dW;
        this.outWeight[s] = newW < W_EXC_MIN ? W_EXC_MIN : (newW > W_EXC_MAX ? W_EXC_MAX : newW);
      }

      // Spawn a visual pulse for the pre-chosen sparse subset of outgoing
      // synapses. The pulse pool cap means heavy traffic gracefully drops new
      // visuals without ever stalling the simulation.
      const slotIdx = s - outStart;
      if (visualCursor < visualCount && slotIdx === visualSlots[visualCursor]) {
        visualCursor += 1;
        if (this.pulses.length < this.maxPulses) {
          this.spawnVisualPulse(this.outPathway[s], sign);
        }
      }
    }

    // ── Incoming: LTP on every synapse landing on this neuron.
    // Only excitatory pre-neurons get plasticity (same reason as above).
    const inStart = this.inOffset[neuron];
    const inEnd = this.inOffset[neuron + 1];
    for (let s = inStart; s < inEnd; s += 1) {
      const source = this.inSource[s];
      if (this.neuronType[source] < 0) {
        continue;
      }
      const synIdx = this.inSynapseIdx[s];
      const dW = aPlus * this.xPre[source];
      const newW = this.outWeight[synIdx] + dW;
      this.outWeight[synIdx] = newW < W_EXC_MIN ? W_EXC_MIN : (newW > W_EXC_MAX ? W_EXC_MAX : newW);
    }

    // Update this neuron's own traces. The +1 on the trace is the trace
    // "spike" — it then decays each substep on its own.
    if (sign > 0) {
      this.xPre[neuron] += 1.0;
    }
    this.xPost[neuron] += 1.0;

    // Region activity EMA — what the renderer ultimately reads as the
    // glow level.
    const region = this.regionIdx[neuron];
    const current = this.regionActivity[region];
    // Each spike contributes a small amount; lots of spikes per frame
    // approach saturation but never exceed 1.
    const contribution = sign > 0 ? 0.06 : 0.025;
    this.regionActivity[region] = current + (1 - current) * Math.min(1, contribution * REGION_ACTIVITY_RISE * 20);
  }

  // Push a new visual pulse along the named pathway. The renderer only
  // cares about pathwayIndex/fromNode/toNode/progress/intensity/colour;
  // velocity controls how fast the dot moves across the line.
  // Pulses travel source→target along the pathway's natural direction; the
  // calling site already knows that, so we don't take from/to as params.
  private spawnVisualPulse(pathwayIndex: number, sign: number): void {
    const pathway = this.graph.pathways[pathwayIndex];
    const sourceRegionIndex = pathway.sourceRegionIndex;
    const sourceRegionId = pathway.sourceRegionId;
    const velocity = VISUAL_PULSE_BASE_SPEED + this.random() * VISUAL_PULSE_SPEED_JITTER;
    // Inhibitory spikes get a slightly dimmer pulse — visually distinguishes
    // GABAergic transmission without needing a separate render layer.
    const intensity = sign > 0 ? 0.7 + this.random() * 0.3 : 0.45 + this.random() * 0.2;

    this.pulses.push({
      id: this.nextPulseId,
      pathwayIndex,
      fromNode: pathway.source,
      toNode: pathway.target,
      progress: 0,
      velocity,
      intensity,
      colorRegionId: sourceRegionId,
      colorRegionIndex: sourceRegionIndex,
      reverse: false,
    });
    this.nextPulseId += 1;

    // Pathway intensity is the channel NeuralGraph reads to light the line up.
    this.pathwayIntensity[pathwayIndex] = Math.max(
      this.pathwayIntensity[pathwayIndex],
      intensity,
    );
  }

  // Advance every live visual pulse along its pathway; drop when t≥1.
  // Visual pulses are pure display state — they don't deliver current
  // (that already happened at spawn time). Pathway intensity is sustained
  // while the pulse is in transit so the line glows under it.
  private advanceVisualPulses(deltaSeconds: number): void {
    for (let i = this.pulses.length - 1; i >= 0; i -= 1) {
      const pulse = this.pulses[i];
      pulse.progress += deltaSeconds * pulse.velocity * this.speed;

      const sustain = pulse.intensity * (0.35 + Math.sin(Math.min(1, pulse.progress) * Math.PI) * 0.5);
      if (this.pathwayIntensity[pulse.pathwayIndex] < sustain) {
        this.pathwayIntensity[pulse.pathwayIndex] = sustain;
      }

      if (pulse.progress >= 1) {
        // O(1) removal: swap with last, pop.
        const last = this.pulses.pop()!;
        if (i < this.pulses.length) {
          this.pulses[i] = last;
        }
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Per-region oscillation routing. These are coarse functional weights — feel
// free to refine with connectome data later.
// ────────────────────────────────────────────────────────────────────────────
function oscWeights(regionId: BrainRegionId): { theta: number; gamma: number } {
  // Hippocampus is the classic theta generator (4-8 Hz "θ-rhythm").
  if (regionId === "hippocampus-l" || regionId === "hippocampus-r") {
    return { theta: 1.5, gamma: 0.3 };
  }
  // Prefrontal cortex carries strong theta during working memory + control.
  if (regionId === "prefrontal-l" || regionId === "prefrontal-r") {
    return { theta: 0.9, gamma: 0.7 };
  }
  // Sensory + association cortices favour gamma (perceptual binding).
  if (
    regionId === "occipital-l" || regionId === "occipital-r" ||
    regionId === "auditory-l" || regionId === "auditory-r" ||
    regionId === "somatosensory-l" || regionId === "somatosensory-r" ||
    regionId === "parietal-l" || regionId === "parietal-r"
  ) {
    return { theta: 0.2, gamma: 1.0 };
  }
  // Motor + frontal: a balanced mix (beta would be nice but we only ship 2 bands).
  if (
    regionId === "motor-l" || regionId === "motor-r" ||
    regionId === "frontal-l" || regionId === "frontal-r"
  ) {
    return { theta: 0.4, gamma: 0.7 };
  }
  // Thalamus pace-makes both bands but more weakly.
  if (regionId === "thalamus-l" || regionId === "thalamus-r") {
    return { theta: 0.5, gamma: 0.5 };
  }
  // Amygdala has its own theta during emotional learning.
  if (regionId === "amygdala-l" || regionId === "amygdala-r") {
    return { theta: 0.7, gamma: 0.3 };
  }
  // Basal ganglia, cerebellum, brainstem: don't ride cortical rhythms much.
  return { theta: 0.1, gamma: 0.1 };
}
