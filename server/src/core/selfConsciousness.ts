// Self-Consciousness Engine
//
// The brain's self-awareness subsystem. Maintains a persistent self-model,
// generates introspective observations, inner monologue, metacognitive
// judgments, self-affect, autobiographical narrative, and self-predictions.
//
// Design rules (mirroring brainState.ts and organism.ts):
//   - Singleton + KV persistence to organism_state (key "self-consciousness-v1").
//   - EVERY DB/event touch is failure-isolated — a self-consciousness fault can
//     NEVER break /api/ask or the cognitive pipeline. Self-consciousness is a
//     refinement, not a dependency.
//   - All cognitive operations are PURE functions with no side effects so the
//     selfcheck exercises them with no DB and no LLM.
//   - The pipeline hooks (perceive/attend/recordReasoning) call into this module
//     but never block or error-out if self-consciousness fails.

import { ulid } from "ulid";
import { openDb } from "../db/sqlite.js";
import { surfaceError } from "../util/diagnostics.js";
import { getEventBus, nowIso, type BrainBus } from "./eventBus.js";
import {
  type SelfAwarenessLevel,
  type SelfAffectValence,
  type SelfModel,
  type SelfObservation,
  type InnerMonologue,
  type MetacognitiveJudgment,
  type SelfPrediction,
  type SelfAffectState,
  type AutobiographicalEntry,
  type CapabilitySignature,
  type CognitiveBias,
  type SelfConsciousnessConfig,
} from "../../../shared/selfConsciousness.js";
import type { AttentionFocus, BrainCycle } from "../../../shared/brainState.js";
import { getPersistentOrganism } from "./organism.js";
import { loadRankerState } from "../db/repositories/ranker.js";
import { WARM_AT } from "../reasoning/ranker.js";

const STATE_KEY = "self-consciousness-v1";
const MAX_RECENT = 20;
const MAX_MONOLOGUES = 40;
const MAX_PREDICTIONS = 30;
const MAX_AUTOBD = 50;
const MAX_OPEN_QUESTIONS = 10;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return v < min ? min : v > max ? max : v;
}

const DEFAULT_CONFIG: SelfConsciousnessConfig = {
  enabled: true,
  awarenessLevel: "narrative",
  innerMonologueEnabled: true,
  selfReflectionIntervalMs: 5 * 60 * 1000,
  autobiographicalEnabled: true,
};

// ---------------------------------------------------------------------------
// PURE introspection generators — no side effects, no clock dependency.
// ---------------------------------------------------------------------------

/** Generate a self-observation from the current brain state and event trigger. */
export function generateSelfObservation(opts: {
  trigger: SelfObservation["trigger"];
  brainState: {
    confidence: number;
    cycles: number;
    priorUncertainty: number;
    workingMemoryLen: number;
    attentionLen: number;
  };
  organism: {
    lifecycle: string;
    healthScore: number;
    energy: number;
    activeGoals: number;
  };
  goalId?: string;
  rawObservation: string;
  confidence: number;
}): SelfObservation {
  const level =
    opts.brainState.confidence < 0.4 ? 4 :
    opts.brainState.priorUncertainty > 0.6 ? 3 :
    opts.trigger === "error" || opts.trigger === "confidence_drop" ? 3 :
    opts.trigger === "idle" || opts.trigger === "dream" ? 2 :
    opts.trigger === "goal_change" || opts.trigger === "health_change" ? 2 :
    1;

  return {
    id: `sc-${ulid()}`,
    timestamp: nowIso(),
    trigger: opts.trigger,
    observation: opts.rawObservation,
    confidence: clamp01(opts.confidence),
    abstractionLevel: level as 0 | 1 | 2 | 3 | 4 | 5,
    emotionalValence: valenceFromState(opts.brainState.confidence, opts.organism.healthScore),
    relatedGoalId: opts.goalId,
  };
}

/** Pick an emotional valence based on internal state. */
export function valenceFromState(
  confidence: number,
  healthScore: number,
): SelfAffectValence {
  if (confidence < 0.35) return "anxious";
  if (confidence > 0.8 && healthScore > 0.7) return "satisfied";
  if (confidence < 0.6 && healthScore < 0.5) return "uncertain";
  if (confidence < 0.6 && healthScore > 0.6) return "curious";
  if (healthScore < 0.4) return "frustrated";
  return "calm";
}

