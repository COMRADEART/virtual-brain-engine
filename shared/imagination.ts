export type ImaginationMode =
  | "future-prediction"
  | "workflow-rehearsal"
  | "mental-sandbox"
  | "dream-consolidation";

export type ImaginationFutureKind = "fast" | "safe" | "rollback" | "sandbox" | "defer";

export type ImaginationTimelineKind =
  | "thought-created"
  | "future-predicted"
  | "future-recommended"
  | "simulation-failed"
  | "execution-observed"
  | "prediction-corrected"
  | "abstraction-formed"
  | "dream-consolidated";

export interface ImaginationResourceForecast {
  cpuPeak: number;
  memoryPeak: number;
  diskChangeMb: number;
  networkRequired: boolean;
  estimatedDurationMs: number;
}

export interface ImaginationSideEffects {
  gitChanges: number;
  diskWrites: number;
  memoryWrites: number;
  dependencyChanges: number;
  rollbackComplexity: number;
}

export interface ImaginationStep {
  id: string;
  label: string;
  simulatedCommand?: string;
  probability: number;
  risk: number;
  notes: string[];
}

export interface MemoryInfluence {
  source: "memory" | "twin" | "workflow-history" | "swarm" | "heuristic" | "causal-map";
  label: string;
  weight: number;
  detail: string;
}

export interface ImaginationFuture {
  id: string;
  kind: ImaginationFutureKind;
  label: string;
  summary: string;
  confidence: number;
  ambiguity: number;
  risk: number;
  memoryReliability: number;
  executionProbability: number;
  safety: number;
  complexity: number;
  cost: number;
  score: number;
  resourceForecast: ImaginationResourceForecast;
  sideEffects: ImaginationSideEffects;
  failureModes: string[];
  recommendedActions: string[];
  steps: ImaginationStep[];
  influenceChain: MemoryInfluence[];
}

export interface ThoughtSpaceEntry {
  id: string;
  visibility: "private" | "validated";
  content: string;
  confidence: number;
  createdAt: string;
}

export interface ImaginationTimelineEntry {
  id: string;
  sessionId?: string;
  kind: ImaginationTimelineKind;
  title: string;
  detail: string;
  confidence: number;
  risk: number;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface ImaginationRecommendation {
  futureId: string;
  rationale: string;
  confidence: number;
  risk: number;
  approvalRequired: boolean;
}

export interface ImaginationSession {
  id: string;
  goal: string;
  action: string;
  mode: ImaginationMode;
  futures: ImaginationFuture[];
  recommendation: ImaginationRecommendation;
  thoughtSpace: ThoughtSpaceEntry[];
  timeline: ImaginationTimelineEntry[];
  createdAt: string;
}

export interface PredictionReflection {
  id: string;
  sessionId: string;
  futureId: string;
  predictedSummary: string;
  actualSummary: string;
  predictedRisk: number;
  actualRisk: number;
  accuracy: number;
  lesson: string;
  createdAt: string;
}

/**
 * Phase 3 — explicit 6-level abstraction ladder. The semantics live in
 * server/src/core/abstractionLevels.ts; this enum is the wire-shape consumers
 * can switch on without importing server code. Higher = more abstract.
 */
export type AbstractionLevel = 0 | 1 | 2 | 3 | 4 | 5;
export const ABSTRACTION_LEVEL_LABELS: Record<AbstractionLevel, string> = {
  0: "sensory",
  1: "pattern",
  2: "concept",
  3: "schema",
  4: "principle",
  5: "philosophical",
};

export interface CognitiveAbstraction {
  id: string;
  concept: string;
  evidence: string[];
  confidence: number;
  /** 0 sensory -> 5 philosophical. See ABSTRACTION_LEVEL_LABELS for the ladder. */
  level: AbstractionLevel;
  createdAt: string;
  updatedAt: string;
}

export interface ImaginationSnapshot {
  generatedAt: string;
  sessions: ImaginationSession[];
  timeline: ImaginationTimelineEntry[];
  reflections: PredictionReflection[];
  abstractions: CognitiveAbstraction[];
}
