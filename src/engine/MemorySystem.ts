// MemorySystem — multi-store memory with replay, consolidation & forgetting
// =========================================================================
//
// Human memory is not one thing; it's a family of stores with different
// substrates, timescales, and dynamics. We model the four classical systems and
// the processes that move information between them:
//
//   • WORKING MEMORY (prefrontal/parietal) — a tiny (~4 item) set held by
//     PERSISTENT ACTIVITY. It is volatile: items decay within seconds unless
//     refreshed. Drives sustained current into the regions holding each item.
//   • EPISODIC MEMORY (hippocampus → neocortex) — context-rich "what/where/when"
//     traces. Encoded rapidly by the hippocampus; each carries an IMPORTANCE and
//     a decaying STRENGTH.
//   • SEMANTIC MEMORY (neocortex) — facts abstracted away from their original
//     episode. Episodic traces that are replayed enough CONSOLIDATE into
//     semantic ones (systems consolidation): they shed hippocampal dependence
//     and stop decaying.
//   • PROCEDURAL MEMORY (basal ganglia / cerebellum / motor) — skills, built by
//     repetition rather than single events; strengthens with practice.
//
// PROCESSES:
//   • REPLAY — during quiescence the hippocampus reactivates recent traces in
//     compressed sequences (sharp-wave ripples). Replay both drives the visual
//     reactivation and advances consolidation.
//   • IMPORTANCE-BASED FORGETTING — strength decays continuously, but important
//     and consolidated memories decay far more slowly. Below a floor a trace is
//     pruned. (Plus a hard cap so the store stays bounded.)
//
// Plasticity (STDP + homeostasis) lives in the engine/connectome layer; this
// module is the *content* layer and exposes per-region "drive" so the engine can
// turn remembered content back into neural activity, and a per-neuron
// `memoryTrace` buffer the visualiser tints.

import type { BrainEventBus } from "./BrainEventBus";
import { REGION_INDEX, REGION_ORDER } from "./brainRegions";
import type { BrainRegionId, NeuralGraph } from "./types";

export type MemoryType = "working" | "episodic" | "semantic" | "procedural";

export interface MemoryTraceRecord {
  id: string;
  type: MemoryType;
  regions: BrainRegionId[];
  importance: number; // [0,1] — salience at encoding
  strength: number; // [0,1] — current accessibility; decays
  consolidation: number; // [0,1] — hippocampal → neocortical transfer progress
  createdMs: number;
  lastAccessMs: number;
  replayCount: number;
}

interface WorkingItem {
  regions: BrainRegionId[];
  activation: number; // decays toward 0
  label: string;
}

export interface MemoryStats {
  working: number;
  episodic: number;
  semantic: number;
  procedural: number;
  replaying: boolean;
  totalImportance: number;
}

const WORKING_CAPACITY = 4; // Cowan's ~4, not Miller's 7±2
const WORKING_DECAY_PER_SEC = 0.5; // activation lost per second without refresh
const EPISODIC_CAP = 64;
const FORGET_FLOOR = 0.05; // prune below this strength
const CONSOLIDATION_THRESHOLD = 0.8; // episodic → semantic crossover
const REPLAY_STEP_SEC = 0.12; // ~theta-paced reactivation cadence

export class MemorySystem {
  private readonly R: number;
  /** Per-neuron memory engagement [0,1] for the visualiser. */
  readonly memoryTrace: Float32Array;

  // Per-region drive buffers consumed by the engine.
  private readonly wmDrive: Float32Array; // working-memory sustained drive
  private readonly replayDrive: Float32Array; // transient replay reactivation
  private readonly proceduralStrength: Float32Array; // skill consolidation per region

  // Stores.
  private readonly working: WorkingItem[] = [];
  private readonly episodic: MemoryTraceRecord[] = [];

  // Replay state machine.
  private replaying = false;
  private replayQueue: MemoryTraceRecord[] = [];
  private replayTimer = 0;
  private replayCurrent: MemoryTraceRecord | null = null;

  private nextId = 1;
  private overallMemoryLoad = 0; // external "how full is memory" signal [0,1]

  // Region → neuron [start,count] for painting the per-neuron memoryTrace.
  private readonly regionSpan: Record<BrainRegionId, { start: number; count: number }>;

  constructor(graph: NeuralGraph, private readonly bus?: BrainEventBus) {
    this.R = REGION_ORDER.length;
    this.memoryTrace = new Float32Array(graph.nodes.length);
    this.wmDrive = new Float32Array(this.R);
    this.replayDrive = new Float32Array(this.R);
    this.proceduralStrength = new Float32Array(this.R);
    this.regionSpan = {} as Record<BrainRegionId, { start: number; count: number }>;
    for (const id of REGION_ORDER) {
      const range = graph.regionRanges[id];
      this.regionSpan[id] = range ? { start: range.start, count: range.count } : { start: 0, count: 0 };
    }
  }