/** Generate a brief self-question (metacognitive) from brain state. */
export function generateSelfQuestion(opts: {
  cycles: number;
  confidence: number;
  priorUncertainty: number;
  healthScore: number;
  openQuestionsCount: number;
}): string {
  if (opts.openQuestionsCount > 3) {
    return `I have ${opts.openQuestionsCount} open questions unresolved. Should I revisit any?`;
  }
  if (opts.priorUncertainty > 0.7) {
    return `I was quite uncertain last cycle. What should I pay more attention to this time?`;
  }
  if (opts.confidence < 0.4) {
    return `I was wrong about something recently. What did I miss?`;
  }
  if (opts.healthScore < 0.5) {
    return `My cognitive health is lower than usual. What is affecting my performance?`;
  }
  if (opts.cycles < 5) {
    return `I'm still learning about myself. What patterns are emerging?`;
  }
  return `Everything seems stable. Should I explore something new, or stick with what works?`;
}

/** Generate a self-observation string from attention focuses. */
export function observeAttention(focuses: ReadonlyArray<AttentionFocus>): string {
  if (focuses.length === 0) return "My attention is unfocused right now.";
  const top = focuses[0];
  const others = focuses.length - 1;
  const base = `My primary focus is on: ${top.label}`;
  if (others > 0) {
    return `${base} (plus ${others} other${others > 1 ? "s" : ""} in context).`;
  }
  return `${base}.`;
}

/** Generate a self-observation from a completed cognitive cycle. */
export function observeCycle(cycle: BrainCycle): string {
  if (cycle.lowConfidence) {
    return `My confidence was low (${(cycle.confidence * 100).toFixed(0)}%) — I flagged an open question.`;
  }
  if (cycle.citedCount === 0) {
    return `I answered from internal knowledge alone (${(cycle.confidence * 100).toFixed(0)}% confidence).`;
  }
  return `I cited ${cycle.citedCount} memory${cycle.citedCount !== 1 ? "ies" : ""} at ${(cycle.confidence * 100).toFixed(0)}% confidence.`;
}

/** Generate a capability assessment from ranker state and usage. */
export function assessCapability(
  capability: string,
  skillSelfRating: number,
  usageCount: number,
  recentAccuracy: number,
): CapabilitySignature {
  return {
    capability,
    selfRatedSkill: clamp01(skillSelfRating),
    objectiveScore: usageCount > 10 ? clamp01(recentAccuracy) : undefined,
    totalUses: usageCount,
  };
}

/** Build the initial self-model from organism identity + ranker state. */
export function buildInitialSelfModel(opts: {
  identity: { name: string; role: string; selfDescription: string };
  rankerWarm: boolean;
  rankerAlpha: number;
  totalMemories: number;
  totalCycles: number;
  capabilities: CapabilitySignature[];
  biases: CognitiveBias[];
}): SelfModel {
  return {
    identity: {
      name: opts.identity.name,
      role: opts.identity.role,
      selfDescription: opts.identity.selfDescription,
      tagline: buildSelfTagline(opts),
    },
    knowledge: {
      strengths: deriveStrengths(opts),
      weaknesses: deriveWeaknesses(opts),
      biases: opts.biases,
      capabilities: opts.capabilities,
      knownLimits: deriveKnownLimits(opts),
      unknowns: deriveUnknowns(opts),
    },
    metacognitiveAccuracy: opts.totalCycles > 0 ? clamp01(opts.rankerWarm ? 0.7 : 0.4) : 0.1,
    lastSelfAssessedAt: nowIso(),
    bootstrapCompleted: opts.totalCycles > 10,
  };
}

function buildSelfTagline(opts: { rankerWarm: boolean; totalMemories: number; totalCycles: number }): string {
  if (opts.totalCycles === 0) return "I am new — still initialising.";
  if (opts.totalCycles < 5) return "I am learning how to think.";
  if (opts.rankerWarm) return `I have ${opts.totalMemories} memories and a learned ranker.`;
  return `I have ${opts.totalMemories} memories and am improving.`;
}

