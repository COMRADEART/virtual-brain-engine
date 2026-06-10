import { ulid } from "ulid";
import { openDb } from "../db/sqlite.js";
import { getEventBus, nowIso, type BrainBus } from "./eventBus.js";
import { getRecentSnapshots } from "../twin/repository.js";
import { classifyAction, simulate, type SimHistory } from "../twin/simulationEngine.js";
import { classifyAbstractionLevel } from "./abstractionLevels.js";
import {
  MIN_USABLE_CONFIDENCE,
  extractEffectsFromReflection,
  predictEffects,
  recordObservation,
} from "./causalMap.js";
import type {
  AbstractionLevel,
  CognitiveAbstraction,
  ImaginationFuture,
  ImaginationFutureKind,
  ImaginationMode,
  ImaginationRecommendation,
  ImaginationResourceForecast,
  ImaginationSession,
  ImaginationSideEffects,
  ImaginationSnapshot,
  ImaginationStep,
  ImaginationTimelineEntry,
  MemoryInfluence,
  PredictionReflection,
  ThoughtSpaceEntry,
} from "../../../shared/imagination.js";

export interface ImaginationInput {
  goal: string;
  action?: string;
  mode?: ImaginationMode;
  branchCount?: number;
  context?: Record<string, unknown>;
}

export interface ReflectionInput {
  sessionId: string;
  futureId: string;
  actualSummary: string;
  ok: boolean;
  actualDurationMs?: number;
  actualRisk?: number;
  sideEffects?: Partial<ImaginationSideEffects>;
}

const MAX_BRANCHES = 5;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function actionText(input: ImaginationInput): string {
  return (input.action ?? input.goal).trim();
}

function modeFor(input: ImaginationInput): ImaginationMode {
  if (input.mode) return input.mode;
  const action = actionText(input).toLowerCase();
  if (/\b(upgrade|install|build|test|fix|migrate|run|execute)\b/.test(action)) {
    return "workflow-rehearsal";
  }
  return "future-prediction";
}

