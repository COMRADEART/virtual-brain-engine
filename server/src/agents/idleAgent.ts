// IdleAgent — internal-monologue ticks when the system has been quiet.
//
// The blueprint's other "highest-leverage cognitive gap" (the §15 pair with
// the unified saliency scorer that landed in the previous commit). Without
// this agent, the brain only "thinks" when a user types something; with it,
// it idly re-surfaces high-importance memories in the background so the UI
// has a sense of presence even between prompts.
//
// Design choices:
//   1. PURE WHERE POSSIBLE. The decision logic (think) is a function of two
//      timestamps + the runtime cadence; no DB. The act path samples from
//      `listRecentMemories` via an injected callback so the selfcheck can
//      stub it without spinning up a DB. Same pattern as ranker:selfcheck.
//   2. RATE-LIMITED. The runtime cycle is 60s, but a thought every cycle
//      would be noise. MIN_THOUGHT_GAP_MS keeps at least 5 minutes between
//      idle thoughts even when the system is dead quiet.
//   3. RESPECTS ACTIVITY. Any file-changed / activity-observed / pipeline-
//      step event resets lastActivityAt. The agent's reactive `handleEvent`
//      sees these via the bus; pipeline events from /api/ask reach the bus
//      indirectly through the broadcast bridge in brainCore.ts (the
//      file-changed/activity-observed kinds are the ones the agent layer
//      treats as "user/system is doing real work").
//   4. SURVIVES MISSING DEPS. The DB call is wrapped — a corrupted memory
//      table will not throw out of act(); we emit a diagnostic and skip.
//   5. SALIENCY-AWARE. When the organism singleton has health/goals, we use
//      saliency to weight the sample — so an idle thought is more likely to
//      be a memory that's salient RIGHT NOW. When the organism isn't ready,
//      we fall back to weighted-by-importance.

import type { Agent, AgentContext } from "./Agent.js";
import type { BrainEvent } from "../core/eventBus.js";
import type { MemoryPoint } from "../../../shared/memory.js";
import { listRecentMemories } from "../db/repositories/memory.js";
import { surfaceError } from "../util/diagnostics.js";
import { computeSaliency, type SaliencyContext } from "../attention/saliency.js";

// Knobs. Kept as exported consts so the selfcheck can inspect them.
export const IDLE_THRESHOLD_MS = 90_000; // 1.5 minutes of quiet before "idle".
export const MIN_THOUGHT_GAP_MS = 300_000; // 5 minutes minimum between thoughts.
export const SAMPLE_POOL_SIZE = 20; // how many recent memories to sample from.

/** Memory sampler — production wires to listRecentMemories; tests stub. */
export type IdleMemorySampler = () => MemoryPoint[];

/**
 * Optional saliency-context provider. Same pattern as the pipeline's
 * buildSaliencyContext — if it throws or returns null, the agent silently
 * falls back to weighting by importance only.
 */
export type IdleSaliencyProvider = () => SaliencyContext | null;

/** Random in [0,1). Injected for deterministic tests. */
export type IdleRandom = () => number;

export interface IdleAgentDeps {
  sampler?: IdleMemorySampler;
  saliencyProvider?: IdleSaliencyProvider;
  random?: IdleRandom;
  /** Override the "now" clock for tests. */
  now?: () => number;
}

export class IdleAgent implements Agent {
  private ctx: AgentContext | null = null;
  private lastActivityAt: number;
  private lastThoughtAt = 0;
  private ready = false;

  private readonly sampler: IdleMemorySampler;
  private readonly saliencyProvider: IdleSaliencyProvider;
  private readonly random: IdleRandom;
  private readonly now: () => number;

  constructor(deps: IdleAgentDeps = {}) {
    this.sampler = deps.sampler ?? (() => listRecentMemories(SAMPLE_POOL_SIZE));
    this.saliencyProvider = deps.saliencyProvider ?? (() => null);
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? (() => Date.now());
    this.lastActivityAt = this.now();
  }

