// Shared between the Vite frontend (src/...) and the Express server
// (server/src/...). No runtime deps -- pure type definitions.

import type { TwinSnapshot, TwinAnomaly } from "./twin";
import type { SwarmSnapshot, SwarmEvent } from "./swarm";
import type {
  EvolutionSnapshot,
  EvolutionMutation,
  EvolutionExperiment,
  IdentityTrait,
} from "./evolution";
import type {
  ImaginationSession,
  ImaginationSnapshot,
  PredictionReflection,
  CognitiveAbstraction,
} from "./imagination";
import type {
  ImmuneEvent,
  OrganismLifecycleState,
  OrganismSnapshot,
} from "./organism";
import type { BrainBusVisualMessage } from "./vision";
import type { BrainStateSnapshot } from "./brainState";
import type { SelfConsciousnessState } from "./selfConsciousness";

export type LogicalRegionId =
  | "memory-core"
  | "reasoning-cortex"
  | "project-cortex"
  | "file-memory"
  | "model-hub"
  | "response-center"
  | "error-detection-center"
  | "learning-feedback-center";

export const LOGICAL_REGION_IDS: LogicalRegionId[] = [
  "memory-core",
  "reasoning-cortex",
  "project-cortex",
  "file-memory",
  "model-hub",
  "response-center",
  "error-detection-center",
  "learning-feedback-center",
];

export type PipelineStepId =
  | "input"
  | "memory"
  | "reasoning"
  | "project"
  | "error"
  | "response"
  | "learning";

export const PIPELINE_STEP_ORDER: PipelineStepId[] = [
  "input",
  "memory",
  "reasoning",
  "project",
  "error",
  "response",
  "learning",
];

export type PipelineStatus = "start" | "progress" | "complete" | "error";

export interface PipelineCitation {
  memoryId: string;
  filePath?: string;
  score?: number;
}

export interface PipelineEvent {
  conversationId: string;
  runId: string;
  step: PipelineStepId;
  status: PipelineStatus;
  logicalRegions: LogicalRegionId[];
  detail?: string;
  citations?: PipelineCitation[];
  tokensDelta?: string;
  finalAnswer?: string;
  timestamp: string;
}

export type AgentRuntimeState = "idle" | "thinking" | "acting" | "error" | "init" | "stopped";

