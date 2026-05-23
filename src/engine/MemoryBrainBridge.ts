// MemoryBrainBridge — the seam between the personal-memory backend
// (SQLite + sqlite-vec served by /api/memory and /api/phase2) and the 3D
// spiking brain that the user actually watches.
//
// Layered design:
//
//   ┌──────────────── React panels / AskPanel / dev tools ─────────────┐
//   │                                                                  │
//   │   bridge.recall(memoryId) / store(content) / think(query)        │
//   │   bridge.subscribe(listener)         ← UI re-renders from this   │
//   │                                                                  │
//   └──────────────────────────┬───────────────────────────────────────┘
//                              │ (1) flashRegions / applyCognitiveState
//                              ▼
//                  ┌───────────────────────────┐
//                  │       SpikingEngine        │ — owns the LIF state,
//                  │  (regionIntensity, pulses) │   neuromodulators, traces
//                  └─────────────┬─────────────┘
//                              (2) NeuralGraphRenderer reads its buffers
//                              ▼
//                          three.js scene
//
//   Backend feed:
//     /api/memory/search  ──┐
//     /api/memory/recent  ──┤→ apiClient → bridge.recall(...) per hit
//     /ws/brain pipeline  ──┘   bridge tails this for live citations
//
// The bridge owns no rendering state of its own; it just translates "a
// memory was used / stored / forgotten" into the right region flashes,
// pulses, neuromodulator overlay, and a tiny in-memory pool of
// `MemoryTrace` records that decay over time (the "forgetting curve").
// A consolidated trace migrates its glow from the hippocampus onto
// posterior cortex — the standard systems-consolidation picture.

import { REGION_INDEX } from "./brainRegions";
import { LOGICAL_REGION_MAP } from "./logicalRegions";
import { apiClient } from "./apiClient";
import { subscribeBrainBus } from "./brainBus";
import {
  COGNITIVE_STATES,
  CREATIVE_THINKING_STATE,
  FOCUS_STATE,
  RECALL_MEMORY_STATE,
  type CognitiveState,
} from "./cognitiveStates";
import type { SpikingEngine } from "./SpikingEngine";
import type { BrainRegionId } from "./types";
import type { MemoryPoint, MemorySearchHit, MemorySourceType } from "../../shared/memory";
import type { PipelineEvent } from "../../shared/pipeline";

// ────────────────────────────────────────────────────────────────────────────
// Memory taxonomy
// ────────────────────────────────────────────────────────────────────────────

// The five canonical memory systems plus two helpers we need for routing.
// `working` is functionally separate from `reasoning` in the literature, but
// in this codebase they collapse onto PFC; we keep them distinct so a UI
// panel can colour them separately.
export type MemoryFunction =
  | "episodic"        // hippocampus-led, time/place-stamped events
  | "semantic"        // temporal cortex, facts & concepts
  | "procedural"      // basal ganglia + cerebellum + motor
  | "working"         // PFC + parietal, transient buffer
  | "reasoning"       // PFC + frontal, manipulation of working contents
  | "emotional"       // amygdala-led tagging
  | "long-term";      // posterior neocortex, consolidated storage

// What kind of activity is happening to the memory right now. This is what
// shows up in the visualization legend.
export type MemoryEventKind =
  | "encode"          // a new memory is being formed
  | "recall"          // an existing memory is being retrieved
  | "consolidate"     // hippocampal → neocortical transfer
  | "rehearse"        // working-memory loop refreshing a trace
  | "forget";         // strength fell below threshold

// A live, decaying record of one memory's presence in the simulation.
// The bridge keeps these around as long as their strength is above the
// forget threshold; once below, a "forget" event is emitted and the
// record is dropped.
export interface MemoryTrace {
  memoryId: string;
  function: MemoryFunction;
  // Importance is the memory's own intrinsic weight (from the backend).
  // Strength is the *current* activation, decays toward zero.
  importance: number;
  strength: number;
  // Where the trace currently lives. Starts at the function's primary
  // regions; on consolidation we swap to its consolidated regions.
  regions: BrainRegionId[];
  consolidated: boolean;
  // Wall-clock timestamps so a panel can show "1.3s ago" etc.
  createdAt: number;
  lastAccessAt: number;
  accessCount: number;
  // Optional payload — surfaced to the UI but never used in computation.
  title?: string;
  preview?: string;
}

