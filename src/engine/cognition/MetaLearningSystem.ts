// MetaLearningSystem — "learning to learn", IQ tracking, and self-optimisation
// ============================================================================
//
// Everything above this module makes the brain LEARN. This module makes the
// brain's learning GET BETTER OVER TIME, and measures whether it actually is.
// Four jobs, all running on slow, time-sliced cadences so they never touch the
// render frame:
//
//   1. COGNITIVE METRICS → composite "IQ". Six sub-scores (prediction accuracy,
//      stability/criticality, problem-solving, adaptation speed, creativity,
//      reasoning depth) are each z-scored against their own running statistics and
//      combined into one number scaled to ~mean 100 / sd 15. A separate HELD-OUT
//      PROBE score is reported but EXCLUDED from the optimiser's fitness — the
//      anti-Goodhart canary. (Honest caveat: "IQ" is whatever we chose to
//      measure; the probe is how we notice if the optimiser games it.)
//
//   2. NEURO-EVOLUTION. A small population of hyperparameter genomes is evaluated
//      ONLINE — one genome per ~8 s "episode" on the live brain (no expensive
//      network clone) — and bred by elitism + crossover + mutation. Fitness is
//      composite IQ. Every gene is bounded and SAFE (see GENOME_BOUNDS); the
//      just-stabilised E:I synaptic gains are deliberately NOT in the genome.
//
//   3. METAPLASTICITY (plasticity of plasticity). A BCM-style sliding threshold:
//      neurons that have been firing hard recently have their LTP turned DOWN
//      (homeostatic), written into the engine's per-neuron metaplastic array.
//
//   4. CONTINUAL LEARNING (anti-catastrophic-forgetting). An EWC-style per-synapse
//      importance map (a Fisher proxy) plus a gentle pull-back of important
//      synapses toward a consolidated checkpoint, interleaved with hippocampal
//      replay — so acquiring new skills doesn't overwrite old ones.

import type { AdvancedBrainCore } from "../AdvancedBrainCore";
import type { BrainEventBus } from "../BrainEventBus";
import { REGION_ORDER } from "../brainRegions";
import type { ReasoningEngine } from "./ReasoningEngine";
import type { ReinforcementSystem } from "./ReinforcementSystem";
import { clampGenome, defaultGenome, GENOME_BOUNDS, type Genome, type IQReport } from "./cognitionTypes";

const EPISODE_SEC = 8; // one genome is evaluated per episode of this length
const POPULATION = 6; // genomes per generation
const ELITE = 2; // top survivors copied unchanged each generation
const MUTATION_SIGMA = 0.18; // fraction of a gene's range used as mutation scale
const IQ_HISTORY_CAP = 240;

const EWC_LAMBDA = 0.05; // strength of the pull-back toward the checkpoint
const EWC_SLICE = 4096; // synapses processed per tick (time-slicing)
const IMPORTANCE_ALPHA = 0.02; // EMA rate for the Fisher-proxy importance

export class MetaLearningSystem {
  private readonly metrics = new CognitiveMetrics();

  // ── Neuro-evolution state ───────────────────────────────────────────────────
  private population: Genome[] = [];
  private fitness: number[] = [];
  private evalIndex = 0;
  private generation = 0;
  private champion: Genome = defaultGenome();
  private championFitness = -Infinity;

  // ── EWC / continual learning ────────────────────────────────────────────────
  private readonly ewcImportance: Float32Array;
  private readonly checkpoint: Float32Array;
  private importanceCursor = 0;

  private evalAccum = 0;

  constructor(
    private readonly core: AdvancedBrainCore,
    private readonly rl: ReinforcementSystem,
    private readonly reasoning: ReasoningEngine,
    private readonly bus: BrainEventBus,
  ) {
    const weights = core.getConnectomeWeights();
    this.ewcImportance = new Float32Array(weights.length);
    this.checkpoint = weights.slice();
    this.seedPopulation(defaultGenome());
    this.applyLiveGenome();
  }

  // ── Per-(budgeted)-tick update ──────────────────────────────────────────────

