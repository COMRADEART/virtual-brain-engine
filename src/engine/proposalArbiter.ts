// Phase 1 (blueprint §18.13) — bus arbiter for the proposal protocol.
//
// Wraps the pure `resolve()` from `proposals.ts` with timing (≤10 Hz default)
// and bus glue. Subscribes to `proposal:bid` and emits `proposal:winner` once
// per tick. Designed to be cheap enough to live in the engine's hot path
// without inflating the System-2 frame budget — bids are buffered, the
// resolver runs once per window, and the buffer is dropped after.
//
// Design rules (matching the cognition modules):
//   - Resolver state is buffered, never persisted. A faculty that doesn't bid
//     within the window contributes nothing — same as silent.
//   - The arbiter never bids itself. It is the resolver, not a participant.
//   - All timing is injectable via `now()` + a manual `tick()` seam, so the
//     vitest suite can drive it deterministically (no real timers needed).
//   - `start()` is idempotent. `stop()` unsubscribes and clears the buffer.

import type { BrainEventBus } from "./BrainEventBus";
import { resolve, type Proposal, type ResolveOptions, type ResolveResult } from "./proposals";

export interface ProposalArbiterOptions {
  /** Tick interval in ms. Default 100ms (≤10Hz). */
  tickMs?: number;
  /**
   * Bids older than `windowMs` (measured against the arbiter's `now()`) are
   * dropped at tick-time. Defaults to 2 × tickMs so a bid emitted near the
   * end of the previous window still counts.
   */
  windowMs?: number;
  /** Softmax temperature forwarded to `resolve()`. */
  temperature?: number;
  /** Clock seam — defaults to performance.now() if available, Date.now() otherwise. */
  now?: () => number;
}

function defaultNow(): number {
  // performance.now() in the browser / jsdom; Date.now() in plain Node.
  const pf = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof pf?.now === "function" ? pf.now() : Date.now();
}

export class ProposalArbiter {
  private readonly tickMs: number;
  private readonly windowMs: number;
  private readonly temperature: number | undefined;
  private readonly now: () => number;

  private buffered: Proposal[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private offBid: (() => void) | null = null;

  constructor(
    private readonly bus: BrainEventBus,
    opts: ProposalArbiterOptions = {},
  ) {
    this.tickMs = Math.max(10, opts.tickMs ?? 100);
    this.windowMs = Math.max(this.tickMs, opts.windowMs ?? this.tickMs * 2);
    this.temperature = opts.temperature;
    this.now = opts.now ?? defaultNow;
  }

  /** Begin listening for bids and running ticks. Idempotent. */
  start(): void {
    if (this.offBid) return;
    this.offBid = this.bus.on("proposal:bid", (p) => {
      this.buffered.push(p);
    });
    this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  /** Stop ticking and drop the buffer. Safe to call after start() or never-started. */
  stop(): void {
    if (this.offBid) {
      this.offBid();
      this.offBid = null;
    }
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.buffered = [];
  }

  /**
   * Run a single arbitration round. Returns the resolve result (null when no
   * bids were in-window). Exposed for tests + for callers who want to drive
   * the arbiter manually instead of via `start()`'s timer.
   */
  tick(): ResolveResult | null {
    const cutoff = this.now() - this.windowMs;
    // Filter in-window bids; drop the rest.
    const active: Proposal[] = [];
    for (const p of this.buffered) {
      if (p.at >= cutoff) active.push(p);
    }
    this.buffered = [];

    if (active.length === 0) return null;

    const opts: ResolveOptions | undefined =
      this.temperature !== undefined ? { temperature: this.temperature } : undefined;
    const result = resolve(active, opts);
    this.bus.emit("proposal:winner", result);
    return result;
  }

  /** Test-only — current buffer size, for assertions. */
  get bufferSize(): number {
    return this.buffered.length;
  }
}
