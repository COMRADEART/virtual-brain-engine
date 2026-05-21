export type OrganismLifecycleState =
  | "booting"
  | "observing"
  | "learning"
  | "planning"
  | "executing"
  | "reflecting"
  | "dreaming"
  | "consolidating"
  | "recovering"
  | "evolving"
  | "idle";

export type PersistentGoalStatus =
  | "active"
  | "blocked"
  | "paused"
  | "completed"
  | "abandoned";

export type DreamCycleStatus = "running" | "completed" | "interrupted";
export type ImmuneSeverity = "low" | "medium" | "high" | "critical";
export type ImmuneStatus = "observed" | "isolated" | "quarantined" | "rolled-back" | "resolved";
export type EnergyCategory = "passive" | "maintenance" | "planning" | "simulation" | "research" | "execution" | "dream";
export type MemoryTimescale = "immediate" | "working" | "short-term" | "episodic" | "semantic" | "long-term" | "archival";
export type ResearchStatus = "sandboxed" | "running" | "completed" | "paused";

export interface CognitiveEnergy {
  current: number;
  capacity: number;
  reserve: number;
  rechargeRate: number;
  lastUpdatedAt: string;
}

export interface OrganismState {
  id: string;
  lifecycle: OrganismLifecycleState;
  mode: "offline" | "hybrid" | "secure" | "research";
  continuityId?: string;
  uptimeStartedAt: string;
  lastWakeAt: string;
  lastSleepAt?: string;
  cognitiveLoad: number;
  workflowLoad: number;
  resourceThrottle: number;
  energy: CognitiveEnergy;
  updatedAt: string;
}

export interface GoalAttempt {
  id: string;
  summary: string;
  outcome: "unknown" | "success" | "failed" | "partial";
  createdAt: string;
}

export interface PersistentGoal {
  id: string;
  title: string;
  status: PersistentGoalStatus;
  progress: number;
  priority: number;
  dependencies: string[];
  subgoals: string[];
  attempts: GoalAttempt[];
  blockers: string[];
  confidence: number;
  estimatedCompletionAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContinuitySnapshot {
  id: string;
  createdAt: string;
  lifecycle: OrganismLifecycleState;
  activeGoalIds: string[];
  restoredWorkflows: string[];
  contextSummary: string;
  worldHash: string;
  energy: CognitiveEnergy;
  healthScore: number;
}

export interface IdentityProfile {
  id: string;
  name: string;
  traits: string[];
  cognitivePreferences: string[];
  projectExpertise: string[];
  toolFamiliarity: string[];
  communicationStyle: string;
  planningStyle: string;
  executionTendencies: string[];
  trustedWorkflows: string[];
  confidence: number;
  updatedAt: string;
}

export interface CognitiveHealth {
  id: string;
  capturedAt: string;
  healthScore: number;
  memoryIntegrity: number;
  workflowStability: number;
  identityCoherence: number;
  goalAlignment: number;
  resourceBalance: number;
  immuneLoad: number;
  issues: string[];
}

export interface EnergyUsage {
  id: string;
  createdAt: string;
  category: EnergyCategory;
  task: string;
  amount: number;
  balanceAfter: number;
  metadata: Record<string, unknown>;
}

export interface ImmuneEvent {
  id: string;
  kind:
    | "corrupted-memory"
    | "hallucinated-workflow"
    | "dangerous-loop"
    | "unstable-reasoning"
    | "malformed-execution-graph"
    | "conflicting-goals"
    | "anomalous-behavior";
  severity: ImmuneSeverity;
  status: ImmuneStatus;
  target: string;
  detail: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  resolvedAt?: string;
}

export interface DreamCycle {
  id: string;
  startedAt: string;
  endedAt?: string;
  status: DreamCycleStatus;
  activities: string[];
  outputs: string[];
  energyCost: number;
}

export interface ResearchSession {
  id: string;
  title: string;
  hypothesis: string;
  status: ResearchStatus;
  sandboxed: boolean;
  findings: string[];
  risk: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorldModel {
  id: string;
  summary: string;
  userHabits: string[];
  projectEvolution: string[];
  workflowPatterns: string[];
  environmentChanges: string[];
  installedToolChanges: string[];
  aiCapabilityChanges: string[];
  historicalTrends: string[];
  updatedAt: string;
}

export interface SubBrain {
  id: string;
  name: string;
  specialization: string;
  inheritedMemoryScopes: string[];
  inheritedSkills: string[];
  inheritedSafetyRules: string[];
  maturity: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryStratum {
  timescale: MemoryTimescale;
  count: number;
  compression: number;
  priority: number;
}

export interface OrganismSnapshot {
  generatedAt: string;
  state: OrganismState;
  goals: PersistentGoal[];
  continuity: ContinuitySnapshot[];
  identity: IdentityProfile;
  health: CognitiveHealth;
  energyUsage: EnergyUsage[];
  immuneEvents: ImmuneEvent[];
  dreamCycles: DreamCycle[];
  researchSessions: ResearchSession[];
  worldModel: WorldModel;
  subBrains: SubBrain[];
  memoryStrata: MemoryStratum[];
}