export type BrainBusMessage =
  | ({ type: "pipeline" } & PipelineEvent)
  | { type: "scan"; processed: number; total: number; current?: string; done?: boolean }
  | { type: "connector"; connectorId: string; state: "idle" | "busy" | "unreachable" | "ok"; message?: string }
  | { type: "memory-count"; count: number }
  | { type: "consolidation"; detail: string; status: "start" | "complete" | "progress" }
  // Generic diagnostic — surfaces a previously-swallowed error (a write that must
  // not break its caller's flow) so it stops being silent. `source` is a stable
  // call-site key; the server also keeps a per-source counter (see /api/health).
  | { type: "diagnostic"; source: string; level: "warn" | "error"; message: string; timestamp: string }
  // --- Memory replay (hippocampal-neocortical consolidation) ---
  | { type: "replay"; memoryIds: string[]; region: "hippocampus" | "neocortex"; thetaPhase: "peak" | "trough"; timestamp: string }
  // --- Computer Brain agentic layer (brainCore.ts bridge) ---
  | { type: "file-changed"; path: string; change: "add" | "change" | "unlink"; projectName: string; timestamp: string }
  | { type: "activity-observed"; projectName: string; fileCount: number; detail: string; timestamp: string }
  | { type: "summary-created"; memoryId: string; projectName: string | null; summary: string; timestamp: string }
  | { type: "agent-status"; agent: string; state: AgentRuntimeState; detail?: string; timestamp: string }
  // --- Digital Twin ---
  | { type: "twin-snapshot"; snapshot: TwinSnapshot; timestamp: string }
  | { type: "twin-anomaly"; anomaly: TwinAnomaly; timestamp: string }
  // --- Swarm ---
  | { type: "swarm-snapshot"; snapshot: SwarmSnapshot; timestamp: string }
  | { type: "swarm-event"; event: SwarmEvent; timestamp: string }
  // --- Evolution ---
  | { type: "evolution-snapshot"; snapshot: EvolutionSnapshot; timestamp: string }
  | { type: "evolution-mutation"; mutation: EvolutionMutation; timestamp: string }
  | { type: "evolution-experiment"; experiment: EvolutionExperiment; timestamp: string }
  | { type: "evolution-trait"; trait: IdentityTrait; timestamp: string }
  // --- Imagination ---
  | { type: "imagination-snapshot"; snapshot: ImaginationSnapshot; timestamp: string }
  | { type: "imagination-session"; session: ImaginationSession; timestamp: string }
  | { type: "imagination-prediction"; prediction: PredictionReflection; timestamp: string }
  | { type: "imagination-reflection"; reflection: PredictionReflection; timestamp: string }
  | { type: "imagination-dream"; abstractions: CognitiveAbstraction[]; timestamp: string }
  // --- Organism ---
  | { type: "organism-snapshot"; snapshot: OrganismSnapshot; timestamp: string }
  | { type: "organism-lifecycle"; lifecycle: OrganismLifecycleState; reason: string; timestamp: string }
  | { type: "organism-immune-event"; event: ImmuneEvent; timestamp: string }
  // --- Vision (delegated to BrainBusVisualMessage) ---
  | BrainBusVisualMessage
  // --- Perception (Phase 3 worker sidecar) ---
  // Truncated preview only — raw audio/image payloads never cross the bus.
  // "frame" = a screen frame parsed by OmniParser into UI elements + OCR.
  | { type: "perception"; kind: "transcribe" | "caption" | "frame"; preview: string; model: string; latencyMs: number; timestamp: string }
  // --- Idle cognition (blueprint Phase 1 — IdleAgent) ---
  // Emitted when the system has been quiet long enough AND the rate-limiter
  // permits. Carries the memory the brain is re-surfacing; preview is truncated
  // to <=200 chars so the bus never carries full memory bodies.
  | { type: "idle-thought"; memoryId: string; preview: string; importance: number; reason: string; timestamp: string }
  // --- Exploration scheduling (Phase 3 — curiosity self-initiation, §18.5) ---
  // Emitted by the idle agent in place of `idle-thought` when curiosity is high
  // (engine uncertainty crosses a threshold). The `target` names what to
  // explore (project name, memory cluster id, or "scan" for a fresh walk).
  | { type: "exploration-scheduled"; target: string; curiosity: number; reason: string; timestamp: string }
  // --- Model Hub (download a model → it streams into the brain) ---
  // Emitted (throttled) while an Ollama model downloads; the frontend flashes
  // the `model-hub` cortex and renders a progress bar. percent is null while
  // indeterminate (manifest phase, before any layer total is known).
  | { type: "model-pull"; model: string; status: string; percent: number | null; done: boolean; timestamp: string }
  // --- Learning Lab (online ranker training signal) ---
  // Emitted after an explicit-feedback update so an open Learning Lab panel
  // refreshes its stats without polling.
  | {
      type: "learning-update";
      feedback: { up: number; down: number; total: number };
      trainedCount: number;
      timestamp: string;
    }
  // --- From-scratch brain-LLM training progress (boot auto-train → TrainingBar) ---
  // Broadcast (throttled to the watcher's poll cadence) while the worker trains
  // the brain's own from-scratch model, so the UI renders a live progress bar.
  | {
      type: "llm-training";
      state: "running" | "done" | "error";
      step: number;
      totalSteps: number;
      loss: number | null;
      params: number | null;
      device: string | null;
      timestamp: string;
    }
  // --- Central cognitive loop (brainState.ts → brainCore.ts bridge) ---
  // Emitted (throttled) whenever the unified BrainState changes, so the
  // BrainStatePanel reflects the live attention map / working memory /
  // confidence without polling.
  | { type: "brain-state"; snapshot: BrainStateSnapshot; timestamp: string }
  // --- Self-Consciousness (selfConsciousness.ts → brainCore.ts bridge) ---
  // Emitted whenever the self-model, affect, or metacognitive state changes
  // so the SelfConsciousnessPanel reflects live updates without polling.
  | { type: "self-snapshot"; state: SelfConsciousnessState; timestamp: string };