  name(): string {
    return "idle";
  }

  capabilities(): string[] {
    return ["internal-monologue", "memory-surfacing"];
  }

  init(ctx: AgentContext): void {
    this.ctx = ctx;
    this.lastActivityAt = this.now();
  }

  handleEvent(event: BrainEvent): void {
    // Any event signalling "real work is happening" resets activity. We do NOT
    // count agent-status (every cycle emits one — would never go idle) or
    // imagination-snapshot (a heartbeat-ish thing).
    if (
      event.kind === "file-changed" ||
      event.kind === "activity-observed" ||
      event.kind === "summary-created"
    ) {
      this.lastActivityAt = this.now();
    }
  }

  think(): void {
    const now = this.now();
    const sinceActivity = now - this.lastActivityAt;
    const sinceThought = now - this.lastThoughtAt;
    this.ready = sinceActivity >= IDLE_THRESHOLD_MS && sinceThought >= MIN_THOUGHT_GAP_MS;
  }

  async act(): Promise<void> {
    if (!this.ready || !this.ctx) return;
    let pool: MemoryPoint[];
    try {
      pool = this.sampler();
    } catch (err) {
      surfaceError("idleAgent.sample", err);
      return;
    }
    const choice = this.weightedSample(pool);
    if (!choice) return;
    this.lastThoughtAt = this.now();
    this.ready = false;

    const preview = choice.content.length > 200 ? `${choice.content.slice(0, 197)}...` : choice.content;
    const reason = this.lastReason ?? "high-importance recall";
    this.ctx.bus.emit({
      kind: "idle-thought",
      memoryId: choice.id,
      preview,
      importance: choice.importance,
      reason,
      at: new Date(this.now()).toISOString(),
    });
    this.ctx.log(`idle thought: ${preview.slice(0, 80)} (reason: ${reason})`);
  }

  shutdown(): void {
    // Nothing persistent to tear down. lastActivityAt/lastThoughtAt are
    // in-memory; runtime drops the instance on stop().
  }

  // ---------------------------------------------------------------------------
  // Sampling. Weighted by importance, optionally re-weighted by saliency. The
  // last reason chosen is stashed for the emit() above so the UI can show why.
  // ---------------------------------------------------------------------------

  private lastReason: string | null = null;

  /** Public for selfcheck. */
  weightedSample(pool: MemoryPoint[]): MemoryPoint | null {
    if (pool.length === 0) {
      this.lastReason = null;
      return null;
    }
    const ctx = (() => {
      try {
        return this.saliencyProvider();
      } catch {
        return null;
      }
    })();

    let useSaliency = false;
    const weights = pool.map((m) => {
      // Floor at 1e-3 so a zero-importance memory still has microscopic chance
      // of being picked (and so weight-sum is never zero).
      let w = Math.max(1e-3, m.importance);
      if (ctx) {
        const sal = computeSaliency(
          { id: m.id, content: m.content, importance: m.importance },
          ctx,
        );
        // Geometric blend so saliency can promote but not dominate (a high-
        // importance unrelated memory still has a real shot).
        w = Math.sqrt(w * Math.max(1e-3, sal.score));
        useSaliency = true;
      }
      return w;
    });
    const sum = weights.reduce((a, b) => a + b, 0);
    const r = this.random() * sum;
    let acc = 0;
    for (let i = 0; i < pool.length; i += 1) {
      acc += weights[i];
      if (r <= acc) {
        this.lastReason = useSaliency
          ? "saliency-weighted recall"
          : "importance-weighted recall";
        return pool[i];
      }
    }
    // Numeric edge — fall back to last.
    this.lastReason = useSaliency ? "saliency-weighted recall" : "importance-weighted recall";
    return pool[pool.length - 1];
  }

  // Selfcheck seams — read-only view of internal state.
  __peekLastActivityAt(): number {
    return this.lastActivityAt;
  }
  __peekReady(): boolean {
    return this.ready;
  }
}
