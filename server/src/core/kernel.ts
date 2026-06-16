// Brain Kernel — the thin coordinator/status facade over the cognitive
// organism.
//
// Deliberately PASSIVE: the proven interval owners (the 60s agent cycle, the
// workspace cadence, the sleep schedule, organism autonomy) keep their timers
// — relocating them buys nothing and risks their failure-isolation paths. The
// kernel instead:
//
//   • keeps a REGISTRY of cognitive modules (brainCore registers each one as
//     it boots) with a tiny status probe per module — a throwing probe reports
//     {ok:false}, never propagates;
//   • observes the internal bus (onAny) and timestamps the last activity per
//     event kind, so `status()` shows what the organism has actually been
//     doing without polling anything;
//   • owns ONLY the new periodic work this layer added: the developmental-
//     stage recompute (core/stages.ts), every STAGE_RECOMPUTE_MS.
//
// `GET /api/brain/kernel` is the single status surface: every module, its
// health, the developmental stage + its gate metrics, and recent bus activity.

import { surfaceError } from "../util/diagnostics.js";
import { getEventBus, type BrainBus } from "./eventBus.js";
import { recomputeStage, emptyStageMetrics, type StageReport } from "./stages.js";

export interface ModuleStatus {
  ok: boolean;
  detail?: string;
}

export interface KernelModule {
  name: string;
  ok: boolean;
  detail?: string;
  registeredAt: string;
  lastActivityAt: string | null;
}

export interface KernelStatus {
  modules: KernelModule[];
  stage: StageReport;
  /** Last time each bus event kind fired (the organism's observable life). */
  recentEvents: Record<string, string>;
  updatedAt: string;
}

export const STAGE_RECOMPUTE_MS = 10 * 60_000;
const MAX_EVENT_KINDS = 64;

type StatusFn = () => ModuleStatus;

export class BrainKernel {
  private readonly modules = new Map<
    string,
    { statusFn: StatusFn; registeredAt: string; lastActivityAt: string | null }
  >();
  private readonly lastEventAt = new Map<string, string>();
  private unobserve: (() => void) | null = null;

  constructor(private readonly bus: BrainBus = getEventBus()) {}

  /** Start observing the bus (idempotent). */
  observe(): void {
    if (this.unobserve) return;
    this.unobserve = this.bus.onAny((event) => {
      if (this.lastEventAt.size < MAX_EVENT_KINDS || this.lastEventAt.has(event.kind)) {
        this.lastEventAt.set(event.kind, event.at);
      }
    });
  }

  registerModule(name: string, statusFn: StatusFn): void {
    this.modules.set(name, {
      statusFn,
      registeredAt: new Date().toISOString(),
      lastActivityAt: null,
    });
  }

  noteActivity(name: string): void {
    const mod = this.modules.get(name);
    if (mod) mod.lastActivityAt = new Date().toISOString();
  }

  /** The new periodic work the kernel owns: the stage ratchet. */
  startStageCycle(intervalMs = STAGE_RECOMPUTE_MS): () => void {
    // One immediate recompute so /api/brain/kernel is meaningful at boot.
    try {
      recomputeStage();
    } catch (err) {
      surfaceError("kernel.stageBoot", err);
    }
    const timer = setInterval(() => {
      try {
        recomputeStage();
      } catch (err) {
        surfaceError("kernel.stageCycle", err);
      }
    }, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
    return () => clearInterval(timer);
  }

  status(): KernelStatus {
    const modules: KernelModule[] = [];
    for (const [name, mod] of this.modules) {
      let probe: ModuleStatus;
      try {
        probe = mod.statusFn();
      } catch (err) {
        probe = { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
      modules.push({
        name,
        ok: probe.ok,
        detail: probe.detail,
        registeredAt: mod.registeredAt,
        lastActivityAt: mod.lastActivityAt,
      });
    }
    let stage: StageReport;
    try {
      stage = recomputeStage();
    } catch (err) {
      surfaceError("kernel.status.stage", err);
      stage = {
        stage: 1,
        name: "Memory",
        reachedAt: new Date().toISOString(),
        computed: {
          stage: 1,
          name: "Memory",
          satisfied: [],
          metrics: emptyStageMetrics(),
        },
        advanced: false,
      };
    }
    return {
      modules: modules.sort((a, b) => a.name.localeCompare(b.name)),
      stage,
      recentEvents: Object.fromEntries(this.lastEventAt),
      updatedAt: new Date().toISOString(),
    };
  }

  stop(): void {
    if (this.unobserve) {
      this.unobserve();
      this.unobserve = null;
    }
  }
}

let singleton: BrainKernel | null = null;

export function getKernel(): BrainKernel {
  if (!singleton) {
    singleton = new BrainKernel();
    singleton.observe();
  }
  return singleton;
}

export function __resetKernelForTests(): void {
  if (singleton) singleton.stop();
  singleton = null;
}
