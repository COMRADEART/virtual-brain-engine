// ─── Self-improving pathways (visible Hebbian plasticity) ────────────────────
//
// Both simulation engines learn — the spiking AdvancedBrainCore runs real
// trace-based STDP on its *neuron* synapses — but the PATHWAYS the renderer
// actually draws (via `pathwayIntensity`) were routed uniformly, so none of that
// self-organization was visible. This is a small, shared layer that makes the
// VISIBLE wiring self-improve: every pathway carries a learned weight that
//
//   • potentiates when a pulse successfully travels it ("fire together, wire
//     together"),
//   • relaxes back toward baseline when unused (so the map stays plastic, not
//     frozen),
//   • biases which pathway the next pulse takes (strong routes carry more
//     traffic — emergent communication channels),
//   • and keeps a faint persistent glow so a learned route reads as standing
//     structure between pulses, not just a transient flash.
//
// Pure, allocation-free on the hot paths, and deterministic given the rng you
// pass in — so it slots into the seeded SignalSimulation and the (Math.random)
// spiking engine alike. Bounded [1, maxWeight] so it can never run away.

export interface PathwayPlasticityOptions {
  /** Weight added per successful traversal (scaled by the call's amount). */
  potentiateRate?: number;
  /** Per-SECOND relaxation of (weight − 1) back toward the 1.0 baseline. */
  decayPerSecond?: number;
  /** Hard ceiling on a single pathway's learned weight. */
  maxWeight?: number;
  /** Peak persistent glow a fully-learned route holds between pulses. */
  glowFloor?: number;
}

export class PathwayPlasticity {
  /** Per-pathway learned weight, indexed by pathway id. Baseline 1.0. */
  readonly weight: Float32Array;

  private readonly potentiateRate: number;
  private readonly decayPerSecond: number;
  private readonly maxWeight: number;
  private readonly glowFloor: number;
  private readonly span: number; // maxWeight − 1, precomputed for normalization

  constructor(count: number, opts: PathwayPlasticityOptions = {}) {
    const n = Math.max(0, Math.floor(count));
    this.weight = new Float32Array(n).fill(1);
    this.potentiateRate = opts.potentiateRate ?? 0.06;
    this.decayPerSecond = opts.decayPerSecond ?? 0.8;
    this.maxWeight = Math.max(1.0001, opts.maxWeight ?? 4);
    this.glowFloor = opts.glowFloor ?? 0.16;
    this.span = this.maxWeight - 1;
  }

  /** Strengthen pathway `i` — call when a pulse actually traverses it. */
  potentiate(i: number, amount = 1): void {
    if (i < 0 || i >= this.weight.length) return;
    const w = this.weight[i] + this.potentiateRate * amount;
    this.weight[i] = w > this.maxWeight ? this.maxWeight : w;
  }

  /** Relax every weight toward baseline by `dt` seconds (homeostasis). */
  decay(dt: number): void {
    if (dt <= 0) return;
    const k = Math.pow(this.decayPerSecond, dt);
    const w = this.weight;
    for (let i = 0; i < w.length; i++) {
      // w → 1 + (w−1)*k. Skip the write when already at baseline (common).
      if (w[i] !== 1) w[i] = 1 + (w[i] - 1) * k;
    }
  }

  /** Learned strength of pathway `i`, normalized to [0,1]. */
  strength(i: number): number {
    if (i < 0 || i >= this.weight.length) return 0;
    return (this.weight[i] - 1) / this.span;
  }

  /** Persistent glow a learned route holds between pulses (0 at baseline). */
  floor(i: number): number {
    return this.strength(i) * this.glowFloor;
  }

  /**
   * Weighted choice among candidate pathway ids, biased by learned weight, using
   * the caller's rng (keeps the seeded engine deterministic). Returns −1 for an
   * empty candidate list. Allocation-free.
   */
  pick(candidates: readonly number[], rng: () => number): number {
    const n = candidates.length;
    if (n === 0) return -1;
    if (n === 1) return candidates[0];
    let total = 0;
    for (let i = 0; i < n; i++) total += this.weight[candidates[i]] ?? 1;
    if (total <= 0) return candidates[(rng() * n) | 0];
    let cursor = rng() * total;
    for (let i = 0; i < n; i++) {
      cursor -= this.weight[candidates[i]] ?? 1;
      if (cursor <= 0) return candidates[i];
    }
    return candidates[n - 1];
  }
}