  // ── Encoding ──────────────────────────────────────────────────────────────

  /** Rapidly encode an episodic trace (hippocampal one-shot learning). */
  encodeEpisodic(regions: BrainRegionId[], importance: number): MemoryTraceRecord {
    const now = Date.now();
    const trace: MemoryTraceRecord = {
      id: `ep_${this.nextId++}`,
      type: "episodic",
      regions: [...regions],
      importance: clamp01(importance),
      // Important events are encoded more strongly (emotional/dopaminergic tag).
      strength: clamp01(0.6 + importance * 0.4),
      consolidation: 0,
      createdMs: now,
      lastAccessMs: now,
      replayCount: 0,
    };
    this.episodic.push(trace);
    // Bound the store: prune the weakest if over cap.
    if (this.episodic.length > EPISODIC_CAP) {
      this.episodic.sort((a, b) => effectiveStrength(b) - effectiveStrength(a));
      this.episodic.length = EPISODIC_CAP;
    }
    this.bus?.emit("memory:encode", { id: trace.id, importance: trace.importance });
    return trace;
  }

  /** Practise a skill: strengthen procedural memory in motor/striatal/cerebellar
   *  regions. Repetition (called over many frames) is what builds it. */
  reinforceProcedural(regions: BrainRegionId[], amount = 0.02): void {
    for (const region of regions) {
      const i = REGION_INDEX[region];
      if (i !== undefined) this.proceduralStrength[i] = clamp01(this.proceduralStrength[i] + amount);
    }
  }

  /** Place an item into the volatile working-memory buffer (evicts oldest if full). */
  pushWorkingMemory(regions: BrainRegionId[], label = "item"): void {
    this.working.push({ regions: [...regions], activation: 1, label });
    if (this.working.length > WORKING_CAPACITY) this.working.shift();
  }

  // ── Retrieval ───────────────────────────────────────────────────────────────

  /**
   * Pattern-completion recall: given a partial cue (a few regions), return the
   * episodic/semantic trace whose region set best overlaps the cue, weighted by
   * its effective strength. Accessing a memory refreshes it (testing effect).
   */
  recall(cueRegions: BrainRegionId[]): MemoryTraceRecord | null {
    if (cueRegions.length === 0 || this.episodic.length === 0) return null;
    const cue = new Set(cueRegions);
    let best: MemoryTraceRecord | null = null;
    let bestScore = 0;
    for (const trace of this.episodic) {
      let overlap = 0;
      for (const r of trace.regions) if (cue.has(r)) overlap++;
      const score = (overlap / Math.max(1, trace.regions.length)) * effectiveStrength(trace);
      if (score > bestScore) {
        bestScore = score;
        best = trace;
      }
    }
    if (best && bestScore > 0.05) {
      best.lastAccessMs = Date.now();
      best.strength = clamp01(best.strength + 0.15); // retrieval strengthens
      return best;
    }
    return null;
  }

  // ── Replay / consolidation ──────────────────────────────────────────────────

  /** Begin a replay bout over the most important recent episodic traces. */
  triggerReplay(): void {
    if (this.episodic.length === 0) return;
    this.replayQueue = [...this.episodic]
      .sort((a, b) => b.importance * (1 - b.consolidation) - a.importance * (1 - a.consolidation))
      .slice(0, 5);
    this.replaying = this.replayQueue.length > 0;
    this.replayTimer = 0;
    this.replayCurrent = null;
  }

  isReplaying(): boolean {
    return this.replaying;
  }

  /** Set an external "memory load" hint (e.g. live memory count from the app),
   *  which biases hippocampal engagement. */
  setMemoryLoad(load01: number): void {
    this.overallMemoryLoad = clamp01(load01);
  }

  // ── Per-step update ─────────────────────────────────────────────────────────