  tick(dtSeconds: number): void {
    this.metrics.accumulate(this.core, this.rl, this.reasoning, dtSeconds);
    this.writeMetaplasticity();
    this.accumulateImportance();

    this.evalAccum += dtSeconds;
    if (this.evalAccum >= EPISODE_SEC) {
      this.evalAccum = 0;
      this.endEpisode();
    }
  }

  /** Hybrid calls this after each System 2 pass so reasoning depth feeds the IQ. */
  noteReasoning(depth: number, confidence: number): void {
    this.metrics.noteReasoning(depth, confidence);
  }

  // ── Episode boundary: score, evolve, consolidate ────────────────────────────

  private endEpisode(): void {
    const report = this.metrics.compose();
    const fit = report.value;

    // Record this genome's fitness; track the all-time champion.
    this.fitness[this.evalIndex] = fit;
    if (fit > this.championFitness) {
      this.championFitness = fit;
      this.champion = { ...this.population[this.evalIndex] };
    }

    this.consolidate(); // EWC pull-back + replay (anti-forgetting)
    this.bus.emit("meta:iq", { value: report.value, components: report.components, probe: report.probe });

    // Advance to the next genome; breed a new generation when all are scored.
    this.evalIndex++;
    if (this.evalIndex >= this.population.length) {
      this.breedNextGeneration();
      this.evalIndex = 0;
    }
    this.applyLiveGenome();
  }

  // ── Neuro-evolution ─────────────────────────────────────────────────────────

  private seedPopulation(base: Genome): void {
    this.population = [base, ...Array.from({ length: POPULATION - 1 }, () => this.mutate(base))];
    this.fitness = new Array(POPULATION).fill(-Infinity);
  }

  private breedNextGeneration(): void {
    // Rank by fitness; keep the elite, fill the rest with mutated crossovers.
    const order = this.population
      .map((g, i) => ({ g, f: this.fitness[i] }))
      .sort((a, b) => b.f - a.f);

    const next: Genome[] = order.slice(0, ELITE).map((e) => ({ ...e.g }));
    const parents = order.slice(0, Math.max(ELITE, Math.ceil(POPULATION / 2)));
    while (next.length < POPULATION) {
      const a = parents[Math.floor(Math.random() * parents.length)].g;
      const b = parents[Math.floor(Math.random() * parents.length)].g;
      next.push(this.mutate(this.crossover(a, b)));
    }
    this.population = next;
    this.fitness = new Array(POPULATION).fill(-Infinity);
    this.generation++;
  }

  private crossover(a: Genome, b: Genome): Genome {
    const out = {} as Genome;
    for (const key of Object.keys(GENOME_BOUNDS) as Array<keyof Genome>) {
      out[key] = Math.random() < 0.5 ? a[key] : b[key];
    }
    return out;
  }

  private mutate(g: Genome): Genome {
    const out = { ...g };
    for (const key of Object.keys(GENOME_BOUNDS) as Array<keyof Genome>) {
      if (Math.random() < 0.5) {
        const [lo, hi] = GENOME_BOUNDS[key];
        out[key] += gaussian() * (hi - lo) * MUTATION_SIGMA;
      }
    }
    return clampGenome(out);
  }

  /** Push the currently-evaluated genome's genes to the subsystems that own them. */
  private applyLiveGenome(): void {
    const g = this.population[this.evalIndex] ?? this.champion;
    this.core.applyMetaTuning({
      plasticityScale: g.plasticityScale,
      dopamineBaseline: g.dopamineBaseline,
      acetylcholineBaseline: g.acetylcholineBaseline,
    });
    this.rl.setCuriosityWeight(g.curiosityWeight);
    this.reasoning.setExplorationTemp(g.explorationTemp);
  }

  /** The genome currently driving the brain (read by the arbiter each frame). */
  getLiveGenome(): Genome {
    return this.population[this.evalIndex] ?? this.champion;
  }

  getChampion(): Genome {
    return this.champion;
  }

  getGeneration(): number {
    return this.generation;
  }

  getIQReport(): IQReport {
    return this.metrics.lastReport();
  }

  // ── Metaplasticity (BCM sliding threshold) ──────────────────────────────────

