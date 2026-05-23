// RealisticConnectome — Human-Connectome-inspired directed wiring
// ===============================================================
//
// WHAT THIS BUILDS
// ----------------
// A directed synaptic graph over the neurons of a `NeuralGraph`, with four
// large-scale properties that real cortical connectomes exhibit (and which the
// Human Connectome Project quantified):
//
//   1. SMALL-WORLD topology  — dense local clustering + a few long-range
//      shortcuts, giving high clustering AND short path length. Built via a
//      Watts–Strogatz-style scheme: most synapses stay inside a neuron's local
//      neighbourhood; a minority are rewired to distant regions.
//   2. MODULAR structure     — anatomical regions act as modules; intra-region
//      density >> inter-region density.
//   3. RICH-CLUB hubs        — a small set of high-degree hubs (PFC, parietal,
//      thalamus, hippocampus) that preferentially interconnect, forming the
//      brain's structural "backbone".
//   4. DIRECTED edges        — i→k is distinct from k→i (with partial
//      reciprocity), and each edge carries the SIGN of its presynaptic neuron
//      (excitatory +1 / inhibitory −1), honouring Dale's principle.
//
// WHY CSR (compressed sparse row)
// -------------------------------
// The previous engine iterated *every* pathway for *every* spike — O(spikes × P)
// per step, which froze the main thread. Here the forward adjacency is stored as
// CSR: `outStart[i] .. outStart[i+1]` slices into `outTarget`/`weight`. Walking a
// neuron's synapses is then O(out-degree), so propagating a wavefront of spikes
// costs O(total synapses fired) per step — the only honest way to run a few
// thousand neurons at 60 fps in a browser.
//
// We also keep an INCOMING index (`inStart`/`inSyn`) so spike-timing-dependent
// plasticity can do potentiation at the *postsynaptic* spike (which needs each
// neuron's presynaptic edges) without an O(N²) reverse scan.
//
// All weights live in one `Float32Array` shared by both indices, so STDP mutates
// a single source of truth.

import { REGION_BY_ID, REGION_CONNECTIONS, REGION_INDEX } from "./brainRegions";
import type { BrainRegionId, NeuralGraph } from "./types";

/** Hubs of the structural rich-club — the brain's high-traffic backbone. */
export const RICH_CLUB_REGIONS: ReadonlySet<BrainRegionId> = new Set<BrainRegionId>([
  "prefrontal-l",
  "prefrontal-r",
  "parietal-l",
  "parietal-r",
  "thalamus-l",
  "thalamus-r",
  "hippocampus-l",
  "hippocampus-r",
]);

export interface ConnectomeOptions {
  /** Target mean out-degree (synapses per neuron). Auto-scaled down for huge N. */
  meanDegree?: number;
  /** Fraction of each neuron's synapses that are long-range (inter-region). */
  longRangeFraction?: number;
  /** Extra degree multiplier applied to rich-club hub neurons. */
  hubDegreeBoost?: number;
  /** Deterministic RNG seed. */
  seed?: number;
}