function historyFor(action: string): SimHistory {
  try {
    const db = openDb();
    const terms = action
      .toLowerCase()
      .split(/[^a-z0-9.+#-]+/)
      .filter((term) => term.length >= 4)
      .slice(0, 5);
    const like = terms.length > 0 ? `%${terms[0]}%` : "%";
    const row = db
      .prepare<[string], { runs: number; fails: number }>(
        `SELECT COUNT(*) AS runs,
                SUM(CASE WHEN status IN ('error','failed') THEN 1 ELSE 0 END) AS fails
         FROM pipeline_runs
         WHERE LOWER(prompt) LIKE ?`,
      )
      .get(like);
    return {
      pastRuns: row?.runs ?? 0,
      pastFailures: row?.fails ?? 0,
    };
  } catch {
    return { pastRuns: 0, pastFailures: 0 };
  }
}

function memoryInfluences(action: string): MemoryInfluence[] {
  const out: MemoryInfluence[] = [];
  try {
    const db = openDb();
    const terms = action
      .toLowerCase()
      .split(/[^a-z0-9.+#-]+/)
      .filter((term) => term.length >= 4)
      .slice(0, 4);
    for (const term of terms) {
      const rows = db
        .prepare<[string], { title: string | null; project_name: string | null; importance: number; content: string }>(
          `SELECT title, project_name, importance, content
           FROM memory_points
           WHERE LOWER(content) LIKE ?
           ORDER BY importance DESC, updated_at DESC
           LIMIT 2`,
        )
        .all(`%${term}%`);
      for (const row of rows) {
        out.push({
          source: "memory",
          label: row.title ?? row.project_name ?? term,
          weight: clamp01(row.importance),
          detail: row.content.slice(0, 180),
        });
      }
    }
  } catch {
    // Memory influence is advisory only.
  }
  if (out.length === 0) {
    out.push({
      source: "heuristic",
      label: "cold-start heuristic",
      weight: 0.32,
      detail: "No strong matching memory was found; prediction relies on action class and current system state.",
    });
  }
  return out.slice(0, 6);
}

function memoryReliability(influences: MemoryInfluence[]): number {
  const memory = influences.filter((influence) => influence.source === "memory");
  if (memory.length === 0) return 0.34;
  return clamp01(memory.reduce((sum, influence) => sum + influence.weight, 0) / Math.max(1, memory.length));
}

interface CausalInfluenceResult {
  blendedRisk: number;
  influence: MemoryInfluence;
}

// Bayesian-ish blend between the per-call heuristic risk and the smoothed
// empirical failure rate from causal_links. Returns null when no usable
// signal exists (DB miss, never-observed cause, or sub-threshold confidence)
// — caller falls back to the heuristic risk unchanged.
function readCausalInfluence(causeClass: string, heuristicRisk: number): CausalInfluenceResult | null {
  try {
    const forecast = predictEffects(causeClass);
    if (forecast.expectedFailureRate === null) return null;
    if (forecast.failureConfidence < MIN_USABLE_CONFIDENCE) return null;
    const weight = Math.min(0.5, forecast.failureConfidence);
    const blendedRisk = clamp01(heuristicRisk * (1 - weight) + forecast.expectedFailureRate * weight);
    const failureLink = forecast.effects.find((effect) => effect.effectClass === "failure");
    const obsCount = failureLink?.observations ?? 0;
    return {
      blendedRisk,
      influence: {
        source: "causal-map",
        label: `causal world model (${causeClass})`,
        weight: clamp01(forecast.failureConfidence),
        detail: `Historical P(failure|${causeClass}) = ${Math.round(forecast.expectedFailureRate * 100)}% over ${obsCount} observation${obsCount === 1 ? "" : "s"}; blended risk ${Math.round(heuristicRisk * 100)}% → ${Math.round(blendedRisk * 100)}%.`,
      },
    };
  } catch {
    return null;
  }
}

function sideEffectsFor(kind: ImaginationFutureKind, category: string, risk: number): ImaginationSideEffects {
  const dependencyChanges = category === "upgrade" || category === "install" ? (kind === "safe" ? 2 : 4) : 0;
  const diskWrites = category === "build" || category === "test" ? 3 : dependencyChanges > 0 ? 5 : 1;
  const gitChanges = dependencyChanges > 0 || category === "clean" ? (kind === "rollback" ? 1 : 2) : 0;
  return {
    gitChanges,
    diskWrites,
    memoryWrites: kind === "sandbox" ? 0 : 1,
    dependencyChanges,
    rollbackComplexity: clamp01(risk + (dependencyChanges > 0 ? 0.18 : 0) - (kind === "rollback" ? 0.2 : 0)),
  };
}

function resourceForecast(
  baseDurationMs: number,
  kind: ImaginationFutureKind,
  category: string,
  risk: number,
): ImaginationResourceForecast {
  const durationMultiplier =
    kind === "fast" ? 0.65 : kind === "safe" ? 1.35 : kind === "rollback" ? 1.55 : kind === "defer" ? 0.15 : 1.05;
  const cpuBase = category === "build" || category === "test" || category === "upgrade" ? 0.68 : 0.38;
  const memoryBase = category === "build" || category === "upgrade" ? 0.58 : 0.34;
  const diskBase = category === "upgrade" || category === "install" ? 280 : category === "build" ? 160 : 28;
  return {
    cpuPeak: clamp01(cpuBase + risk * 0.18 + (kind === "fast" ? 0.1 : 0)),
    memoryPeak: clamp01(memoryBase + risk * 0.16),
    diskChangeMb: kind === "defer" ? 0 : clampInt(diskBase * (kind === "rollback" ? 1.25 : 1), 0, 25_000),
    networkRequired: category === "install" || category === "upgrade",
    estimatedDurationMs: clampInt(baseDurationMs * durationMultiplier, 500, 3_600_000),
  };
}

function failureModes(category: string, conflicts: string[], kind: ImaginationFutureKind): string[] {
  const modes = [...conflicts];
  if (category === "upgrade") modes.push("version solver selects incompatible transitive dependency");
  if (category === "install") modes.push("network or registry availability blocks dependency fetch");
  if (category === "build") modes.push("compile cache invalidation exposes stale type or feature errors");
  if (category === "test") modes.push("flaky integration state creates false negative test result");
  if (kind === "fast") modes.push("short path skips isolation and increases rollback uncertainty");
  if (kind === "sandbox") modes.push("sandbox prediction may miss environment-specific side effects");
  return Array.from(new Set(modes)).slice(0, 5);
}

function stepsFor(kind: ImaginationFutureKind, action: string, category: string, risk: number): ImaginationStep[] {
  const prefix = kind === "sandbox" ? "virtually " : "";
  const commands: Partial<Record<string, string[]>> = {
    upgrade: ["git status --short", "cargo update --dry-run", "cargo check"],
    install: ["git status --short", "dependency resolver dry-run", "build smoke check"],
    build: ["inspect workspace state", "cargo check", "cargo test --no-run"],
    test: ["select minimal test set", "run focused tests", "compare failures to memory"],
    clean: ["list generated artifacts", "simulate cleanup target set", "estimate rebuild impact"],
  };
  const labels = commands[category] ?? ["load context", "simulate action", "compare predicted outcome"];
  return labels.map((label, index) => ({
    id: `step-${kind}-${index + 1}`,
    label: `${prefix}${label}`,
    simulatedCommand: label.includes("cargo") || label.includes("git") ? label : undefined,
    probability: clamp01(0.86 - risk * 0.28 - index * 0.04 + (kind === "safe" ? 0.08 : 0)),
    risk: clamp01(risk + index * 0.04 - (kind === "rollback" ? 0.06 : 0)),
    notes: [`mental rehearsal for "${action.slice(0, 72)}"`],
  }));
}

function buildFuture(
  kind: ImaginationFutureKind,
  action: string,
  baseRisk: number,
  baseDurationMs: number,
  conflicts: string[],
  influences: MemoryInfluence[],
): ImaginationFuture {
  const category = classifyAction(action);
  const modifier =
    kind === "fast"
      ? { risk: 0.14, confidence: -0.08, complexity: -0.15, safety: -0.14, cost: -0.14, probability: 0.04 }
      : kind === "safe"
        ? { risk: -0.18, confidence: 0.08, complexity: 0.08, safety: 0.18, cost: 0.12, probability: 0.1 }
        : kind === "rollback"
          ? { risk: -0.08, confidence: 0.03, complexity: 0.22, safety: 0.1, cost: 0.18, probability: 0.02 }
          : kind === "sandbox"
            ? { risk: -0.22, confidence: 0.02, complexity: 0.05, safety: 0.24, cost: 0.04, probability: -0.02 }
            : { risk: -0.3, confidence: -0.02, complexity: -0.22, safety: 0.32, cost: -0.24, probability: -0.12 };
  const risk = clamp01(baseRisk + modifier.risk);
  const reliability = memoryReliability(influences);
  const confidence = clamp01(0.58 + reliability * 0.22 - risk * 0.18 + modifier.confidence);
  const ambiguity = clamp01(1 - confidence + risk * 0.18);
  const safety = clamp01(1 - risk + modifier.safety);
  const complexity = clamp01(0.34 + risk * 0.34 + modifier.complexity);
  const cost = clamp01(0.32 + complexity * 0.3 + modifier.cost);
  const executionProbability = clamp01(0.72 + modifier.probability - risk * 0.22);
  const resourceForecastValue = resourceForecast(baseDurationMs, kind, category, risk);
  const sideEffects = sideEffectsFor(kind, category, risk);
  const score = clamp01(
    confidence * 0.3 +
      safety * 0.24 +
      executionProbability * 0.16 +
      reliability * 0.14 +
      (1 - complexity) * 0.08 +
      (1 - cost) * 0.08,
  );
  const label =
    kind === "fast"
      ? "Fast path"
      : kind === "safe"
        ? "Safe rehearsal"
        : kind === "rollback"
          ? "Rollback-first path"
          : kind === "sandbox"
            ? "Mental sandbox"
            : "Defer and observe";
  return {
    id: `future-${kind}-${ulid()}`,
    kind,
    label,
    summary:
      kind === "defer"
        ? `Do not execute yet; gather stronger state before attempting ${category}.`
        : `${label} predicts ${Math.round(risk * 100)}% risk for a ${category} workflow.`,
    confidence,
    ambiguity,
    risk,
    memoryReliability: reliability,
    executionProbability,
    safety,
    complexity,
    cost,
    score,
    resourceForecast: resourceForecastValue,
    sideEffects,
    failureModes: failureModes(category, conflicts, kind),
    recommendedActions:
      kind === "safe"
        ? ["capture git status", "run narrow check first", "store predicted outcome before execution"]
        : kind === "rollback"
          ? ["commit or stash current state", "prepare rollback command", "run validation after restore point"]
          : kind === "sandbox"
            ? ["keep result private", "compare against memory", "promote only after validation"]
            : kind === "defer"
              ? ["wait for lower resource pressure", "collect more evidence", "ask for approval"]
              : ["limit scope", "run fastest reversible check", "stop on first conflict"],
    steps: stepsFor(kind, action, category, risk),
    influenceChain: influences,
  };
}

function recommend(futures: ImaginationFuture[]): ImaginationRecommendation {
  const sorted = futures.slice().sort((a, b) => b.score - a.score);
  const winner = sorted[0];
  return {
    futureId: winner.id,
    rationale: `${winner.label} has the best balance of confidence, safety, cost, and execution probability.`,
    confidence: winner.confidence,
    risk: winner.risk,
    approvalRequired: winner.risk >= 0.35 || winner.sideEffects.dependencyChanges > 0 || winner.resourceForecast.networkRequired,
  };
}

function thoughtSpaceFor(action: string, futures: ImaginationFuture[]): ThoughtSpaceEntry[] {
  const winner = futures.slice().sort((a, b) => b.score - a.score)[0];
  const riskier = futures.slice().sort((a, b) => b.risk - a.risk)[0];
  const now = nowIso();
  return [
    {
      id: `thought-${ulid()}`,
      visibility: "private",
      content: `Assumption: "${action}" can be represented as a ${classifyAction(action)} workflow without touching the real workspace.`,
      confidence: 0.68,
      createdAt: now,
    },
    {
      id: `thought-${ulid()}`,
      visibility: "private",
      content: `Uncertainty: ${riskier.failureModes[0] ?? "missing comparable memory may reduce prediction quality"}.`,
      confidence: clamp01(1 - riskier.ambiguity),
      createdAt: now,
    },
    {
      id: `thought-${ulid()}`,
      visibility: "validated",
      content: `Recommendation candidate: ${winner.label} with ${Math.round(winner.confidence * 100)}% confidence.`,
      confidence: winner.confidence,
      createdAt: now,
    },
  ];
}

function timelineFor(sessionId: string, futures: ImaginationFuture[], recommendation: ImaginationRecommendation): ImaginationTimelineEntry[] {
  const at = nowIso();
  const entries: ImaginationTimelineEntry[] = futures.map((future) => ({
    id: `imag-tl-${ulid()}`,
    sessionId,
    kind: "future-predicted" as const,
    title: future.label,
    detail: future.summary,
    confidence: future.confidence,
    risk: future.risk,
    createdAt: at,
    metadata: { futureId: future.id, score: future.score, kind: future.kind },
  }));
  const chosen = futures.find((future) => future.id === recommendation.futureId);
  entries.push({
    id: `imag-tl-${ulid()}`,
    sessionId,
    kind: "future-recommended",
    title: chosen?.label ?? "Recommended future",
    detail: recommendation.rationale,
    confidence: recommendation.confidence,
    risk: recommendation.risk,
    createdAt: at,
    metadata: { futureId: recommendation.futureId, approvalRequired: recommendation.approvalRequired },
  });
  return entries;
}

export class ImaginationEngine {
  private readonly bus: BrainBus;
  private dreamTimer: ReturnType<typeof setInterval> | null = null;

  constructor(bus: BrainBus) {
    this.bus = bus;
  }

  imagine(input: ImaginationInput): ImaginationSession {
    const goal = input.goal.trim();
    const action = actionText(input);
    if (!goal || !action) {
      throw new Error("goal is required");
    }

    const base = simulate(action, getRecentSnapshots(60), historyFor(action));

    // Causal world model (blueprint #7): blend empirical P(failure|cause) into
    // the heuristic risk prior. Weight = failureConfidence capped at 0.5 — we
    // never let history fully override the per-call digital-twin simulation,
    // and below MIN_USABLE_CONFIDENCE the empirical term contributes nothing
    // (≈ first observation in). Pure read; safe to fail silently.
    const causeClass = classifyAction(action);
    const causalInfluence = readCausalInfluence(causeClass, base.riskScore);
    const effectiveBaseRisk = causalInfluence ? causalInfluence.blendedRisk : base.riskScore;

    const influences: MemoryInfluence[] = [
      {
        source: "twin",
        label: "digital twin simulation",
        weight: clamp01(1 - base.riskScore),
        detail: base.predictedImpact,
      },
      {
        source: "workflow-history",
        label: "historical workflow reliability",
        weight: clamp01(1 - base.riskScore * 0.6),
        detail: base.conflicts.length > 0 ? base.conflicts.join("; ") : "No matching recent failure pattern.",
      },
      ...(causalInfluence ? [causalInfluence.influence] : []),
      ...memoryInfluences(action),
    ];
    const branchKinds: ImaginationFutureKind[] = ["fast", "safe", "rollback", "sandbox", "defer"];
    const futures = branchKinds
      .slice(0, Math.max(3, Math.min(MAX_BRANCHES, input.branchCount ?? 4)))
      .map((kind) => buildFuture(kind, action, effectiveBaseRisk, base.estimatedRuntimeMs, base.conflicts, influences));
    const recommendation = recommend(futures);
    const sessionId = `imag-${ulid()}`;
    const session: ImaginationSession = {
      id: sessionId,
      goal,
      action,
      mode: modeFor(input),
      futures,
      recommendation,
      thoughtSpace: thoughtSpaceFor(action, futures),
      timeline: timelineFor(sessionId, futures, recommendation),
      createdAt: nowIso(),
    };

    this.persistSession(session);
    this.bus.emit({ kind: "imagination-session", session, at: session.createdAt });
    this.bus.emit({ kind: "imagination-snapshot", snapshot: this.snapshot(), at: nowIso() });
    return session;
  }

  reflect(input: ReflectionInput): PredictionReflection {
    const session = this.sessionById(input.sessionId);
    if (!session) throw new Error("session not found");
    const future = session.futures.find((candidate) => candidate.id === input.futureId);
    if (!future) throw new Error("future not found");

    const actualRisk = clamp01(input.actualRisk ?? (input.ok ? 0.18 : 0.74));
    const durationAccuracy =
      input.actualDurationMs && future.resourceForecast.estimatedDurationMs > 0
        ? 1 -
          Math.min(
            1,
            Math.abs(input.actualDurationMs - future.resourceForecast.estimatedDurationMs) /
              Math.max(input.actualDurationMs, future.resourceForecast.estimatedDurationMs),
          )
        : 0.7;
    const riskAccuracy = 1 - Math.abs(future.risk - actualRisk);
    const accuracy = clamp01(riskAccuracy * 0.7 + durationAccuracy * 0.3);
    const lesson =
      accuracy >= 0.72
        ? `${future.label} prediction was reliable; similar rehearsals can carry more weight.`
        : `${future.label} prediction diverged; lower confidence for similar workflows until more evidence is collected.`;
    const reflection: PredictionReflection = {
      id: `imag-reflect-${ulid()}`,
      sessionId: session.id,
      futureId: future.id,
      predictedSummary: future.summary,
      actualSummary: input.actualSummary,
      predictedRisk: future.risk,
      actualRisk,
      accuracy,
      lesson,
      createdAt: nowIso(),
    };

    this.persistReflection(reflection, {
      ok: input.ok,
      actualDurationMs: input.actualDurationMs,
      sideEffects: input.sideEffects,
    });

    // Causal world model (blueprint #7): close the predict→observe→update
    // loop. Every reflection feeds five (cause, effect) increments — one
    // per effect class — so per-effect probabilities stay calibrated rather
    // than biased toward 1.0 (which would happen if only the firing effect
    // were recorded). Best-effort; never block the reflection on DB failure.
    try {
      const causeClass = classifyAction(session.action);
      const dependencyChanges = input.sideEffects?.dependencyChanges ?? 0;
      const observations = extractEffectsFromReflection({
        ok: input.ok,
        actualRisk,
        accuracy,
        dependencyChanges,
      });
      for (const { effectClass, occurred } of observations) {
        recordObservation({ causeClass, effectClass, occurred });
      }
    } catch (err) {
      console.warn("[imagination] causal observation failed:", err);
    }

    this.persistTimeline({
      id: `imag-tl-${ulid()}`,
      sessionId: session.id,
      kind: "prediction-corrected",
      title: "Prediction compared to execution",
      detail: lesson,
      confidence: accuracy,
      risk: actualRisk,
      createdAt: reflection.createdAt,
      metadata: { futureId: future.id, reflectionId: reflection.id },
    });
    this.bus.emit({ kind: "imagination-reflection", reflection, at: reflection.createdAt });
    this.bus.emit({ kind: "imagination-snapshot", snapshot: this.snapshot(), at: nowIso() });
    return reflection;
  }

  dream(): CognitiveAbstraction[] {
    const sessions = this.recentSessions(20);
    const evidence = sessions.map((session) => session.goal);
    const concepts = inferConcepts(evidence);
    const abstractions = concepts.map((concept) => this.upsertAbstraction(concept.concept, concept.evidence, concept.confidence));
    if (abstractions.length > 0) {
      this.persistTimeline({
        id: `imag-tl-${ulid()}`,
        kind: "dream-consolidated",
        title: "Background consolidation",
        detail: `Consolidated ${abstractions.length} recurring cognitive pattern(s).`,
        confidence: abstractions[0]?.confidence ?? 0.5,
        risk: 0.05,
        createdAt: nowIso(),
        metadata: { abstractionIds: abstractions.map((abstraction) => abstraction.id) },
      });
      this.bus.emit({ kind: "imagination-dream", abstractions, at: nowIso() });
      this.bus.emit({ kind: "imagination-snapshot", snapshot: this.snapshot(), at: nowIso() });
    }
    return abstractions;
  }

  startDreaming(intervalMs = 180_000): () => void {
    if (!this.dreamTimer) {
      this.dreamTimer = setInterval(() => {
        try {
          this.dream();
        } catch (err) {
          console.warn("[imagination] dream consolidation failed:", err);
        }
      }, intervalMs);
      this.dreamTimer.unref?.();
    }
    return () => this.stopDreaming();
  }

  stopDreaming(): void {
    if (this.dreamTimer) {
      clearInterval(this.dreamTimer);
      this.dreamTimer = null;
    }
  }

  snapshot(): ImaginationSnapshot {
    return {
      generatedAt: nowIso(),
      sessions: this.recentSessions(12),
      timeline: this.recentTimeline(60),
      reflections: this.recentReflections(20),
      abstractions: this.recentAbstractions(20),
    };
  }

  private persistSession(session: ImaginationSession): void {
    const selected = session.futures.find((future) => future.id === session.recommendation.futureId) ?? session.futures[0];
    const db = openDb();
    db.prepare(
      `INSERT INTO imagination_sessions
         (id, created_at, goal, action, mode, selected_future_id, risk_score, confidence, result_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      session.id,
      session.createdAt,
      session.goal,
      session.action,
      session.mode,
      session.recommendation.futureId,
      selected?.risk ?? session.recommendation.risk,
      session.recommendation.confidence,
      JSON.stringify(session),
    );
    for (const entry of session.timeline) {
      this.persistTimeline(entry);
    }
  }

  private persistTimeline(entry: ImaginationTimelineEntry): void {
    const db = openDb();
    db.prepare(
      `INSERT OR REPLACE INTO imagination_timeline
         (id, session_id, kind, title, detail, confidence, risk, created_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.id,
      entry.sessionId ?? null,
      entry.kind,
      entry.title,
      entry.detail,
      entry.confidence,
      entry.risk,
      entry.createdAt,
      JSON.stringify(entry.metadata),
    );
  }

  private persistReflection(reflection: PredictionReflection, actual: Record<string, unknown>): void {
    const db = openDb();
    db.prepare(
      `INSERT INTO imagination_reflections
         (id, session_id, future_id, predicted_json, actual_json, accuracy, lesson, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      reflection.id,
      reflection.sessionId,
      reflection.futureId,
      JSON.stringify({
        summary: reflection.predictedSummary,
        risk: reflection.predictedRisk,
      }),
      JSON.stringify({
        summary: reflection.actualSummary,
        risk: reflection.actualRisk,
        ...actual,
      }),
      reflection.accuracy,
      reflection.lesson,
      reflection.createdAt,
    );
  }

  private sessionById(id: string): ImaginationSession | null {
    try {
      const row = openDb()
        .prepare<[string], { result_json: string }>(`SELECT result_json FROM imagination_sessions WHERE id = ?`)
        .get(id);
      return row ? (JSON.parse(row.result_json) as ImaginationSession) : null;
    } catch {
      return null;
    }
  }

  private recentSessions(limit: number): ImaginationSession[] {
    try {
      const rows = openDb()
        .prepare<[number], { result_json: string }>(
          `SELECT result_json FROM imagination_sessions ORDER BY created_at DESC LIMIT ?`,
        )
        .all(Math.max(1, Math.min(100, limit)));
      return rows
        .map((row) => {
          try {
            return JSON.parse(row.result_json) as ImaginationSession;
          } catch {
            return null;
          }
        })
        .filter((session): session is ImaginationSession => Boolean(session));
    } catch {
      return [];
    }
  }

  private recentTimeline(limit: number): ImaginationTimelineEntry[] {
    try {
      return openDb()
        .prepare<
          [number],
          {
            id: string;
            session_id: string | null;
            kind: ImaginationTimelineEntry["kind"];
            title: string;
            detail: string;
            confidence: number;
            risk: number;
            created_at: string;
            metadata: string;
          }
        >(
          `SELECT id, session_id, kind, title, detail, confidence, risk, created_at, metadata
           FROM imagination_timeline ORDER BY created_at DESC LIMIT ?`,
        )
        .all(Math.max(1, Math.min(200, limit)))
        .map((row) => ({
          id: row.id,
          sessionId: row.session_id ?? undefined,
          kind: row.kind,
          title: row.title,
          detail: row.detail,
          confidence: row.confidence,
          risk: row.risk,
          createdAt: row.created_at,
          metadata: safeRecord(row.metadata),
        }));
    } catch {
      return [];
    }
  }

  private recentReflections(limit: number): PredictionReflection[] {
    try {
      return openDb()
        .prepare<
          [number],
          {
            id: string;
            session_id: string;
            future_id: string;
            predicted_json: string;
            actual_json: string;
            accuracy: number;
            lesson: string;
            created_at: string;
          }
        >(
          `SELECT id, session_id, future_id, predicted_json, actual_json, accuracy, lesson, created_at
           FROM imagination_reflections ORDER BY created_at DESC LIMIT ?`,
        )
        .all(Math.max(1, Math.min(200, limit)))
        .map((row) => {
          const predicted = safeRecord(row.predicted_json);
          const actual = safeRecord(row.actual_json);
          return {
            id: row.id,
            sessionId: row.session_id,
            futureId: row.future_id,
            predictedSummary: String(predicted.summary ?? "prediction"),
            actualSummary: String(actual.summary ?? "actual"),
            predictedRisk: Number(predicted.risk ?? 0),
            actualRisk: Number(actual.risk ?? 0),
            accuracy: row.accuracy,
            lesson: row.lesson,
            createdAt: row.created_at,
          };
        });
    } catch {
      return [];
    }
  }

  private recentAbstractions(limit: number): CognitiveAbstraction[] {
    try {
      return openDb()
        .prepare<
          [number],
          { id: string; concept: string; evidence: string; confidence: number; level: number; created_at: string; updated_at: string }
        >(
          `SELECT id, concept, evidence, confidence, level, created_at, updated_at
           FROM cognitive_abstractions ORDER BY confidence DESC, updated_at DESC LIMIT ?`,
        )
        .all(Math.max(1, Math.min(100, limit)))
        .map((row) => ({
          id: row.id,
          concept: row.concept,
          evidence: safeStringArray(row.evidence),
          confidence: row.confidence,
          level: clampLevel(row.level),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }));
    } catch {
      return [];
    }
  }

  private upsertAbstraction(concept: string, evidence: string[], confidence: number): CognitiveAbstraction {
    const db = openDb();
    const now = nowIso();
    const existing = db
      .prepare<[string], { id: string; evidence: string; confidence: number; level: number; created_at: string }>(
        `SELECT id, evidence, confidence, level, created_at FROM cognitive_abstractions WHERE concept = ?`,
      )
      .get(concept);
    const mergedEvidence = Array.from(new Set([...(existing ? safeStringArray(existing.evidence) : []), ...evidence])).slice(0, 12);
    const nextConfidence = clamp01(Math.max(existing?.confidence ?? 0, confidence) + mergedEvidence.length * 0.01);
    const id = existing?.id ?? `abstraction-${ulid()}`;
    // Phase 3 — classify level. A re-dream can only promote, never demote: the
    // user has already seen a higher-level reading and we don't want a
    // shorter-evidence pass to silently regress it.
    const classified = classifyAbstractionLevel(concept, mergedEvidence);
    const level: AbstractionLevel = (
      existing ? Math.max(clampLevel(existing.level), classified) : classified
    ) as AbstractionLevel;
    db.prepare(
      `INSERT INTO cognitive_abstractions (id, concept, evidence, confidence, level, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(concept) DO UPDATE SET
         evidence = excluded.evidence,
         confidence = excluded.confidence,
         level = excluded.level,
         updated_at = excluded.updated_at`,
    ).run(id, concept, JSON.stringify(mergedEvidence), nextConfidence, level, existing?.created_at ?? now, now);
    const abstraction = {
      id,
      concept,
      evidence: mergedEvidence,
      confidence: nextConfidence,
      level,
      createdAt: existing?.created_at ?? now,
      updatedAt: now,
    };
    this.persistTimeline({
      id: `imag-tl-${ulid()}`,
      kind: "abstraction-formed",
      title: concept,
      detail: mergedEvidence[0] ?? concept,
      confidence: nextConfidence,
      risk: 0.05,
      createdAt: now,
      metadata: { abstractionId: id },
    });
    return abstraction;
  }
}

function safeRecord(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function safeStringArray(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

// Coerce the raw DB column (any integer) into the typed 0..5 ladder. A NULL
// or out-of-range value floors to 0 ("sensory") — matching the migration
// default and keeping callers from having to handle an unbounded number.
function clampLevel(raw: number | null | undefined): AbstractionLevel {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  const i = Math.round(raw);
  if (i <= 0) return 0;
  if (i >= 5) return 5;
  return i as AbstractionLevel;
}

function inferConcepts(goals: string[]): Array<{ concept: string; evidence: string[]; confidence: number }> {
  const lower = goals.map((goal) => goal.toLowerCase());
  const concepts: Array<{ concept: string; terms: string[] }> = [
    { concept: "User works on resilient Rust/runtime workflows", terms: ["rust", "cargo", "workspace", "dependency"] },
    { concept: "User favors distributed cognitive architecture", terms: ["swarm", "distributed", "node", "runtime"] },
    { concept: "User values predictive safety before execution", terms: ["simulate", "risk", "future", "sandbox"] },
    { concept: "User develops memory-centered adaptive systems", terms: ["memory", "graph", "consolidation", "learning"] },
  ];
  return concepts
    .map((candidate) => {
      const evidence = goals.filter((goal, index) => candidate.terms.some((term) => lower[index]?.includes(term))).slice(0, 8);
      return {
        concept: candidate.concept,
        evidence,
        confidence: clamp01(0.32 + evidence.length * 0.14),
      };
    })
    .filter((candidate) => candidate.evidence.length >= 2);
}

let singleton: ImaginationEngine | null = null;

export function createImaginationEngine(bus: BrainBus = getEventBus()): ImaginationEngine {
  if (!singleton) {
    singleton = new ImaginationEngine(bus);
  }
  return singleton;
}

export function getImaginationEngine(): ImaginationEngine {
  return createImaginationEngine(getEventBus());
}