  private writeMetaplasticity(): void {
    const burst = this.core.getBurstStatus();
    const meta = this.core.getMetaplasticArray();
    if (!burst) return;
    const n = Math.min(burst.length, meta.length);
    // High recent activity → raise the modification threshold → suppress LTP.
    for (let i = 0; i < n; i++) {
      const t = 1 - 0.7 * burst[i];
      meta[i] = t < 0.4 ? 0.4 : t > 1.2 ? 1.2 : t;
    }
  }

  // ── EWC importance + consolidation (continual learning) ─────────────────────

  /** Time-sliced EMA of |weight| → a cheap Fisher-proxy importance per synapse. */
  private accumulateImportance(): void {
    const w = this.core.getConnectomeWeights();
    const imp = this.ewcImportance;
    const len = w.length;
    if (len === 0) return;
    const end = Math.min(this.importanceCursor + EWC_SLICE, len);
    for (let s = this.importanceCursor; s < end; s++) {
      imp[s] += (Math.abs(w[s]) - imp[s]) * IMPORTANCE_ALPHA;
    }
    this.importanceCursor = end >= len ? 0 : end;
  }

  /**
   * Protect important, consolidated synapses: pull each weight a little toward the
   * checkpoint in proportion to its importance, then re-anchor the checkpoint. Old
   * knowledge resists being overwritten by new learning. Replay interleaves old
   * patterns alongside. (Fast & bounded: one pass over the weight array.)
   */
  private consolidate(): void {
    const w = this.core.getConnectomeWeights();
    const imp = this.ewcImportance;
    const ckpt = this.checkpoint;
    let maxImp = 1e-6;
    for (let s = 0; s < imp.length; s++) if (imp[s] > maxImp) maxImp = imp[s];

    for (let s = 0; s < w.length; s++) {
      const protect = (imp[s] / maxImp) * EWC_LAMBDA; // 0..EWC_LAMBDA
      w[s] += protect * (ckpt[s] - w[s]);
      ckpt[s] = w[s]; // re-anchor for the next episode
    }
    // Interleave replay of older episodic patterns during consolidation.
    this.core.triggerMemoryReplay();
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  exportGenome(): Genome {
    return { ...this.champion };
  }
  importGenome(g: Genome): void {
    this.champion = clampGenome(g);
    this.championFitness = -Infinity; // re-prove the restored champion
    this.seedPopulation(this.champion);
    this.evalIndex = 0;
    this.applyLiveGenome();
  }
  exportImportance(): Float32Array {
    return this.ewcImportance.slice();
  }
  importImportance(imp: Float32Array): void {
    if (imp.length === this.ewcImportance.length) this.ewcImportance.set(imp);
  }
  exportIqHistory(): number[] {
    return this.metrics.exportHistory();
  }
  importIqHistory(history: number[]): void {
    this.metrics.importHistory(history);
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  CognitiveMetrics — the composite-IQ machinery (folded inside this module)
// ════════════════════════════════════════════════════════════════════════════

/** Per-component running statistics for z-scoring. */
interface RunningStat {
  mean: number;
  var: number;
}

/** Weighting of each sub-score in the composite (problem-solving counts most). */
const COMPONENT_WEIGHTS: Record<string, number> = {
  predictionAccuracy: 1.0,
  stability: 1.0,
  problemSolving: 1.2,
  adaptationSpeed: 1.0,
  creativity: 0.8,
  reasoningDepth: 0.8,
};

class CognitiveMetrics {
  // Per-tick EMAs of each raw sub-score (the "current episode" value).
  private readonly ema: Record<string, number> = {
    predictionAccuracy: 0.5,
    stability: 0.5,
    problemSolving: 0,
    adaptationSpeed: 0.5,
    creativity: 0.5,
    reasoningDepth: 0,
  };
  private readonly stats: Record<string, RunningStat> = {};
  private samples = 0;
  private displayIq = 100;
  private probeEma = 0.5;
  private readonly history: number[] = [];
  private last: IQReport = { value: 100, components: {}, probe: 0.5, samples: 0 };

  constructor() {
    for (const key of Object.keys(COMPONENT_WEIGHTS)) this.stats[key] = { mean: 0, var: 1 };
  }

  /** Fold this tick's raw signals into the per-component EMAs. */
  accumulate(
    core: AdvancedBrainCore,
    rl: ReinforcementSystem,
    _reasoning: ReasoningEngine,
    dtSeconds: number,
  ): void {
    const a = Math.min(1, dtSeconds * 1.5);
    const fe = core.getFreeEnergy();

    const predictionAccuracy = 1 / (1 + 0.15 * fe);
    const stability = core.getCriticalityScore();
    const problemSolving = rl.getSuccessRate();
    const adaptationSpeed = 1 / (1 + 5 * rl.getRpeVolatility());
    const creativity = this.activationEntropy(core);

    this.ema.predictionAccuracy += (predictionAccuracy - this.ema.predictionAccuracy) * a;
    this.ema.stability += (stability - this.ema.stability) * a;
    this.ema.problemSolving += (problemSolving - this.ema.problemSolving) * a;
    this.ema.adaptationSpeed += (adaptationSpeed - this.ema.adaptationSpeed) * a;
    this.ema.creativity += (creativity - this.ema.creativity) * a;

    // Held-out probe: prediction-accuracy×stability on a SLOWER EMA, never part of
    // the optimiser's fitness — a canary for metric gaming.
    this.probeEma += (predictionAccuracy * stability - this.probeEma) * a * 0.3;
  }

  /** Record a System 2 deliberation's depth (decays between passes). */
  noteReasoning(depth: number, confidence: number): void {
    const score = Math.min(1, (depth / 3) * (0.5 + 0.5 * confidence));
    this.ema.reasoningDepth += (score - this.ema.reasoningDepth) * 0.3;
  }

  /** Produce a composite-IQ report and update the running statistics. */
  compose(): IQReport {
    this.samples++;
    let zsum = 0;
    let wsum = 0;
    const components: Record<string, number> = {};

    for (const key of Object.keys(COMPONENT_WEIGHTS)) {
      const x = this.ema[key];
      components[key] = x;
      const st = this.stats[key];
      // Update running mean/var (EMA) BEFORE z-scoring stabilises early samples.
      const d = x - st.mean;
      st.mean += d * 0.1;
      st.var += (d * d - st.var) * 0.1;
      const sd = Math.sqrt(Math.max(st.var, 1e-4));
      const z = clamp((x - st.mean) / sd, -3, 3);
      zsum += COMPONENT_WEIGHTS[key] * z;
      wsum += COMPONENT_WEIGHTS[key];
    }

    const weightedZ = wsum > 0 ? zsum / wsum : 0;
    // Until we have a few samples the z-scores are meaningless → hold at 100.
    const rawIq = this.samples < 3 ? 100 : clamp(100 + 15 * weightedZ, 40, 200);
    this.displayIq += (rawIq - this.displayIq) * 0.4; // smooth the headline number

    this.history.push(this.displayIq);
    if (this.history.length > IQ_HISTORY_CAP) this.history.shift();

    this.last = {
      value: this.displayIq,
      components,
      probe: this.probeEma,
      samples: this.samples,
    };
    return this.last;
  }

  lastReport(): IQReport {
    return this.last;
  }

  exportHistory(): number[] {
    return [...this.history];
  }
  importHistory(history: number[]): void {
    this.history.length = 0;
    for (const v of history.slice(-IQ_HISTORY_CAP)) this.history.push(v);
    if (this.history.length) this.displayIq = this.history[this.history.length - 1];
  }

  /** Normalised Shannon entropy of the region-activity distribution (creativity). */
  private activationEntropy(core: AdvancedBrainCore): number {
    const intensity = core.regionIntensity;
    let sum = 0;
    for (let i = 0; i < REGION_ORDER.length; i++) sum += intensity[i] ?? 0;
    if (sum < 1e-6) return 0;
    let h = 0;
    for (let i = 0; i < REGION_ORDER.length; i++) {
      const p = (intensity[i] ?? 0) / sum;
      if (p > 1e-6) h -= p * Math.log(p);
    }
    return h / Math.log(REGION_ORDER.length); // 0 (focused) … 1 (diffuse)
  }
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Standard-normal sample via Box–Muller. */
function gaussian(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
