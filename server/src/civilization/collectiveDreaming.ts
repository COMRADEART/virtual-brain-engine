import { ulid } from "ulid";
import type { InterBrainMessage } from "../../../shared/civilization.js";
import { BrainNetwork } from "./brainNetwork.js";

/**
 * Collective Dreaming (architecture component #17).
 *
 * During low system activity, brains cooperate on shared optimisation —
 * distributed architecture evolution, reasoning/abstraction refinement, memory
 * compression, civilization forecasting. The local analogue is the single-brain
 * idle/consolidation tick; this spreads it across peers. A dream cycle collects
 * "insights" (each with a small optimisation gain) and consolidates them into one
 * result when the cycle closes. Triggered by `maybeDream(activityLevel)`.
 */

export type DreamFocus =
  | "architecture-evolution"
  | "reasoning-optimization"
  | "knowledge-abstraction"
  | "memory-compression"
  | "civilization-forecast";

export interface DreamInsight {
  id: string;
  brainId: string;
  focus: DreamFocus;
  description: string;
  /** Estimated optimisation gain in [0, 1]. */
  gain: number;
  createdAt: string;
}

export interface DreamCycle {
  id: string;
  focus: DreamFocus;
  participants: string[];
  insights: DreamInsight[];
  status: "dreaming" | "consolidated";
  totalGain: number;
  result?: string;
  startedAt: string;
  consolidatedAt?: string;
}

export interface CollectiveDreamingConfig {
  /** Activity level (0..1) at or below which dreaming may begin. */
  activityThreshold: number;
  /** Minimum ms between auto-triggered cycles. */
  minCycleIntervalMs: number;
  maxCycles: number;
}

const DEFAULT_CONFIG: CollectiveDreamingConfig = {
  activityThreshold: 0.2,
  minCycleIntervalMs: 5 * 60 * 1000,
  maxCycles: 100,
};

export interface CollectiveDreamingEventHandlers {
  onDreamStarted?: (cycle: DreamCycle) => void;
  onDreamConsolidated?: (cycle: DreamCycle) => void;
}

const FOCI: DreamFocus[] = [
  "architecture-evolution",
  "reasoning-optimization",
  "knowledge-abstraction",
  "memory-compression",
  "civilization-forecast",
];

export class CollectiveDreaming {
  private readonly config: CollectiveDreamingConfig;
  private readonly network: BrainNetwork;
  private readonly handlers: CollectiveDreamingEventHandlers;
  private readonly cycles = new Map<string, DreamCycle>();
  private myBrainId = "self";
  private lastCycleAt = 0;

  constructor(
    network: BrainNetwork,
    config: Partial<CollectiveDreamingConfig> = {},
    handlers: CollectiveDreamingEventHandlers = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.network = network;
    this.handlers = handlers;
  }

  setMyBrainId(brainId: string): void {
    this.myBrainId = brainId;
  }

  start(): void {
    // Driven externally by `maybeDream`; no timer of its own.
  }

  stop(): void {
    // No resources held.
  }

  /** Begin a dream cycle if the network is quiet enough and the cooldown elapsed. */
  maybeDream(activityLevel: number, participants: string[], focus?: DreamFocus): DreamCycle | null {
    const now = Date.now();
    if (activityLevel > this.config.activityThreshold) return null;
    if (now - this.lastCycleAt < this.config.minCycleIntervalMs) return null;
    return this.startCycle(focus ?? this.pickFocus(now), participants);
  }

  startCycle(focus: DreamFocus, participants: string[]): DreamCycle {
    const cycle: DreamCycle = {
      id: `dream-${ulid()}`,
      focus,
      participants: participants.includes(this.myBrainId) ? participants : [this.myBrainId, ...participants],
      insights: [],
      status: "dreaming",
      totalGain: 0,
      startedAt: new Date().toISOString(),
    };
    this.cycles.set(cycle.id, cycle);
    this.lastCycleAt = Date.now();
    this.pruneCycles();
    this.broadcast("dream-sync", { cycleId: cycle.id, focus, participants: cycle.participants });
    this.handlers.onDreamStarted?.(cycle);
    return cycle;
  }

  contributeInsight(cycleId: string, brainId: string, description: string, gain: number): DreamInsight | null {
    const cycle = this.cycles.get(cycleId);
    if (!cycle || cycle.status !== "dreaming") return null;
    const insight: DreamInsight = {
      id: ulid(),
      brainId,
      focus: cycle.focus,
      description,
      gain: Math.max(0, Math.min(1, gain)),
      createdAt: new Date().toISOString(),
    };
    cycle.insights.push(insight);
    cycle.totalGain += insight.gain;
    return insight;
  }

  consolidate(cycleId: string): DreamCycle | null {
    const cycle = this.cycles.get(cycleId);
    if (!cycle || cycle.status === "consolidated") return cycle ?? null;
    cycle.status = "consolidated";
    cycle.consolidatedAt = new Date().toISOString();
    const top = [...cycle.insights].sort((a, b) => b.gain - a.gain)[0];
    cycle.result = top
      ? `${cycle.insights.length} insights on ${cycle.focus}; best: "${top.description}" (+${top.gain.toFixed(2)}), total gain ${cycle.totalGain.toFixed(2)}`
      : `no insights produced for ${cycle.focus}`;
    this.broadcast("dream-result", { cycleId, result: cycle.result, totalGain: cycle.totalGain });
    this.handlers.onDreamConsolidated?.(cycle);
    return cycle;
  }

  getCycle(cycleId: string): DreamCycle | undefined {
    return this.cycles.get(cycleId);
  }

  getActiveCycles(): DreamCycle[] {
    return Array.from(this.cycles.values()).filter((c) => c.status === "dreaming");
  }

  getAllCycles(): DreamCycle[] {
    return Array.from(this.cycles.values());
  }

  private pickFocus(seed: number): DreamFocus {
    return FOCI[seed % FOCI.length];
  }

  private pruneCycles(): void {
    if (this.cycles.size <= this.config.maxCycles) return;
    const consolidated = this.getAllCycles()
      .filter((c) => c.status === "consolidated")
      .sort((a, b) => (a.consolidatedAt ?? "").localeCompare(b.consolidatedAt ?? ""));
    for (const c of consolidated) {
      if (this.cycles.size <= this.config.maxCycles) break;
      this.cycles.delete(c.id);
    }
  }

  private broadcast(type: InterBrainMessage["type"], payload: unknown): void {
    this.network.broadcast({
      id: ulid(),
      type,
      sourceBrainId: this.myBrainId,
      payload,
      timestamp: new Date().toISOString(),
    });
  }
}

let singleton: CollectiveDreaming | null = null;

export function createCollectiveDreaming(
  network: BrainNetwork,
  config?: Partial<CollectiveDreamingConfig>,
  handlers?: CollectiveDreamingEventHandlers,
): CollectiveDreaming {
  if (!singleton) {
    singleton = new CollectiveDreaming(network, config, handlers);
  }
  return singleton;
}

export function getCollectiveDreaming(): CollectiveDreaming | null {
  return singleton;
}
