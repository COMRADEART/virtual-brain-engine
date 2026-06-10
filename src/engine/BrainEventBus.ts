// BrainEventBus — typed, synchronous publish/subscribe bus for the Advanced Brain
// =============================================================================
//
// WHY THIS EXISTS
// ---------------
// The advanced brain is built from several subsystems (neurons, connectome,
// neuromodulation, oscillations, predictive coding, memory, homeostasis). They
// need to talk to each other and to the outside world (the React/Three.js layer)
// WITHOUT importing each other directly — otherwise the dependency graph turns
// into a knot and you can't unit-test or swap a module.
//
// The bus is the decoupling seam. `AdvancedBrainCore` owns one bus instance and
// hands it to every subsystem. A subsystem emits domain events ("a population of
// hippocampal neurons just burst", "a large prediction error appeared in V1")
// and any other subsystem — or the visualiser — can subscribe.
//
// DESIGN NOTES
// ------------
// * Fully typed: the `BrainEventMap` below is the single source of truth for the
//   event names and their payload shapes. `emit`/`on` are generic over it, so a
//   typo in an event name or payload is a compile error, not a runtime surprise.
// * Synchronous + allocation-light: events fire inline inside the simulation
//   step (which runs ~60×/s), so we avoid per-emit array allocations and never
//   touch microtasks/promises. Handlers should be cheap.
// * Re-entrancy safe: we snapshot the listener set before dispatch so a handler
//   that subscribes/unsubscribes mid-dispatch doesn't corrupt the iteration.

import type { BrainRegionId } from "./types";
import type { Proposal, ResolveResult } from "./proposals";

/** A neuromodulator identifier shared across the advanced subsystem. */
export type Neuromodulator =
  | "dopamine"
  | "acetylcholine"
  | "serotonin"
  | "norepinephrine";

/** Canonical oscillation bands used across oscillation + coupling code. */
export type OscillationBand = "theta" | "alpha" | "beta" | "gamma";

/**
 * The complete catalogue of events the advanced brain can emit. Add a key here
 * and every `emit`/`on` call site is type-checked against it automatically.
 */
export interface BrainEventMap {
  /** A burst of spiking activity localised to one region this step. */
  "region:burst": { regionId: BrainRegionId; rate: number; t: number };
  /** A phasic neuromodulator release (reward, surprise, salience…). */
  "neuromod:release": { modulator: Neuromodulator; amount: number; reason: string };
  /** A prediction error surfaced by the predictive-coding hierarchy. */
  "predict:error": { regionId: BrainRegionId; magnitude: number; precision: number };
  /** Global free-energy estimate updated (surprise the brain is minimising). */
  "predict:freeEnergy": { value: number };
  /** Hippocampal/neocortical replay event (consolidation). */
  "memory:replay": { region: "hippocampus" | "neocortex"; memoryIds: string[] };
  /** A new memory was encoded into the episodic store. */
  "memory:encode": { id: string; importance: number };
  /** The active cognitive state (Focus, Recall, Creative…) changed. */
  "state:change": { name: string };
  /** Criticality / homeostasis telemetry: branching ratio σ (≈1 at criticality). */
  "dynamics:criticality": { branchingRatio: number; meanRate: number };
  // ── Higher-cognition layer (HybridCognitiveCore and its subsystems) ──────────
  /** Reinforcement: a TD/reward-prediction-error update with the resulting affect. */
  "rl:rpe": { delta: number; value: number; valence: number; arousal: number };
  /** Meta-learning: a fresh composite-IQ report at an episode boundary. */
  "meta:iq": { value: number; components: Record<string, number>; probe: number };
  /** Arbitration switched the controlling thinking system. */
  "cognition:mode": { mode: "system1" | "system2" | "hybrid"; uncertainty: number };
  /** System 2 emitted one reasoning step (for the introspection feed). */
  "reason:step": { kind: string; explain: string; depth: number; confidence: number };
  // ── Proposal protocol (blueprint §18.4 / §18.11 / §18.13) ───────────────────
  /** A faculty bids into the current arbitration round. */
  "proposal:bid": Proposal;
  /** The arbiter has resolved the round and announces the winner + ranked set. */
  "proposal:winner": ResolveResult;
}

export type BrainEventName = keyof BrainEventMap;
export type BrainEventHandler<K extends BrainEventName> = (
  payload: BrainEventMap[K],
) => void;

export class BrainEventBus {
  // One Set of handlers per event name. Sets give O(1) add/remove and natural
  // de-duplication of the same handler reference.
  private readonly handlers = new Map<BrainEventName, Set<BrainEventHandler<BrainEventName>>>();

  /**
   * Subscribe to an event. Returns an unsubscribe function — store it and call
   * it in your teardown so listeners don't leak across simulation rebuilds.
   */
  on<K extends BrainEventName>(name: K, handler: BrainEventHandler<K>): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(handler as BrainEventHandler<BrainEventName>);
    return () => {
      this.handlers.get(name)?.delete(handler as BrainEventHandler<BrainEventName>);
    };
  }

  /** Subscribe for a single firing, then auto-unsubscribe. */
  once<K extends BrainEventName>(name: K, handler: BrainEventHandler<K>): () => void {
    const off = this.on(name, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  /**
   * Emit an event to all current subscribers. Listeners are snapshotted first so
   * a handler may safely subscribe/unsubscribe during dispatch. A throwing
   * handler is isolated so it can't abort the simulation step.
   */
  emit<K extends BrainEventName>(name: K, payload: BrainEventMap[K]): void {
    const set = this.handlers.get(name);
    if (!set || set.size === 0) {
      return;
    }
    // Snapshot only when there's more than one listener (the common case is one).
    const listeners = set.size === 1 ? set : Array.from(set);
    for (const handler of listeners) {
      try {
        (handler as BrainEventHandler<K>)(payload);
      } catch (error) {
        // A bad visualiser/listener must never crash the brain loop.
        console.error(`[BrainEventBus] handler for "${name}" threw:`, error);
      }
    }
  }

  /** Drop every listener (used on teardown / engine rebuild). */
  clear(): void {
    this.handlers.clear();
  }
}
