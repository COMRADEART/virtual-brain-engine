// Shared between the Vite frontend (src/...) and the Express server
// (server/src/...). No runtime deps -- pure type definitions.

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
  // Final answer attached on the last `learning` complete event so the
  // frontend's AskPanel has a single source of truth without polling.
  finalAnswer?: string;
  timestamp: string;
}

export type BrainBusMessage =
  | ({ type: "pipeline" } & PipelineEvent)
  | { type: "scan"; processed: number; total: number; current?: string; done?: boolean }
  | { type: "connector"; connectorId: string; state: "idle" | "busy" | "unreachable" | "ok"; message?: string };