export interface MemoryActivationEvent {
  kind: MemoryEventKind;
  trace: MemoryTrace;
  regions: BrainRegionId[];
  // Visual magnitude actually applied this tick — useful for HUD bars.
  flashMagnitude: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Region routing per memory function
// ────────────────────────────────────────────────────────────────────────────

// Where a memory FUNCTION first activates the brain when it fires. These are
// the regions that get a flash + extra drive on `recall`/`store`.
const PRIMARY_REGIONS: Record<MemoryFunction, BrainRegionId[]> = {
  episodic:    ["hippocampus-l", "hippocampus-r", "temporal-l", "temporal-r"],
  semantic:    ["temporal-l", "temporal-r", "hippocampus-l"],
  procedural:  ["basal-ganglia-l", "basal-ganglia-r", "cerebellum", "motor-l", "motor-r"],
  working:     ["prefrontal-l", "prefrontal-r", "parietal-l", "parietal-r"],
  reasoning:   ["prefrontal-l", "prefrontal-r", "frontal-l", "frontal-r"],
  emotional:   ["amygdala-l", "amygdala-r", "hippocampus-l", "hippocampus-r"],
  "long-term": ["temporal-l", "temporal-r", "parietal-l", "parietal-r", "occipital-l", "occipital-r"],
};

// Where a trace migrates AFTER it has been consolidated. Systems-consolidation
// theory: hippocampus is the index, neocortex is the long-term store. So an
// "old" episodic trace stops lighting up the hippocampus and starts lighting
// up the posterior association cortices instead.
const CONSOLIDATED_REGIONS: Record<MemoryFunction, BrainRegionId[]> = {
  episodic:    ["temporal-l", "temporal-r", "parietal-l", "parietal-r"],
  semantic:    ["temporal-l", "temporal-r", "parietal-l", "parietal-r"],
  procedural:  ["cerebellum", "motor-l", "motor-r"], // motor schemas live in cerebellum
  working:     ["prefrontal-l", "prefrontal-r"],     // working ≈ never consolidated; no-op effectively
  reasoning:   ["prefrontal-l", "prefrontal-r"],
  emotional:   ["amygdala-l", "amygdala-r", "temporal-l", "temporal-r"],
  "long-term": ["temporal-l", "temporal-r", "occipital-l", "occipital-r"],
};

// Picking a default cognitive-state overlay per function so e.g. "recall"
// rides theta on the hippocampus and "reasoning" rides gamma on PFC.
const STATE_FOR_FUNCTION: Record<MemoryFunction, CognitiveState> = {
  episodic:    RECALL_MEMORY_STATE,
  semantic:    RECALL_MEMORY_STATE,
  procedural:  FOCUS_STATE,
  working:     FOCUS_STATE,
  reasoning:   FOCUS_STATE,
  emotional:   { ...RECALL_MEMORY_STATE, dopamine: 0.55, thetaGain: 1.8 }, // affect boosts DA
  "long-term": { ...CREATIVE_THINKING_STATE, thetaGain: 1.4 },              // mind-wandery
};

// ────────────────────────────────────────────────────────────────────────────
// Tunables (gathered up top so a UI slider can rebind them later)
// ────────────────────────────────────────────────────────────────────────────

export interface BridgeTunables {
  /** How quickly trace strength decays per second (multiplicative). 0.92 ≈ half-life ~8s. */
  decayPerSecond: number;
  /** Strength below which we emit "forget" and drop the trace. */
  forgetThreshold: number;
  /** Strength above which a trace becomes "consolidated" and migrates regions. */
  consolidationThreshold: number;
  /** Number of access events that pin a trace permanently (no forget). */
  pinAfterAccessCount: number;
  /** Base flash magnitude on `recall`. Multiplied by importance ∈ [0,1]. */
  recallFlashMagnitude: number;
  /** Base flash magnitude on `store` (encoding tends to be louder than recall). */
  storeFlashMagnitude: number;
  /** Max concurrent live traces. Oldest weakest get evicted past this. */
  maxLiveTraces: number;
}

const DEFAULT_TUNABLES: BridgeTunables = {
  decayPerSecond: 0.92,
  forgetThreshold: 0.04,
  consolidationThreshold: 1.6,
  pinAfterAccessCount: 6,
  recallFlashMagnitude: 0.85,
  storeFlashMagnitude: 1.0,
  maxLiveTraces: 128,
};

// ────────────────────────────────────────────────────────────────────────────
// Inference helpers — picking a memory function from a MemoryPoint
// ────────────────────────────────────────────────────────────────────────────

// The backend doesn't currently carry an explicit memory-function tag, so we
// infer one from sourceType + light keyword cues. UI code can override by
// passing `function` to `recall(...)` directly.
export function inferMemoryFunction(memory: Pick<MemoryPoint, "sourceType" | "title" | "content" | "metadata">): MemoryFunction {
  const meta = (memory.metadata ?? {}) as Record<string, unknown>;
  const tagged = typeof meta.memoryFunction === "string" ? (meta.memoryFunction as MemoryFunction) : null;
  if (tagged && tagged in PRIMARY_REGIONS) {
    return tagged;
  }

  switch (memory.sourceType) {
    case "conversation": {
      // Conversation Q&A entries are episodic by default (time-stamped events
      // in the user's life). Promote to "emotional" if the content has strong
      // affect words — cheap heuristic, easy to swap with a real classifier.
      const text = `${memory.title ?? ""} ${memory.content}`.toLowerCase();
      if (/\b(love|hate|fear|angry|happy|sad|scared|excited|grief|joy)\b/.test(text)) {
        return "emotional";
      }
      return "episodic";
    }
    case "chunk":
      // File chunks are pure semantic knowledge.
      return "semantic";
    case "manual":
      return "semantic";
    default:
      return "semantic";
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Bridge
// ────────────────────────────────────────────────────────────────────────────

export interface MemoryBrainBridgeOptions {
  /**
   * If true, the bridge listens to the WS pipeline stream and converts the
   * "memory" step's citations into `recall()` calls automatically. Default
   * true; set false if you want fully manual control (tests, demos).
   */
  followPipeline?: boolean;
  /**
   * Hard caps & decay rates. Caller can override partially; defaults fill
   * the rest in.
   */
  tunables?: Partial<BridgeTunables>;
}

type Listener = (event: MemoryActivationEvent) => void;

export class MemoryBrainBridge {
  private readonly engine: SpikingEngine;
  private readonly tunables: BridgeTunables;
  private readonly traces = new Map<string, MemoryTrace>();
  private readonly listeners = new Set<Listener>();
  private unsubscribeBus: (() => void) | null = null;

  constructor(engine: SpikingEngine, opts: MemoryBrainBridgeOptions = {}) {
    this.engine = engine;
    this.tunables = { ...DEFAULT_TUNABLES, ...(opts.tunables ?? {}) };

    if (opts.followPipeline !== false) {
      this.unsubscribeBus = subscribeBrainBus((msg) => {
        if (msg.type === "pipeline") {
          this.onPipelineEvent(msg);
        }
      });
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Disconnect from the WS bus and clear local state. */
  dispose(): void {
    this.unsubscribeBus?.();
    this.unsubscribeBus = null;
    this.traces.clear();
    this.listeners.clear();
  }

  // ── Subscription (for React panels) ──────────────────────────────────────

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Snapshot the live trace pool. Sorted strongest-first. */
  snapshot(): MemoryTrace[] {
    return [...this.traces.values()].sort((a, b) => b.strength - a.strength);
  }

  // ── Tick: called from BrainScene's render loop ──────────────────────────

  /**
   * Should be called once per frame. Decays every trace's strength toward
   * zero and emits "forget" events for traces that crossed the threshold.
   * Also migrates traces past the consolidation threshold to their
   * neocortical destinations.
   */
  tick(deltaSeconds: number): void {
    if (deltaSeconds <= 0 || this.traces.size === 0) {
      return;
    }
    const decay = Math.pow(this.tunables.decayPerSecond, deltaSeconds);

    const toForget: string[] = [];
    for (const trace of this.traces.values()) {
      // Pinned traces (frequently rehearsed) stop decaying — they're now LTM.
      const pinned = trace.accessCount >= this.tunables.pinAfterAccessCount;
      if (!pinned) {
        trace.strength *= decay;
      }

      // Consolidation: once a trace has been strongly co-activated enough
      // (typically through repeated recall), its primary regions swap to
      // the consolidated set, modelling hippocampal → neocortical handoff.
      if (!trace.consolidated && trace.strength * Math.max(1, trace.accessCount) >= this.tunables.consolidationThreshold) {
        trace.consolidated = true;
        trace.regions = CONSOLIDATED_REGIONS[trace.function];
        this.emit({
          kind: "consolidate",
          trace,
          regions: trace.regions,
          flashMagnitude: 0.55,
        });
        // A consolidation event is also a small flash — the trace's home is
        // moving, so we light up its new destination softly.
        this.engine.flashRegions(trace.regions, 0.55);
      }

      // Sustain the visual glow on the regions this trace is in. The flash
      // magnitude is bounded by the trace's own strength so a weak trace
      // contributes a weak hum, not a full flash.
      if (trace.strength > this.tunables.forgetThreshold * 1.5) {
        this.engine.flashRegions(trace.regions, Math.min(0.55, trace.strength * 0.4));
      }

      if (!pinned && trace.strength < this.tunables.forgetThreshold) {
        toForget.push(trace.memoryId);
      }
    }

    for (const id of toForget) {
      const trace = this.traces.get(id);
      if (!trace) continue;
      this.traces.delete(id);
      this.emit({
        kind: "forget",
        trace,
        regions: trace.regions,
        flashMagnitude: 0,
      });
    }
  }

  // ── Actions (the three the spec calls out) ───────────────────────────────

  /**
   * "Recall Memory" — light up the regions associated with the memory's
   * inferred function, register/refresh its trace, bump the hippocampal
   * memory channel, and apply the recall cognitive-state overlay.
   *
   * Pass `function` explicitly to override the inference (e.g. a UI button
   * that says "remember this as a procedure").
   */
  recall(
    memory: Pick<MemoryPoint, "id" | "sourceType" | "title" | "content" | "metadata" | "importance">,
    opts: { function?: MemoryFunction; sourceMagnitude?: number } = {},
  ): MemoryTrace {
    const fn = opts.function ?? inferMemoryFunction(memory);
    const importance = clamp01(memory.importance ?? 0.5);
    const trace = this.refreshTrace(memory.id, fn, importance, {
      title: memory.title ?? undefined,
      preview: previewOf(memory.content),
    });

    const magnitude = (opts.sourceMagnitude ?? this.tunables.recallFlashMagnitude) * (0.4 + importance * 0.6);
    this.engine.flashRegions(trace.regions, magnitude);
    this.engine.applyCognitiveState(STATE_FOR_FUNCTION[fn]);
    this.engine.setMemoryIntensity(this.totalLiveImportance() * 250);

    this.emit({ kind: "recall", trace, regions: trace.regions, flashMagnitude: magnitude });
    return trace;
  }

  /**
   * "Store New Memory" — encoding pass. Optionally writes through to the
   * backend (`apiClient.phase2SemanticIngest`) if `persist` is set; in
   * either case it produces an in-simulation encoding flash on the
   * hippocampus + (if emotional) amygdala.
   *
   * Returns the trace immediately; if `persist` is true, the backend write
   * is awaited and the trace is then re-keyed by the new memory's ULID.
   */
  async store(input: {
    content: string;
    title?: string;
    function?: MemoryFunction;
    importance?: number;
    sourceType?: MemorySourceType;
    projectName?: string;
    persist?: boolean;
    /** Tagging hint — bumps emotional regions even if `function` is not "emotional". */
    emotional?: boolean;
  }): Promise<MemoryTrace> {
    const fn = input.function ?? inferMemoryFunction({
      sourceType: input.sourceType ?? "manual",
      title: input.title ?? null,
      content: input.content,
      metadata: undefined,
    });
    const importance = clamp01(input.importance ?? 0.5);

    // Provisional ID — replaced with the server-assigned ULID after persist().
    const provisionalId = `local:${Date.now()}:${Math.floor(Math.random() * 1e6)}`;

    const trace = this.refreshTrace(provisionalId, fn, importance, {
      title: input.title,
      preview: previewOf(input.content),
    });
    // Encoding regions = primary regions, plus amygdala if flagged emotional.
    const encodingRegions = input.emotional
      ? dedupeRegions([...trace.regions, "amygdala-l", "amygdala-r"])
      : trace.regions;

    const magnitude = this.tunables.storeFlashMagnitude * (0.5 + importance * 0.5);
    this.engine.flashRegions(encodingRegions, magnitude);
    // Encoding state: high ACh, theta-locked hippocampus.
    this.engine.applyCognitiveState({
      ...RECALL_MEMORY_STATE,
      name: "Encode",
      description: "Hippocampal-PFC theta encoding of a fresh memory.",
      acetylcholine: 0.85,
      dopamine: input.emotional ? 0.6 : 0.45,
    });
    this.engine.setMemoryIntensity(this.totalLiveImportance() * 250 + 60);

    this.emit({ kind: "encode", trace, regions: encodingRegions, flashMagnitude: magnitude });

    if (input.persist) {
      try {
        const res = await apiClient.phase2SemanticIngest({
          content: input.content,
          memoryType: fn,
          projectName: input.projectName,
          tags: input.emotional ? ["emotional"] : undefined,
          importance,
        });
        // Re-key the trace under the server-assigned ID so future recalls hit it.
        const newId = res.memory.id;
        this.traces.delete(provisionalId);
        trace.memoryId = newId;
        this.traces.set(newId, trace);
      } catch (err) {
        // Persistence failure does not invalidate the visualization — leave
        // the trace under its provisional ID. The console warning helps the
        // user spot a backend that's down.
        console.warn("[MemoryBrainBridge] store(): persist failed", err);
      }
    }

    return trace;
  }

  /**
   * "Think About X" — focus the engine, run a semantic search against the
   * backend, then play each hit back as a `recall()` with magnitude scaled
   * by the search score. Returns the hits in case the caller wants to
   * render them in a panel.
   */
  async think(query: string, opts: { limit?: number; projectName?: string } = {}): Promise<MemorySearchHit[]> {
    // Enter FOCUS first so the regions are primed before retrieval lands.
    this.engine.applyCognitiveState(FOCUS_STATE);
    this.engine.flashRegions(LOGICAL_REGION_MAP["reasoning-cortex"], 0.7);

    let hits: MemorySearchHit[] = [];
    try {
      const res = await apiClient.searchMemory(query, { limit: opts.limit ?? 6, project: opts.projectName });
      hits = res.hits as MemorySearchHit[];
    } catch (err) {
      console.warn("[MemoryBrainBridge] think(): search failed", err);
      return [];
    }

    // Recall each hit, magnitude shaped by similarity score so a weak match
    // produces a faint flicker and a strong match a bright flash.
    for (const hit of hits) {
      const magnitude = this.tunables.recallFlashMagnitude * (0.3 + clamp01(hit.score) * 0.7);
      this.recall(hit.memory, { sourceMagnitude: magnitude });
    }

    // After retrieval, slide back into the recall-themed state so the
    // ongoing flashes ride theta on the hippocampus.
    this.engine.applyCognitiveState(STATE_FOR_FUNCTION.episodic);
    return hits;
  }

  /** Explicit rehearsal pass — used by working-memory loops. */
  rehearse(memoryId: string): void {
    const trace = this.traces.get(memoryId);
    if (!trace) {
      return;
    }
    trace.strength = Math.min(2.0, trace.strength + 0.5);
    trace.lastAccessAt = Date.now();
    trace.accessCount += 1;
    this.engine.flashRegions(trace.regions, 0.5);
    this.emit({
      kind: "rehearse",
      trace,
      regions: trace.regions,
      flashMagnitude: 0.5,
    });
  }

  /** Force-forget a memory (e.g. user deleted it). */
  forget(memoryId: string): void {
    const trace = this.traces.get(memoryId);
    if (!trace) return;
    this.traces.delete(memoryId);
    this.emit({ kind: "forget", trace, regions: trace.regions, flashMagnitude: 0 });
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Create or refresh a trace. Either path returns the live record so the
   * caller can read its strength immediately after. We also evict the
   * weakest trace if we're over the cap.
   */
  private refreshTrace(
    memoryId: string,
    fn: MemoryFunction,
    importance: number,
    meta: { title?: string; preview?: string },
  ): MemoryTrace {
    const now = Date.now();
    let trace = this.traces.get(memoryId);
    if (trace) {
      trace.strength = Math.min(2.0, trace.strength + 0.7 + importance * 0.4);
      trace.lastAccessAt = now;
      trace.accessCount += 1;
      // Importance is sticky-upward: a recall can only raise it (so the
      // backend's importance learner is the source of truth for downward
      // moves, and a single recall never demotes a memory).
      if (importance > trace.importance) {
        trace.importance = importance;
      }
      return trace;
    }

    // Evict weakest if over cap.
    if (this.traces.size >= this.tunables.maxLiveTraces) {
      let weakest: MemoryTrace | null = null;
      for (const t of this.traces.values()) {
        if (!weakest || t.strength < weakest.strength) weakest = t;
      }
      if (weakest) {
        this.traces.delete(weakest.memoryId);
        this.emit({ kind: "forget", trace: weakest, regions: weakest.regions, flashMagnitude: 0 });
      }
    }

    trace = {
      memoryId,
      function: fn,
      importance,
      strength: 1.0 + importance * 0.4,
      regions: PRIMARY_REGIONS[fn],
      consolidated: false,
      createdAt: now,
      lastAccessAt: now,
      accessCount: 1,
      title: meta.title,
      preview: meta.preview,
    };
    this.traces.set(memoryId, trace);
    return trace;
  }

  private emit(event: MemoryActivationEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        console.warn("[MemoryBrainBridge] listener threw", err);
      }
    }
  }

  private totalLiveImportance(): number {
    let total = 0;
    for (const t of this.traces.values()) {
      total += t.importance * Math.min(1, t.strength);
    }
    return total;
  }

  // Pipeline integration — the 7-step server pipeline emits a `memory` step
  // event with citations after vector search. We treat each citation as a
  // live recall. The memory step's start/end events also flash the
  // memory-core logical region so the user sees activity even when no
  // memory was found.
  private async onPipelineEvent(event: PipelineEvent): Promise<void> {
    if (event.step === "memory" && event.status === "start") {
      this.engine.flashRegions(LOGICAL_REGION_MAP["memory-core"], 0.45);
      return;
    }
    if (event.step === "memory" && event.status === "complete" && event.citations?.length) {
      // Citations are { memoryId, score? } pairs. We need the full MemoryPoint
      // to infer the function correctly, but a partial recall is fine if the
      // backend is slow: fall back to a generic "episodic" recall and
      // upgrade when the fetch returns.
      for (const cite of event.citations) {
        const partial: Parameters<MemoryBrainBridge["recall"]>[0] = {
          id: cite.memoryId,
          sourceType: "conversation",
          title: null,
          content: "",
          importance: 0.5,
          metadata: undefined,
        };
        this.recall(partial, {
          sourceMagnitude: this.tunables.recallFlashMagnitude * clamp01(cite.score ?? 0.5),
        });

        // Fetch full memory in the background to refine the function /
        // importance once we know what we cited.
        apiClient
          .getMemory(cite.memoryId)
          .then((res) => {
            this.recall(res.memory, { sourceMagnitude: 0.4 });
          })
          .catch(() => {
            // backend down — the optimistic recall already lit the regions.
          });
      }
    }
    if (event.step === "reasoning" && event.status === "start") {
      this.engine.applyCognitiveState(FOCUS_STATE);
    }
    if (event.step === "response" && event.status === "complete") {
      // Response finished: a brief dopamine pulse rewards the run.
      this.engine.setDopamine(0.6);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Pure helpers (no engine deps — exported for testing)
// ────────────────────────────────────────────────────────────────────────────

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function previewOf(content: string): string {
  const trimmed = content.trim().replace(/\s+/g, " ");
  return trimmed.length > 140 ? `${trimmed.slice(0, 137)}…` : trimmed;
}

function dedupeRegions(regions: BrainRegionId[]): BrainRegionId[] {
  const seen = new Set<BrainRegionId>();
  const out: BrainRegionId[] = [];
  for (const r of regions) {
    if (!seen.has(r) && REGION_INDEX[r] !== undefined) {
      seen.add(r);
      out.push(r);
    }
  }
  return out;
}

// Make the cognitive-states map and region tables externally readable so a
// debug panel can hover any function and show "what does this fire?".
export const MEMORY_FUNCTION_REGIONS = PRIMARY_REGIONS;
export const MEMORY_FUNCTION_CONSOLIDATED_REGIONS = CONSOLIDATED_REGIONS;
export const MEMORY_FUNCTION_STATES = STATE_FOR_FUNCTION;
export { COGNITIVE_STATES };

// ────────────────────────────────────────────────────────────────────────────
// Example usage (copy into BrainScene.tsx — left here as a doc-string so the
// integration story is obvious from one file)
// ────────────────────────────────────────────────────────────────────────────
//
//   import { SpikingEngine } from "./SpikingEngine";
//   import { MemoryBrainBridge } from "./MemoryBrainBridge";
//
//   // 1. Build the engine off the current graph.
//   const engine = new SpikingEngine(graph, "remember-event");
//
//   // 2. Wrap it in a bridge. By default, the bridge listens to the
//   //    pipeline WS bus and converts cited memories into recall flashes.
//   const bridge = new MemoryBrainBridge(engine);
//
//   // 3. Inside the render loop, tick BOTH the engine and the bridge.
//   //    Order matters: tick the bridge AFTER the engine so the bridge's
//   //    flash overlay rides on the same frame.
//   function renderFrame(now: number) {
//     const delta = (now - last) / 1000;
//     engine.step(delta, now / 1000);
//     bridge.tick(delta);
//     renderer.update(...);
//   }
//
//   // 4. Wire UI buttons to the three bridge actions.
//   document.querySelector("#recall-btn")?.addEventListener("click", async () => {
//     const { memories } = await apiClient.recentMemories(1);
//     if (memories[0]) bridge.recall(memories[0]);
//   });
//
//   document.querySelector("#store-btn")?.addEventListener("click", () => {
//     bridge.store({
//       content: "Met Alex for coffee at Bluestone. Talked about the new design.",
//       title: "Coffee with Alex",
//       function: "episodic",
//       importance: 0.7,
//       emotional: false,
//       persist: true, // also write through to /api/phase2/semantic/ingest
//     });
//   });
//
//   document.querySelector("#think-btn")?.addEventListener("click", async () => {
//     const hits = await bridge.think("design decisions on the brain visualizer");
//     console.log("retrieved", hits.length, "memories");
//   });
//
//   // 5. (Optional) Subscribe a React panel to render the live trace pool.
//   useEffect(() => bridge.subscribe((ev) => {
//     setRecentMemoryEvents((prev) => [ev, ...prev].slice(0, 20));
//   }), [bridge]);
//
//   // 6. On unmount: bridge.dispose();
//