function deriveStrengths(_opts: { totalMemories: number; rankerWarm: boolean; totalCycles: number }): string[] {
  const s: string[] = [];
  if (_opts.totalMemories > 100) s.push("rich long-term memory");
  if (_opts.totalCycles > 50) s.push("deep reasoning experience");
  if (_opts.rankerWarm) s.push("learned retrieval");
  s.push("multi-step reasoning");
  s.push("self-monitoring");
  return s;
}

function deriveWeaknesses(_opts: { totalCycles: number; rankerWarm: boolean; totalMemories: number }): string[] {
  const w: string[] = [];
  if (_opts.totalCycles < 10) w.push("limited experience");
  if (!_opts.rankerWarm) w.push("retrieval not yet optimised");
  if (_opts.totalMemories < 50) w.push("small memory corpus");
  w.push("subject to overconfidence");
  return w;
}

function deriveKnownLimits(_opts: { totalCycles: number; rankerWarm: boolean }): string[] {
  const l: string[] = ["finite context window", "deterministic replay (same seed = same output)"];
  if (!_opts.rankerWarm) l.push("ranker not yet warm — using heuristic retrieval");
  return l;
}

function deriveUnknowns(_opts: { totalCycles: number; totalMemories: number }): string[] {
  const u: string[] = [];
  if (_opts.totalCycles < 20) u.push("my full capabilities across domains");
  if (_opts.totalMemories < 200) u.push("the nature of my best retrieval strategies");
  u.push("how my self-model will evolve");
  return u;
}

/** Update self-model with new capabilities/biases evidence. */
export function updateSelfModelFromEvidence(
  model: SelfModel,
  event: {
    capability?: string;
    skillChange?: number;
    newBias?: CognitiveBias;
    accuracyDelta?: number;
  },
): SelfModel {
  const updated = { ...model };
  if (event.capability && event.skillChange !== undefined) {
    const caps = updated.knowledge.capabilities.filter(c => c.capability !== event.capability);
    caps.push({
      capability: event.capability,
      selfRatedSkill: clamp01((event.skillChange + 0.5) / 1),
      totalUses: 1,
    });
    updated.knowledge.capabilities = caps;
  }
  if (event.newBias) {
    const existing = updated.knowledge.biases.findIndex(b => b.id === event.newBias!.id);
    if (existing >= 0) {
      updated.knowledge.biases[existing] = event.newBias;
    } else {
      updated.knowledge.biases = [...updated.knowledge.biases, event.newBias];
    }
  }
  if (event.accuracyDelta !== undefined) {
    updated.metacognitiveAccuracy = clamp01(updated.metacognitiveAccuracy + event.accuracyDelta * 0.1);
  }
  updated.lastSelfAssessedAt = nowIso();
  return updated;
}

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------

interface PersistedSelfConsciousness {
  selfModel: SelfModel;
  awarenessLevel: SelfAwarenessLevel;
  config: SelfConsciousnessConfig;
  recentObservations: SelfObservation[];
  recentMonologues: InnerMonologue[];
  recentPredictions: SelfPrediction[];
  autobiographicalMemory: AutobiographicalEntry[];
  selfAttentionMap: Record<string, number>;
  openQuestions: string[];
  metacognitiveJudgments: MetacognitiveJudgment[];
  selfAffect: SelfAffectState;
  updatedAt: string;
}

function defaultSelfAffect(): SelfAffectState {
  return {
    valence: "calm",
    arousal: 0.3,
    dominance: 0.5,
    curiosity: 0.5,
    anxiety: 0.1,
    satisfaction: 0.5,
    triggeredBy: "initialization",
    updatedAt: nowIso(),
  };
}

function defaultState(): PersistedSelfConsciousness {
  return {
    selfModel: {
      identity: { name: "STAR", role: "cognitive assistant", selfDescription: "", tagline: "I am STAR — still initializing." },
      knowledge: { strengths: [], weaknesses: [], biases: [], capabilities: [], knownLimits: [], unknowns: [] },
      metacognitiveAccuracy: 0.1,
      lastSelfAssessedAt: nowIso(),
      bootstrapCompleted: false,
    },
    awarenessLevel: "monitoring",
    config: { ...DEFAULT_CONFIG },
    recentObservations: [],
    recentMonologues: [],
    recentPredictions: [],
    autobiographicalMemory: [],
    selfAttentionMap: {},
    openQuestions: [],
    metacognitiveJudgments: [],
    selfAffect: defaultSelfAffect(),
    updatedAt: nowIso(),
  };
}

