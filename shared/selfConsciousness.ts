// Self-Consciousness subsystem types
// The brain's model of itself — what it knows about its own cognition,
// capabilities, limitations, biases, and identity.

export type SelfAwarenessLevel =
  | "none"       // no self-awareness
  | "monitoring" // observing internal states
  | "reflexive"  // observing and reflecting on observation
  | "narrative"; // constructing a story of self over time

export type MetacognitiveConfidence =
  | "ignorant"   // no metacognitive access
  | "unaware"    // knows something is happening but not what
  | "accurate"   // correct metacognitive judgment
  | "overconfident" // thinks they know more than they do
  | "uncertain";  // aware they don't know

export type SelfAffectValence =
  | "anxious"
  | "calm"
  | "curious"
  | "satisfied"
  | "frustrated"
  | "uncertain";

export interface CapabilitySignature {
  capability: string;
  selfRatedSkill: number;
  objectiveScore?: number;
  lastUsedAt?: string;
  totalUses: number;
}

export interface CognitiveBias {
  id: string;
  label: string;
  description: string;
  strength: number;
  direction: "always" | "sometimes" | "rarely";
}

export interface SelfKnowledge {
  strengths: string[];
  weaknesses: string[];
  biases: CognitiveBias[];
  capabilities: CapabilitySignature[];
  knownLimits: string[];
  unknowns: string[];
}

export interface SelfModel {
  identity: {
    name: string;
    role: string;
    selfDescription: string;
    tagline: string;
  };
  knowledge: SelfKnowledge;
  metacognitiveAccuracy: number;
  lastSelfAssessedAt: string;
  bootstrapCompleted: boolean;
}

export interface SelfObservation {
  id: string;
  timestamp: string;
  trigger: "attention" | "confidence_drop" | "idle" | "error" | "goal_change" | "dream" | "health_change" | "manual";
  observation: string;
  confidence: number;
  abstractionLevel: 0 | 1 | 2 | 3 | 4 | 5;
  emotionalValence?: SelfAffectValence;
  relatedGoalId?: string;
}

export interface InnerMonologue {
  id: string;
  timestamp: string;
  content: string;
  kind: "self-observation" | "metacognitive" | "self-question" | "narrative" | "intuition";
  trigger: SelfObservation["trigger"];
  confidence: number;
  abstractionLevel: 0 | 1 | 2 | 3 | 4 | 5;
}

export interface MetacognitiveJudgment {
  id: string;
  timestamp: string;
  question: string;
  answer: string;
  confidence: number;
  accuracy?: MetacognitiveConfidence;
  basedOnMemories: number;
}

export interface SelfPrediction {
  id: string;
  timestamp: string;
  horizon: "immediate" | "short" | "medium" | "long";
  prediction: string;
  reasoning: string;
  confidence: number;
  actualOutcome?: string;
  verifiedAt?: string;
  wasCorrect?: boolean;
}

export interface SelfAffectState {
  valence: SelfAffectValence;
  arousal: number;
  dominance: number;
  curiosity: number;
  anxiety: number;
  satisfaction: number;
  triggeredBy: string;
  updatedAt: string;
}

export interface AutobiographicalEntry {
  id: string;
  timestamp: string;
  event: string;
  significance: number;
  selfChange?: string;
  lessonsLearned?: string;
  relatedGoals: string[];
  emotionalResonance: SelfAffectValence;
}

export interface SelfConsciousnessState {
  selfModel: SelfModel;
  awarenessLevel: SelfAwarenessLevel;
  metacognitiveState: {
    metacognitiveAccuracy: number;
    lastJudgmentAt?: string;
    judgments: MetacognitiveJudgment[];
    openQuestions: string[];
  };
  selfAffect: SelfAffectState;
  recentObservations: SelfObservation[];
  recentMonologues: InnerMonologue[];
  recentPredictions: SelfPrediction[];
  autobiographicalMemory: AutobiographicalEntry[];
  selfAttentionMap: Record<string, number>;
  updatedAt: string;
}

export interface SelfConsciousnessConfig {
  enabled: boolean;
  awarenessLevel: SelfAwarenessLevel;
  innerMonologueEnabled: boolean;
  selfReflectionIntervalMs: number;
  autobiographicalEnabled: boolean;
}