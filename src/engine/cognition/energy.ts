// Phase 1 (blueprint §18.1) — unified cognitive energy ledger.
//
// Today the system tracks energy in TWO disjoint places:
//   (a) Engine-side: `HybridCognitiveCore` enforces `SLOW_FRAME_BUDGET_MS = 2.5`
//       — a hard real-time bound on System-2 deliberation per frame, and
//       meta-learning only runs with leftover budget.
//   (b) Server-side: `core/organism.ts` debits an energy budget per task and
//       writes `energy_usage`, while `cognitive_health.resource_balance`
//       tracks the remainder.
//
// Neither side knows about the other. The blueprint calls this out (§18.1):
// "these aren't a single ledger, and there's no *attention fatigue* curve that
// decays focus capacity with sustained load."
//
// This module is the unified ledger. It is PURE: no timers, no bus, no DB.
// The two existing energy sources become *readers* of this ledger; the
// uncertainty term in saliency (§18.2) reads `fatigue()` to amplify when the
// system is depleted. It is the caller's job to debit on each tick — same
// dependency-inversion pattern as proposals.ts and saliency.ts.
//
// Energy model (one-line summary):
//   energy ∈ [0,1], drains with debit() calls, regenerates with refresh() at
//   a configurable per-second rate. `fatigue` is the convex inverse of energy
//   so light depletion costs little but deep depletion compounds.
//
// Why a single number rather than a vector of buckets:
//   The first-cut model only needs to gate "spend more vs less". Splitting
//   into attention/reasoning/prefetch buckets only matters once a reader
//   needs to know WHICH bucket is empty. Defer that until a reader asks.

/** A discrete debit reason — only used for telemetry / breakdown. The
 *  ledger itself uses one pool; the tag is metadata. */
export type EnergyConsumer =
  | "attention"
  | "system2"
  | "prefetch"
  | "imagination"
  | "memory-write"
  | "other";

export interface EnergyOptions {
  /** Starting energy [0,1]. Default 1.0 (full). */
  initial?: number;
  /** Regen per second [0,1]. Default 0.05 (full recovery in ~20s of idle). */
  regenPerSecond?: number;
  /** Floor below which energy cannot drop. Default 0 (fully depletable). */
  floor?: number;
}

export interface EnergyBreakdown {
  /** Current energy in [floor,1]. */
  energy: number;
  /** Convex inverse — 0 when full, approaches 1 as energy approaches floor. */
  fatigue: number;
  /** Total debits this lifetime (rolling tally for the UI). */
  totalDebited: number;
  /** Per-consumer running totals. */
  byConsumer: Record<EnergyConsumer, number>;
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/**
 * Pure energy ledger.
 *
 * Usage pattern:
 *   const ledger = new EnergyLedger();
 *   // each frame / tick:
 *   ledger.refresh(dtSeconds);
 *   ledger.debit("system2", 0.02, "frame-budget exceeded");
 *   // read:
 *   const fatigue = ledger.fatigue();      // [0,1], feeds saliency uncertainty
 *   const ok = ledger.canSpend("attention", 0.05);
 */
export class EnergyLedger {
  private value: number;
  private readonly regen: number;
  private readonly floor: number;
  private debitedTotal = 0;
  private readonly byConsumer: Record<EnergyConsumer, number> = {
    attention: 0,
    system2: 0,
    prefetch: 0,
    imagination: 0,
    "memory-write": 0,
    other: 0,
  };

  constructor(opts: EnergyOptions = {}) {
    this.regen = Math.max(0, opts.regenPerSecond ?? 0.05);
    this.floor = clamp(opts.floor ?? 0, 0, 1);
    this.value = clamp(opts.initial ?? 1, this.floor, 1);
  }

  /** Current energy in [floor,1]. */
  energy(): number {
    return this.value;
  }

  /**
   * Convex inverse — small drains barely register; deep drains compound.
   * Formula: fatigue = 1 - energy^2. Smooth, monotone, returns 0 at full
   * energy and 1 at zero energy. Used by the saliency uncertainty term to
   * amplify scoring when the system is depleted.
   */
  fatigue(): number {
    const e = clamp(this.value, this.floor, 1);
    return clamp(1 - e * e, 0, 1);
  }

  /**
   * Debit energy with a reason tag. Returns the amount actually debited
   * (capped by the floor). Never throws.
   */
  debit(consumer: EnergyConsumer, amount: number, _reason?: string): number {
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    const before = this.value;
    this.value = clamp(this.value - amount, this.floor, 1);
    const taken = before - this.value;
    this.debitedTotal += taken;
    this.byConsumer[consumer] += taken;
    return taken;
  }

  /** Add energy back over a duration. dtSeconds * regen, clamped to 1. */
  refresh(dtSeconds: number): void {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return;
    this.value = clamp(this.value + this.regen * dtSeconds, this.floor, 1);
  }

  /** Check if a spend is possible without going under the floor. */
  canSpend(_consumer: EnergyConsumer, amount: number): boolean {
    if (!Number.isFinite(amount) || amount <= 0) return true;
    return this.value - amount >= this.floor;
  }

  /** One-shot reset to a fresh state (test seam + start-of-session). */
  reset(initial = 1): void {
    this.value = clamp(initial, this.floor, 1);
    this.debitedTotal = 0;
    for (const k of Object.keys(this.byConsumer) as EnergyConsumer[]) {
      this.byConsumer[k] = 0;
    }
  }

  /** Snapshot for telemetry / debug overlay. */
  snapshot(): EnergyBreakdown {
    return {
      energy: this.value,
      fatigue: this.fatigue(),
      totalDebited: this.debitedTotal,
      byConsumer: { ...this.byConsumer },
    };
  }
}

/**
 * Map fatigue [0,1] → saliency `uncertainty` term [0,1].
 *
 * Identity for now (`fatigue → uncertainty` 1:1) — the blueprint says
 * "fatigue feeds the saliency `uncertainty` term," and a 1:1 pass-through is
 * the conservative first cut. Wrapped in a helper so future tuning has a
 * single location to change.
 */
export function fatigueToUncertainty(fatigue: number): number {
  return clamp(fatigue, 0, 1);
}