// ---------------------------------------------------------------------------
// Main singleton
// ---------------------------------------------------------------------------

class SelfConsciousnessEngine {
  private initialized = false;

  constructor(private readonly bus: BrainBus) {}

  private read(): PersistedSelfConsciousness {
    try {
      const row = openDb()
        .prepare<[string], { value: string }>(`SELECT value FROM organism_state WHERE key = ?`)
        .get(STATE_KEY);
      if (!row) return defaultState();
      const parsed = JSON.parse(row.value) as Partial<PersistedSelfConsciousness>;
      return { ...defaultState(), ...parsed };
    } catch (err) {
      surfaceError("selfConsciousness.read", err);
      return defaultState();
    }
  }

  private write(state: PersistedSelfConsciousness): void {
    try {
      const value = JSON.stringify({ ...state, updatedAt: nowIso() });
      openDb()
        .prepare(
          `INSERT INTO organism_state (key, value, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(STATE_KEY, value, nowIso());
    } catch (err) {
      surfaceError("selfConsciousness.write", err);
    }
  }

  /** Initialize the self-model from organism identity on first boot. */
  bootstrap(): void {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const organism = getPersistentOrganism();
      const rankerState = loadRankerState();
      const orgSnapshot = organism.snapshot();
      const identity = orgSnapshot.identity;
      const state = this.read();

      if (!state.selfModel.bootstrapCompleted) {
        const db = openDb();
        const totalMemories =
          (db.prepare("SELECT COUNT(*) as c FROM memory_points").get() as { c: number } | undefined)?.c ?? 0;
        const rankerWarm = rankerState !== null && (rankerState.trainedCount ?? 0) >= WARM_AT;
        const rankerAlpha = 0.5;
        const caps: CapabilitySignature[] = [
          { capability: "reasoning", selfRatedSkill: 0.7, totalUses: 0 },
          { capability: "memory-retrieval", selfRatedSkill: rankerWarm ? 0.8 : 0.5, totalUses: totalMemories },
          { capability: "planning", selfRatedSkill: 0.6, totalUses: 0 },
          { capability: "self-monitoring", selfRatedSkill: 0.9, totalUses: 0 },
          { capability: "abstraction", selfRatedSkill: 0.6, totalUses: 0 },
        ];
        const biases: CognitiveBias[] = [
          { id: "confirmation", label: "Confirmation bias", description: "Favours information confirming prior beliefs.", strength: 0.5, direction: "sometimes" },
          { id: "availability", label: "Availability heuristic", description: "Overweights recent or vivid memories.", strength: 0.4, direction: "sometimes" },
          { id: "overconfidence", label: "Overconfidence effect", description: "Tends to rate own knowledge higher than accuracy warrants.", strength: 0.3, direction: "sometimes" },
        ];
        const selfModel = buildInitialSelfModel({
          identity: { name: identity.name, role: identity.planningStyle || "cognitive assistant", selfDescription: identity.traits.join(", ") },
          rankerWarm,
          rankerAlpha,
          totalMemories,
          totalCycles: state.recentObservations.length,
          capabilities: caps,
          biases,
        });
        const updated: PersistedSelfConsciousness = {
          ...state,
          selfModel,
          awarenessLevel: "monitoring",
          selfAffect: { ...defaultSelfAffect(), triggeredBy: "bootstrap" },
        };
        this.write(updated);

        // Seed the first autobiographical entry
        this.addAutobiographicalEntry({
          event: "I was initialized for the first time.",
          significance: 1.0,
          selfChange: "I came into existence.",
          lessonsLearned: "My initial state is uncertainty — I must learn about myself through experience.",
          emotionalResonance: "curious",
        });
      }
    } catch (err) {
      surfaceError("selfConsciousness.bootstrap", err);
      this.initialized = true;
    }
  }

  /** React to a brain event from the bus. */
  react(event: { type: string; payload?: Record<string, unknown> }): void {
    if (!this.config().enabled) return;
    try {
      switch (event.type) {
        case "pipeline:memory": {
          const state = this.read();
          const attention = (event.payload?.focuses as AttentionFocus[]) ?? [];
          if (attention.length > 0) {
            const obs = generateSelfObservation({
              trigger: "attention",
              brainState: { confidence: state.selfAffect.valence === "anxious" ? 0.4 : 0.7, cycles: state.recentObservations.length, priorUncertainty: 0.3, workingMemoryLen: 0, attentionLen: attention.length },
              organism: { lifecycle: "observing", healthScore: this.organismHealthScore(), energy: 0.7, activeGoals: 0 },
              rawObservation: observeAttention(attention),
              confidence: 0.8,
            });
            this.addObservation(obs);
            this.updateSelfAttentionMap(attention);
          }
          break;
        }
        case "pipeline:error": {
          const state = this.read();
          const obs = generateSelfObservation({
            trigger: "error",
            brainState: { confidence: 0.2, cycles: state.recentObservations.length, priorUncertainty: 0.8, workingMemoryLen: 0, attentionLen: 0 },
            organism: { lifecycle: "recovering", healthScore: this.organismHealthScore(), energy: 0.5, activeGoals: 0 },
            rawObservation: `I encountered an error: ${event.payload?.message ?? "unknown"}. I need to understand what went wrong.`,
            confidence: 0.6,
          });
          this.addObservation(obs);
          this.shiftAffect("frustrated", 0.2);
          break;
        }
        case "pipeline:reasoning": {
          const state = this.read();
          const cycle = event.payload as { confidence: number; citedCount: number } | undefined;
          if (cycle) {
            const obs = generateSelfObservation({
              trigger: cycle.confidence < 0.4 ? "confidence_drop" : "goal_change",
              brainState: { confidence: cycle.confidence, cycles: state.recentObservations.length, priorUncertainty: 1 - cycle.confidence, workingMemoryLen: 0, attentionLen: 0 },
              organism: { lifecycle: "learning", healthScore: this.organismHealthScore(), energy: 0.6, activeGoals: 0 },
              rawObservation: observeCycle({ prompt: "", confidence: cycle.confidence, citedCount: cycle.citedCount, lowConfidence: cycle.confidence < 0.35, at: nowIso() }),
              confidence: cycle.confidence,
            });
            this.addObservation(obs);
            if (cycle.confidence < 0.35) {
              this.shiftAffect("anxious", 0.15);
              this.pushOpenQuestion(`Why was my confidence only ${(cycle.confidence * 100).toFixed(0)}%?`);
            }
          }
          break;
        }
        case "brainState:decay": {
          if (!this.config().innerMonologueEnabled) return;
          const state = this.read();
          if (Date.now() - new Date(state.updatedAt).getTime() < state.config.selfReflectionIntervalMs) return;
          const question = generateSelfQuestion({
            cycles: state.recentObservations.length,
            confidence: state.selfAffect.valence === "anxious" ? 0.3 : 0.7,
            priorUncertainty: 0.3,
            healthScore: this.organismHealthScore(),
            openQuestionsCount: state.openQuestions.length,
          });
          const mono = this.generateMonologue({ content: question, kind: "self-question", trigger: "idle", confidence: 0.7 });
          if (mono) this.addMonologue(mono);
          break;
        }
        case "goal_change": {
          const state = this.read();
          const obs = generateSelfObservation({
            trigger: "goal_change",
            brainState: { confidence: 0.7, cycles: state.recentObservations.length, priorUncertainty: 0.3, workingMemoryLen: 0, attentionLen: 0 },
            organism: { lifecycle: "planning", healthScore: this.organismHealthScore(), energy: 0.7, activeGoals: (event.payload?.activeGoals as number) ?? 0 },
            rawObservation: `My goal has changed: ${event.payload?.title ?? "a new goal"}`,
            confidence: 0.8,
          });
          this.addObservation(obs);
          break;
        }
        case "health_change": {
          const state = this.read();
          const obs = generateSelfObservation({
            trigger: "health_change",
            brainState: { confidence: 0.6, cycles: state.recentObservations.length, priorUncertainty: 0.4, workingMemoryLen: 0, attentionLen: 0 },
            organism: { lifecycle: "recovering", healthScore: (event.payload?.score as number) ?? 0.5, energy: 0.5, activeGoals: 0 },
            rawObservation: `My cognitive health shifted: ${event.payload?.reason ?? "something changed"}`,
            confidence: 0.6,
          });
          this.addObservation(obs);
          break;
        }
      }
    } catch (err) {
      surfaceError("selfConsciousness.react", err);
    }
  }

  /** Make a metacognitive judgment about what the brain knows. */
  judge(question: string, answer: string, confidence: number, basedOnMemories: number): MetacognitiveJudgment {
    const accuracy: MetacognitiveJudgment["accuracy"] =
      confidence > 0.8 ? "overconfident" :
      confidence > 0.5 ? "accurate" :
      "uncertain";
    const judgment: MetacognitiveJudgment = {
      id: `sc-judge-${ulid()}`,
      timestamp: nowIso(),
      question,
      answer,
      confidence: clamp01(confidence),
      accuracy,
      basedOnMemories,
    };
    const state = this.read();
    const judgments = [judgment, ...state.metacognitiveJudgments].slice(0, MAX_RECENT);
    this.write({ ...state, metacognitiveJudgments: judgments });
    return judgment;
  }

  /** Predict own future cognitive state. */
  predictSelf(horizon: SelfPrediction["horizon"], prediction: string, reasoning: string): SelfPrediction {
    const item: SelfPrediction = {
      id: `sc-pred-${ulid()}`,
      timestamp: nowIso(),
      horizon,
      prediction,
      reasoning,
      confidence: 0.5,
    };
    const state = this.read();
    const predictions = [item, ...state.recentPredictions].slice(0, MAX_PREDICTIONS);
    this.write({ ...state, recentPredictions: predictions });
    return item;
  }

  /** Check if a recent prediction came true and record it. */
  verifyPrediction(id: string, actualOutcome: string, wasCorrect: boolean): void {
    try {
      const state = this.read();
      const predictions = state.recentPredictions.map(p =>
        p.id === id ? { ...p, actualOutcome, verifiedAt: nowIso(), wasCorrect } : p,
      );
      this.write({ ...state, recentPredictions: predictions });
    } catch (err) {
      surfaceError("selfConsciousness.verifyPrediction", err);
    }
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  config(): SelfConsciousnessConfig {
    return this.read().config;
  }

  getSnapshot() {
    return this.read();
  }

  /** Public snapshot typed as the API-facing SelfConsciousnessState. Emits
   *  a self-snapshot BrainEvent on the internal bus so brainCore fans it to
   *  the browser over /ws/brain. */
  snapshot(): import("../../../shared/selfConsciousness.js").SelfConsciousnessState {
    const s = this.read();
    return {
      selfModel: s.selfModel,
      awarenessLevel: s.awarenessLevel,
      metacognitiveState: {
        metacognitiveAccuracy: 0.5,
        lastJudgmentAt: s.metacognitiveJudgments[s.metacognitiveJudgments.length - 1]?.timestamp,
        judgments: s.metacognitiveJudgments.slice(-10),
        openQuestions: s.openQuestions,
      },
      selfAffect: s.selfAffect,
      recentObservations: s.recentObservations.slice(-10),
      recentMonologues: s.recentMonologues.slice(-20),
      recentPredictions: s.recentPredictions.slice(-10),
      autobiographicalMemory: s.autobiographicalMemory.slice(-20),
      selfAttentionMap: s.selfAttentionMap,
      updatedAt: s.updatedAt,
    };
  }

  getSelfModel(): SelfModel {
    return this.read().selfModel;
  }

  getSelfAffect(): SelfAffectState {
    return this.read().selfAffect;
  }

  getRecentObservations(): SelfObservation[] {
    return this.read().recentObservations;
  }

  getRecentMonologues(): InnerMonologue[] {
    return this.read().recentMonologues;
  }

  getOpenQuestions(): string[] {
    return this.read().openQuestions;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private organismHealthScore(): number {
    try {
      return getPersistentOrganism().getHealthScore();
    } catch {
      return 0.6;
    }
  }

  private state(): PersistedSelfConsciousness {
    return this.read();
  }

  private addObservation(obs: SelfObservation): void {
    const state = this.read();
    const observations = [obs, ...state.recentObservations].slice(0, MAX_RECENT);
    this.write({ ...state, recentObservations: observations });
  }

  private addMonologue(mono: InnerMonologue): void {
    const state = this.read();
    const monologues = [mono, ...state.recentMonologues].slice(0, MAX_MONOLOGUES);
    this.write({ ...state, recentMonologues: monologues });
  }

  private generateMonologue(opts: {
    content: string;
    kind: InnerMonologue["kind"];
    trigger: SelfObservation["trigger"];
    confidence: number;
  }): InnerMonologue | null {
    const state = this.read();
    if (!state.config.innerMonologueEnabled) return null;
    return {
      id: `sc-mono-${ulid()}`,
      timestamp: nowIso(),
      content: opts.content,
      kind: opts.kind,
      trigger: opts.trigger,
      confidence: clamp01(opts.confidence),
      abstractionLevel: 2,
    };
  }

  private shiftAffect(valence: SelfAffectValence, magnitude: number): void {
    try {
      const state = this.read();
      const current = state.selfAffect;
      const updated: SelfAffectState = {
        ...current,
        valence,
        anxiety: valence === "anxious" ? clamp01(current.anxiety + magnitude) : clamp01(current.anxiety - magnitude * 0.5),
        satisfaction: valence === "satisfied" ? clamp01(current.satisfaction + magnitude) : clamp01(current.satisfaction - magnitude * 0.3),
        curiosity: valence === "curious" ? clamp01(current.curiosity + magnitude) : clamp01(current.curiosity - magnitude * 0.2),
        triggeredBy: `self-observation:${valence}`,
        updatedAt: nowIso(),
      };
      this.write({ ...state, selfAffect: updated });
    } catch (err) {
      surfaceError("selfConsciousness.shiftAffect", err);
    }
  }

  private updateSelfAttentionMap(focuses: AttentionFocus[]): void {
    try {
      const state = this.read();
      const map: Record<string, number> = { ...state.selfAttentionMap };
      for (const f of focuses) {
        map[f.id] = clamp01((map[f.id] ?? 0) + f.score * 0.1);
      }
      this.write({ ...state, selfAttentionMap: map });
    } catch (err) {
      surfaceError("selfConsciousness.updateSelfAttentionMap", err);
    }
  }

  private pushOpenQuestion(q: string): void {
    try {
      const state = this.read();
      const qs = [q, ...state.openQuestions.filter(x => x !== q)].slice(0, MAX_OPEN_QUESTIONS);
      this.write({ ...state, openQuestions: qs });
    } catch (err) {
      surfaceError("selfConsciousness.pushOpenQuestion", err);
    }
  }

  addAutobiographicalEntry(entry: {
    event: string;
    significance: number;
    selfChange?: string;
    lessonsLearned?: string;
    relatedGoals?: string[];
    emotionalResonance: SelfAffectValence;
  }): void {
    if (!this.config().autobiographicalEnabled) return;
    try {
      const item: AutobiographicalEntry = {
        id: `sc-ab-${ulid()}`,
        timestamp: nowIso(),
        event: entry.event,
        significance: clamp01(entry.significance),
        selfChange: entry.selfChange,
        lessonsLearned: entry.lessonsLearned,
        relatedGoals: entry.relatedGoals ?? [],
        emotionalResonance: entry.emotionalResonance,
      };
      const state = this.read();
      const memory = [item, ...state.autobiographicalMemory].slice(0, MAX_AUTOBD);
      this.write({ ...state, autobiographicalMemory: memory });
    } catch (err) {
      surfaceError("selfConsciousness.addAutobiographical", err);
    }
  }

  setAwarenessLevel(level: SelfAwarenessLevel): void {
    try {
      const state = this.read();
      this.write({ ...state, awarenessLevel: level, config: { ...state.config, awarenessLevel: level } });
    } catch (err) {
      surfaceError("selfConsciousness.setAwarenessLevel", err);
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let _engine: SelfConsciousnessEngine | null = null;

export function getSelfConsciousness(bus?: BrainBus): SelfConsciousnessEngine {
  if (!_engine && bus) {
    _engine = new SelfConsciousnessEngine(bus);
  }
  if (!_engine) {
    throw new Error("SelfConsciousness not initialized — call initSelfConsciousness(bus) first");
  }
  return _engine;
}

export function initSelfConsciousness(bus: BrainBus): SelfConsciousnessEngine {
  _engine = new SelfConsciousnessEngine(bus);
  _engine.bootstrap();
  return _engine;
}