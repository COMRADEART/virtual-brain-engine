// The internal "nervous system" of the COMPUTER BRAIN agentic layer.
//
// This is a typed, in-process event bus. It deliberately has ZERO project
// dependencies (only node:events) so the agent runtime and its self-check can
// import it without dragging in SQLite, the WS hub, or connectors. The bridge
// that fans selected events out to the browser over /ws/brain lives in
// agents/brainCore.ts, NOT here — keeping this module pure is what lets
// `npm --prefix server run agents:selfcheck` stay offline and deterministic.

import { EventEmitter } from "node:events";
// Type-only import: erased at compile, so this keeps the "zero runtime deps"
// guarantee above intact (the offline self-check still imports this module
// without dragging in SQLite or shared/ runtime code — there is none).
import type { TwinSnapshot, TwinAnomaly } from "../../../shared/twin.js";
import type { SwarmEvent, SwarmSnapshot } from "../../../shared/swarm.js";
import type {
  CognitiveAbstraction,
  ImaginationSession,
  ImaginationSnapshot,
  PredictionReflection,
} from "../../../shared/imagination.js";
import type {
  EvolutionExperiment,
  EvolutionMutation,
  EvolutionSnapshot,
  IdentityTrait,
} from "../../../shared/evolution.js";
import type {
  ImmuneEvent,
  OrganismLifecycleState,
  OrganismSnapshot,
} from "../../../shared/organism.js";

/**
 * Internal events emitted by agents. These are distinct from the frontend
 * `BrainBusMessage` (shared/pipeline.ts): the bridge in brainCore.ts maps the
 * subset that the UI cares about onto that wire shape.
 */
export type BrainEvent =
  | {
      kind: "file-changed";
      path: string;
      change: "add" | "change" | "unlink";
      projectName: string;
      at: string;
    }
  | {
      kind: "activity-observed";
      projectName: string;
      files: string[];
      at: string;
    }
  | {
      kind: "summary-created";
      memoryId: string;
      projectName: string | null;
      summary: string;
      at: string;
    }
  | {
      kind: "agent-status";
      agent: string;
      state: "init" | "idle" | "thinking" | "acting" | "error" | "stopped";
      detail?: string;
      at: string;
    }
  | {
      kind: "twin-snapshot";
      snapshot: TwinSnapshot;
      at: string;
    }
  | {
      kind: "twin-anomaly";
      anomaly: TwinAnomaly;
      at: string;
    }
  | {
      kind: "swarm-event";
      event: SwarmEvent;
      at: string;
    }
  | {
      kind: "swarm-snapshot";
      snapshot: SwarmSnapshot;
      at: string;
    }
  | {
      kind: "imagination-session";
      session: ImaginationSession;
      at: string;
    }
  | {
      kind: "imagination-reflection";
      reflection: PredictionReflection;
      at: string;
    }
  | {
      kind: "imagination-dream";
      abstractions: CognitiveAbstraction[];
      at: string;
    }
  | {
      kind: "imagination-snapshot";
      snapshot: ImaginationSnapshot;
      at: string;
    }
  | {
      kind: "evolution-snapshot";
      snapshot: EvolutionSnapshot;
      at: string;
    }
  | {
      kind: "evolution-mutation";
      mutation: EvolutionMutation;
      at: string;
    }
  | {
      kind: "evolution-experiment";
      experiment: EvolutionExperiment;
      at: string;
    }
  | {
      kind: "evolution-trait";
      trait: IdentityTrait;
      at: string;
    }
  | {
      kind: "organism-snapshot";
      snapshot: OrganismSnapshot;
      at: string;
    }
  | {
      kind: "organism-lifecycle";
      lifecycle: OrganismLifecycleState;
      reason: string;
      at: string;
    }
  | {
      kind: "organism-immune-event";
      event: ImmuneEvent;
      at: string;
    }
  | {
      // Phase 1 (blueprint) — idle-cognition agent emits one of these when the
      // system has been quiet for a while AND the rate-limiter permits. Carries
      // a memory the brain is "re-surfacing" — frontend shows it in a dim
      // ticker overlay so the system feels alive between prompts.
      kind: "idle-thought";
      memoryId: string;
      preview: string;
      importance: number;
      reason: string;
      at: string;
    }
  | {
      // Phase 3 (improvement plan §18.5) — curiosity self-initiation. When the
      // engine reports high curiosity (system-wide uncertainty about an under-
      // explored area), the idle agent fires this variant *instead* of the
      // normal idle-thought. The carried `target` names what to explore — a
      // memory cluster id, a project name, or "scan" for a fresh file walk.
      kind: "exploration-scheduled";
      target: string;
      curiosity: number;
      reason: string;
      at: string;
    };

export type BrainEventKind = BrainEvent["kind"];
export type BrainEventOf<K extends BrainEventKind> = Extract<BrainEvent, { kind: K }>;

type AnyHandler = (event: BrainEvent) => void;
type KindHandler<K extends BrainEventKind> = (event: BrainEventOf<K>) => void;

const ANY = "*";

/**
 * Typed wrapper around node:events. `emit` is synchronous fan-out; handlers
 * that throw are isolated so one bad subscriber can't wedge the bus.
 */
export class BrainBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Agents + observers can stack up; the default 10-listener warning is
    // noise here, not a leak.
    this.emitter.setMaxListeners(64);
  }

  emit(event: BrainEvent): void {
    this.emitter.emit(event.kind, event);
    this.emitter.emit(ANY, event);
  }

  /** Subscribe to one event kind. Returns an unsubscribe fn. */
  on<K extends BrainEventKind>(kind: K, handler: KindHandler<K>): () => void {
    const wrapped = (event: BrainEvent): void => {
      try {
        handler(event as BrainEventOf<K>);
      } catch (err) {
        console.warn(`[brainBus] handler for "${kind}" threw:`, err);
      }
    };
    this.emitter.on(kind, wrapped);
    return () => this.emitter.off(kind, wrapped);
  }

  /** Subscribe to every event. Returns an unsubscribe fn. */
  onAny(handler: AnyHandler): () => void {
    const wrapped = (event: BrainEvent): void => {
      try {
        handler(event);
      } catch (err) {
        console.warn("[brainBus] onAny handler threw:", err);
      }
    };
    this.emitter.on(ANY, wrapped);
    return () => this.emitter.off(ANY, wrapped);
  }

  removeAll(): void {
    this.emitter.removeAllListeners();
  }
}

let singleton: BrainBus | null = null;

/** Process-wide bus the server uses. Tests construct their own instead. */
export function getEventBus(): BrainBus {
  if (!singleton) {
    singleton = new BrainBus();
  }
  return singleton;
}

export function nowIso(): string {
  return new Date().toISOString();
}