export interface ConnectomeStats {
  neuronCount: number;
  synapseCount: number;
  meanDegree: number;
  excitatoryFraction: number;
  longRangeFraction: number;
  hubRegionCount: number;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class RealisticConnectome {
  readonly neuronCount: number;
  readonly synapseCount: number;

  // ── Per-neuron ──────────────────────────────────────────────────────────
  /** Dale's-principle sign of each neuron: +1 excitatory, −1 inhibitory. */
  readonly neuronSign: Int8Array;

  // ── Forward CSR (presynaptic → postsynaptic), for spike propagation ───────
  /** outStart[i]..outStart[i+1] is neuron i's slice of outTarget/weight. */
  readonly outStart: Int32Array; // length N + 1
  /** Postsynaptic neuron index for each synapse. */
  readonly outTarget: Int32Array; // length S
  /** Plastic synaptic weight in [0,1]. Mutated in place by STDP. */
  readonly weight: Float32Array; // length S

  // ── Incoming index (postsynaptic → its presynaptic synapses), for STDP LTP ─
  readonly inStart: Int32Array; // length N + 1
  /** Synapse ids (indices into outTarget/weight) that terminate on each neuron. */
  readonly inSyn: Int32Array; // length S
  /** Presynaptic neuron index for each synapse (parallel to outTarget). */
  readonly synSource: Int32Array; // length S

  private readonly excitatoryCount: number;
  private readonly longRangeCount: number;

  constructor(graph: NeuralGraph, options: ConnectomeOptions = {}) {
    const N = graph.nodes.length;
    this.neuronCount = N;

    const rng = mulberry32(options.seed ?? 1337);

    // Scale degree down for very large populations so memory + per-step cost stay
    // bounded (a 10k-neuron graph at degree 24 is 240k synapses ≈ 2 MB of CSR).
    const requestedDegree = options.meanDegree ?? 22;
    const meanDegree = N > 6000 ? Math.max(10, Math.round(requestedDegree * 0.6)) : requestedDegree;
    const longRangeFraction = options.longRangeFraction ?? 0.18;
    const hubBoost = options.hubDegreeBoost ?? 1.6;

    // 1) Assign excitatory/inhibitory identity (Dale's principle). The cortical
    //    canon is ~80% excitatory / 20% inhibitory. Inhibitory neurons get
    //    shorter, more local axons (basket-cell-like), enforced below.
    this.neuronSign = new Int8Array(N);
    let excitatory = 0;
    for (let i = 0; i < N; i++) {
      const isExc = rng() < 0.8;
      this.neuronSign[i] = isExc ? 1 : -1;
      if (isExc) excitatory++;
    }
    this.excitatoryCount = excitatory;

    // Precompute, per region, the weighted list of regions it projects to. This
    // turns the anatomical adjacency (REGION_CONNECTIONS) + rich-club rule into a
    // fast weighted sampler for long-range targets.
    const longRangeTargets = this.buildLongRangeTargets();

    // 2) Build adjacency as growable arrays first, then flatten to CSR. Targets
    //    are de-duplicated per source via a small Set to avoid double synapses.
    const targetLists: number[][] = new Array(N);
    const weightLists: number[][] = new Array(N);
    let synapseCount = 0;
    let longRange = 0;

    for (let i = 0; i < N; i++) {
      const node = graph.nodes[i];
      const region = node.regionId;
      const range = graph.regionRanges[region];
      const isHub = RICH_CLUB_REGIONS.has(region);
      const isInhibitory = this.neuronSign[i] < 0;

      // Inhibitory interneurons project locally and densely; excitatory cells
      // carry the long-range traffic. Hubs get a degree boost.
      let degree = Math.round(meanDegree * (isHub ? hubBoost : 1));
      if (isInhibitory) degree = Math.max(4, Math.round(degree * 0.7));
      degree = Math.min(degree, Math.max(2, range.count - 1)); // can't exceed local pool sanity

      const targets: number[] = [];
      const weights: number[] = [];
      const seen = new Set<number>();
      seen.add(i); // no self-synapses

      // Long-range share is suppressed for inhibitory cells (kept local).
      const longShare = isInhibitory ? 0 : longRangeFraction;

      for (let e = 0; e < degree; e++) {
        const goLong = !isHub && !isInhibitory ? rng() < longShare : rng() < longShare * (isHub ? 1.8 : 1);
        let target = -1;

        if (goLong) {
          // Inter-region shortcut: pick a connected region by weight, then a
          // random neuron inside it. This is the Watts–Strogatz "rewire".
          const targetRegion = this.sampleLongRangeRegion(region, longRangeTargets, rng);
          if (targetRegion) {
            const tr = graph.regionRanges[targetRegion];
            if (tr && tr.count > 0) {
              target = tr.start + Math.floor(rng() * tr.count);
              if (!seen.has(target)) longRange++;
            }
          }
        }

        if (target < 0 || seen.has(target)) {
          // Local connection: sample within a sliding window around i to create
          // the clustered, distance-dependent wiring that yields small-world C.
          const window = Math.max(8, Math.floor(range.count * 0.25));
          const offsetInRegion = i - range.start;
          const signed = Math.floor((rng() * 2 - 1) * window);
          const localOffset = ((offsetInRegion + signed) % range.count + range.count) % range.count;
          target = range.start + localOffset;
        }

        if (target < 0 || seen.has(target)) continue;
        seen.add(target);
        targets.push(target);
        // Inhibitory synapses are a touch stronger so E/I balance is achievable
        // even at the 80/20 numeric ratio. Weights are in [0,1].
        const base = isInhibitory ? 0.55 + rng() * 0.45 : 0.35 + rng() * 0.5;
        weights.push(base);
        synapseCount++;
      }

      targetLists[i] = targets;
      weightLists[i] = weights;
    }

    this.synapseCount = synapseCount;
    this.longRangeCount = longRange;

    // 3) Flatten to forward CSR.
    this.outStart = new Int32Array(N + 1);
    this.outTarget = new Int32Array(synapseCount);
    this.weight = new Float32Array(synapseCount);
    this.synSource = new Int32Array(synapseCount);
    let cursor = 0;
    for (let i = 0; i < N; i++) {
      this.outStart[i] = cursor;
      const targets = targetLists[i];
      const weights = weightLists[i];
      for (let k = 0; k < targets.length; k++) {
        this.outTarget[cursor] = targets[k];
        this.weight[cursor] = weights[k];
        this.synSource[cursor] = i;
        cursor++;
      }
    }
    this.outStart[N] = cursor;

    // 4) Build the incoming index by counting in-degrees, then bucketing synapse
    //    ids by their target neuron (a stable counting-sort).
    this.inStart = new Int32Array(N + 1);
    this.inSyn = new Int32Array(synapseCount);
    for (let s = 0; s < synapseCount; s++) {
      this.inStart[this.outTarget[s] + 1]++;
    }
    for (let i = 0; i < N; i++) {
      this.inStart[i + 1] += this.inStart[i];
    }
    const fill = this.inStart.slice(); // mutable write cursors per neuron
    for (let s = 0; s < synapseCount; s++) {
      const target = this.outTarget[s];
      this.inSyn[fill[target]++] = s;
    }
  }

  /**
   * For each region, assemble the weighted set of regions it can send a
   * long-range axon to: anatomical neighbours (from REGION_CONNECTIONS) plus, for
   * rich-club regions, the other hubs (preferential hub-to-hub attachment).
   */
  private buildLongRangeTargets(): Map<BrainRegionId, { regions: BrainRegionId[]; cum: number[] }> {
    const adjacency = new Map<BrainRegionId, Map<BrainRegionId, number>>();
    const add = (a: BrainRegionId, b: BrainRegionId, w: number) => {
      let m = adjacency.get(a);
      if (!m) {
        m = new Map();
        adjacency.set(a, m);
      }
      m.set(b, (m.get(b) ?? 0) + w);
    };

    // REGION_CONNECTIONS is undirected [from, to, count]; project both ways.
    for (const [from, to, count] of REGION_CONNECTIONS) {
      add(from, to, count);
      add(to, from, count);
    }

    // Rich-club bonus: every hub gains strong edges to every other hub.
    for (const hub of RICH_CLUB_REGIONS) {
      if (!REGION_BY_ID[hub]) continue;
      for (const other of RICH_CLUB_REGIONS) {
        if (other !== hub) add(hub, other, 25);
      }
    }

    // Convert each adjacency map into a cumulative-weight array for O(log n)
    // weighted sampling.
    const result = new Map<BrainRegionId, { regions: BrainRegionId[]; cum: number[] }>();
    for (const [region, targets] of adjacency) {
      const regions: BrainRegionId[] = [];
      const cum: number[] = [];
      let running = 0;
      for (const [target, w] of targets) {
        running += w;
        regions.push(target);
        cum.push(running);
      }
      result.set(region, { regions, cum });
    }
    return result;
  }

  /** Weighted-sample a long-range target region for an axon leaving `region`. */
  private sampleLongRangeRegion(
    region: BrainRegionId,
    table: Map<BrainRegionId, { regions: BrainRegionId[]; cum: number[] }>,
    rng: () => number,
  ): BrainRegionId | null {
    const entry = table.get(region);
    if (!entry || entry.regions.length === 0) return null;
    const total = entry.cum[entry.cum.length - 1];
    const pick = rng() * total;
    // Linear scan is fine: regions have <= ~12 neighbours.
    for (let i = 0; i < entry.cum.length; i++) {
      if (pick <= entry.cum[i]) return entry.regions[i];
    }
    return entry.regions[entry.regions.length - 1];
  }

  /** Number of outgoing synapses from neuron i. */
  outDegree(i: number): number {
    return this.outStart[i + 1] - this.outStart[i];
  }

  stats(): ConnectomeStats {
    return {
      neuronCount: this.neuronCount,
      synapseCount: this.synapseCount,
      meanDegree: this.neuronCount > 0 ? this.synapseCount / this.neuronCount : 0,
      excitatoryFraction: this.neuronCount > 0 ? this.excitatoryCount / this.neuronCount : 0,
      longRangeFraction: this.synapseCount > 0 ? this.longRangeCount / this.synapseCount : 0,
      hubRegionCount: RICH_CLUB_REGIONS.size,
    };
  }
}
