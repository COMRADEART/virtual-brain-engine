export type EvolutionComponentKind =
  | "workflow"
  | "skill"
  | "reasoning-strategy"
  | "memory-model"
  | "planner"
  | "tool-router"
  | "execution-graph"
  | "architecture"
  | "identity-trait"
  | "cognitive-region";

export type EvolutionStatus =
  | "candidate"
  | "sandboxed"
  | "benchmarked"
  | "approved"
  | "applied"
  | "retired"
  | "rejected";

export type MutationKind =
  | "split"
  | "merge"
  | "specialize"
  | "reorder"
  | "parallelize"
  | "prune"
  | "promote"
  | "rollback";

export type ReasoningStrategyKind =
  | "chain-of-thought"
  | "tree-of-thought"
  | "graph-reasoning"
  | "simulation-first"
  | "consensus"
  | "decomposition";

export interface CognitiveFitnessMetrics {
  successRate: number;
  latencyScore: number;
  reliability: number;
  predictionAccuracy: number;
  memoryQuality: number;
  planningEfficiency: number;
  safetyScore: number;
  userSatisfaction: number;
  costScore: number;
  overall: number;
}

export interface CognitiveGenome {
  structure: string[];
  dependencies: string[];
  mutationHistory: string[];
  inheritedOptimizations: string[];
  safetyConstraints: string[];
  fitnessScore: number;
}

export interface EvolutionComponent {
  id: string;
  kind: EvolutionComponentKind;
  name: string;
  version: number;
  parentId?: string;
  status: EvolutionStatus;
  description: string;
  tags: string[];
  genome: CognitiveGenome;
  metrics: CognitiveFitnessMetrics;
  preferred?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EvolutionBenchmark {
  durationMs: number;
  sampleSize: number;
  baselineFitness: number;
  candidateFitness: number;
  stability: number;
  rollbackReady: boolean;
  approvalRequired: boolean;
  notes: string[];
}

export interface EvolutionMutation {
  id: string;
  componentId: string;
  kind: MutationKind;
  before: CognitiveGenome;
  after: CognitiveGenome;
  benchmark: EvolutionBenchmark;
  reversible: boolean;
  requiresApproval: boolean;
  status: EvolutionStatus;
  createdAt: string;
}

export interface EvolutionExperiment {
  id: string;
  name: string;
  targetKind: EvolutionComponentKind;
  hypothesis: string;
  resultSummary: string;
  result: CognitiveFitnessMetrics;
  fitnessDelta: number;
  safe: boolean;
  createdAt: string;
}

export interface EvolutionAudit {
  id: string;
  action: string;
  detail: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface IdentityTrait {
  id: string;
  trait: string;
  evidence: string[];
  confidence: number;
  stability: number;
  createdAt: string;
  updatedAt: string;
}

export interface CognitiveRegion {
  id: string;
  name: string;
  focus: EvolutionComponentKind;
  load: number;
  maturity: number;
  components: string[];
}

export interface EvolutionSnapshot {
  generatedAt: string;
  components: EvolutionComponent[];
  mutations: EvolutionMutation[];
  experiments: EvolutionExperiment[];
  identityTraits: IdentityTrait[];
  audit: EvolutionAudit[];
  fitness: CognitiveFitnessMetrics;
  preferredStrategies: EvolutionComponent[];
  regions: CognitiveRegion[];
}
