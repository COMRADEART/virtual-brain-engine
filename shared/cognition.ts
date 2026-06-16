// Unified cognition event — ONE observable stream for the organism's inner
// life. Shared between the Vite frontend and the Express server. No runtime
// deps beyond plain constants (the shared/ contract).
//
// Every cognitive subsystem that "does something mental" (forms a belief,
// grows a goal, spikes curiosity, reflects, dreams, learns a procedure,
// advances a developmental stage, or simply thinks) emits one of these. The
// server bridge (agents/brainCore.ts) fans them to the browser as the
// `cognition` BrainBusMessage; BrainScene flashes `logicalRegions` and the
// CognitionStreamPanel renders the running thought stream.
//
// `regionsFor` maps each kind onto the EXISTING 8 logical cortices — adding a
// cognition kind never requires touching the anatomical/logical region model.

import type { LogicalRegionId } from "./pipeline";

export type CognitionKind =
  | "belief-formed"
  | "belief-update"
  | "goal-formed"
  | "goal-progress"
  | "curiosity-spike"
  | "reflection"
  | "dream"
  | "thought"
  | "monologue"
  | "procedure-learned"
  | "stage-advance";

export const COGNITION_KINDS: CognitionKind[] = [
  "belief-formed",
  "belief-update",
  "goal-formed",
  "goal-progress",
  "curiosity-spike",
  "reflection",
  "dream",
  "thought",
  "monologue",
  "procedure-learned",
  "stage-advance",
];

export interface CognitionEvent {
  kind: CognitionKind;
  /** One-line human-readable label (what just happened). */
  label: string;
  /** Optional longer detail. Truncate at the producer — the bus never carries bodies. */
  detail?: string;
  /** [0,1] — drives the 3D flash gain and the stream's emphasis. */
  magnitude: number;
  /** Which of the 8 logical cortices light up. Usually regionsFor(kind). */
  logicalRegions: LogicalRegionId[];
  /** Stable producer key, e.g. "belief-engine", "workspace:goal", "sleep-cycle". */
  reason: string;
  at: string;
}

/** Kind → the existing logical cortices that should flash. Pure data. */
export function regionsFor(kind: CognitionKind): LogicalRegionId[] {
  switch (kind) {
    case "belief-formed":
    case "belief-update":
      return ["learning-feedback-center", "error-detection-center"];
    case "goal-formed":
    case "goal-progress":
      return ["project-cortex"];
    case "curiosity-spike":
      return ["reasoning-cortex"];
    case "reflection":
    case "dream":
      return ["memory-core", "reasoning-cortex"];
    case "thought":
    case "monologue":
      return ["reasoning-cortex", "response-center"];
    case "procedure-learned":
      return ["learning-feedback-center"];
    case "stage-advance":
      return ["response-center"];
  }
}

/** Clamp a magnitude into [0,1]; non-finite values collapse to 0. */
export function clampMagnitude(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ── Brain Kernel wire shapes (GET /api/brain/kernel) ─────────────────────────
// The frontend's view of the kernel status. The server's KernelStatus carries
// MORE fields (structural superset); these are the parts the UI consumes.

export interface KernelModuleInfo {
  name: string;
  ok: boolean;
  detail?: string;
  registeredAt: string;
  lastActivityAt: string | null;
}

export interface DevelopmentalStageInfo {
  /** 1-9, monotonic. */
  stage: number;
  name: string;
  reachedAt: string;
}

export interface KernelStatusInfo {
  modules: KernelModuleInfo[];
  stage: DevelopmentalStageInfo;
  recentEvents: Record<string, string>;
  updatedAt: string;
}