  /**
   * @param dtSeconds frame delta
   * @param hippocampalActivity current hippocampal drive [0,1] — high activity
   *   biases new encoding; quiescence permits replay
   * @param regionActivity per-region activity (REGION_ORDER indexed) — used to
   *   keep working memory "refreshed" while its regions stay active
   */
  update(dtSeconds: number, hippocampalActivity: number, regionActivity: Float32Array): void {
    // 1) Working memory: decay, but refresh from ongoing activity in its regions.
    for (const item of this.working) {
      let refresh = 0;
      for (const r of item.regions) {
        const i = REGION_INDEX[r];
        if (i !== undefined) refresh = Math.max(refresh, regionActivity[i] ?? 0);
      }
      item.activation = clamp01(item.activation - WORKING_DECAY_PER_SEC * dtSeconds + refresh * dtSeconds);
    }
    // Drop fully-decayed items.
    for (let k = this.working.length - 1; k >= 0; k--) {
      if (this.working[k].activation <= 0.02) this.working.splice(k, 1);
    }

    // 2) Episodic forgetting: strength decays; important + consolidated traces
    //    decay much slower. Then prune anything below the floor.
    const minutes = dtSeconds / 60;
    for (const trace of this.episodic) {
      const protectQuota = 0.4 * trace.importance + 0.5 * trace.consolidation;
      const decayRate = 0.08 * (1 - protectQuota); // per minute
      trace.strength = Math.max(0, trace.strength - decayRate * minutes);
    }
    for (let k = this.episodic.length - 1; k >= 0; k--) {
      if (effectiveStrength(this.episodic[k]) < FORGET_FLOOR) this.episodic.splice(k, 1);
    }

    // 3) Replay machine: when active, reactivate one trace at a time on a
    //    theta-paced cadence, painting replayDrive and advancing consolidation.
    this.replayDrive.fill(0);
    if (this.replaying) {
      this.replayTimer -= dtSeconds;
      if (this.replayTimer <= 0) {
        this.replayCurrent = this.replayQueue.shift() ?? null;
        this.replayTimer = REPLAY_STEP_SEC;
        if (!this.replayCurrent) {
          this.replaying = false;
        } else {
          const trace = this.replayCurrent;
          trace.replayCount++;
          // Each replay advances systems consolidation (hippocampus→neocortex).
          trace.consolidation = clamp01(trace.consolidation + 0.12);
          trace.strength = clamp01(trace.strength + 0.05);
          if (trace.type === "episodic" && trace.consolidation >= CONSOLIDATION_THRESHOLD) {
            trace.type = "semantic"; // graduated to neocortical store
          }
          this.bus?.emit("memory:replay", {
            region: trace.consolidation < 0.5 ? "hippocampus" : "neocortex",
            memoryIds: [trace.id],
          });
        }
      }
      if (this.replayCurrent) {
        for (const r of this.replayCurrent.regions) {
          const i = REGION_INDEX[r];
          if (i !== undefined) this.replayDrive[i] = 0.9;
        }
      }
    } else if (hippocampalActivity < 0.15 && this.episodic.length > 0 && Math.random() < dtSeconds * 0.3) {
      // Spontaneous offline replay when the hippocampus is quiet.
      this.triggerReplay();
    }

    // 4) Working-memory drive buffer.
    this.wmDrive.fill(0);
    for (const item of this.working) {
      for (const r of item.regions) {
        const i = REGION_INDEX[r];
        if (i !== undefined) this.wmDrive[i] = Math.max(this.wmDrive[i], item.activation * 0.8);
      }
    }

    // 5) Paint the per-neuron memory trace: regions engaged by WM, replay, or
    //    procedural skill light up; everything else fades.
    this.paintMemoryTrace(dtSeconds);
  }

  /** Sustained drive from items currently held in working memory. */
  getWorkingMemoryDrive(regionIndex: number): number {
    return this.wmDrive[regionIndex] ?? 0;
  }

  /** Transient drive from the region being reactivated during replay. */
  getReplayDrive(regionIndex: number): number {
    return this.replayDrive[regionIndex] ?? 0;
  }

  getStats(): MemoryStats {
    let semantic = 0;
    let episodic = 0;
    let importance = 0;
    for (const t of this.episodic) {
      if (t.type === "semantic") semantic++;
      else episodic++;
      importance += t.importance * effectiveStrength(t);
    }
    let procedural = 0;
    for (let i = 0; i < this.R; i++) if (this.proceduralStrength[i] > 0.1) procedural++;
    return {
      working: this.working.length,
      episodic,
      semantic,
      procedural,
      replaying: this.replaying,
      totalImportance: importance,
    };
  }

  private paintMemoryTrace(dtSeconds: number): void {
    // Global fade.
    const fade = Math.exp(-dtSeconds / 0.6);
    for (let i = 0; i < this.memoryTrace.length; i++) this.memoryTrace[i] *= fade;

    const paintRegion = (regionId: BrainRegionId, value: number) => {
      const span = this.regionSpan[regionId];
      if (!span) return;
      const end = span.start + span.count;
      for (let n = span.start; n < end; n++) {
        if (value > this.memoryTrace[n]) this.memoryTrace[n] = value;
      }
    };

    for (const item of this.working) for (const r of item.regions) paintRegion(r, item.activation * 0.7);
    if (this.replayCurrent && this.replaying) for (const r of this.replayCurrent.regions) paintRegion(r, 1.0);
    for (let i = 0; i < this.R; i++) {
      if (this.proceduralStrength[i] > 0.1) paintRegion(REGION_ORDER[i], this.proceduralStrength[i] * 0.5);
    }
  }
}

/** Effective accessibility combines raw strength with importance protection. */
function effectiveStrength(t: MemoryTraceRecord): number {
  return clamp01(t.strength * (0.7 + 0.3 * t.importance));
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
