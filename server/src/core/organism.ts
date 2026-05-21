import { createHash } from "node:crypto";
import { ulid } from "ulid";
import { openDb } from "../db/sqlite.js";
import {
  getEventBus,
  nowIso,
  type BrainBus,
  type BrainEvent,
} from "./eventBus.js";
import { getCognitiveEvolutionEngine } from "./evolution.js";
import { getImaginationEngine } from "./imagination.js";
import type {
  CognitiveEnergy,
  CognitiveHealth,
  ContinuitySnapshot,
  DreamCycle,
  DreamCycleStatus,
  EnergyCategory,
  EnergyUsage,
  GoalAttempt,
  IdentityProfile,
  ImmuneEvent,
  ImmuneSeverity,
  ImmuneStatus,
  MemoryStratum,
  OrganismLifecycleState,
  OrganismSnapshot,
  OrganismState,
  PersistentGoal,
  PersistentGoalStatus,
  ResearchSession,
  SubBrain,
  WorldModel,
} from "../../../shared/organism.js";

interface GoalInput {
  title: string;
  priority?: number;
  dependencies?: string[];
  subgoals?: string[];
  blockers?: string[];
  confidence?: number;
  estimatedCompletionAt?: string;
}

interface GoalUpdateInput {
  goalId: string;
  status?: PersistentGoalStatus;
  progress?: number;
  blockers?: string[];
  attempt?: Omit<GoalAttempt, "id" | "createdAt">;
  confidence?: number;
}

interface ResearchInput {
  title?: string;
  hypothesis?: string;
}

interface SubBrainInput {
  name: string;
  specialization: string;
  inheritedMemoryScopes?: string[];
  inheritedSkills?: string[];
}

interface HealthRow {
  id: string;
  captured_at: string;
  health_score: number;
  memory_integrity: number;
  workflow_stability: number;
  identity_coherence: number;
  goal_alignment: number;
  resource_balance: number;
  immune_load: number;
  issues_json: string;
}

const STATE_KEY = "primary";
const IDENTITY_ID = "primary";
const WORLD_ID = "primary";

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function safeStringArray(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
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

function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

function energyAt(now: string, previous?: CognitiveEnergy): CognitiveEnergy {
  if (!previous) {
    return {
      current: 82,
      capacity: 100,
      reserve: 22,
      rechargeRate: 0.018,
      lastUpdatedAt: now,
    };
  }
  const elapsedMs = Math.max(0, new Date(now).getTime() - new Date(previous.lastUpdatedAt).getTime());
  const recharge = (elapsedMs / 1000) * previous.rechargeRate;
  return {
    ...previous,
    current: clamp(previous.current + recharge, 0, previous.capacity),
    reserve: clamp(previous.reserve + recharge * 0.2, 0, 35),
    lastUpdatedAt: now,
  };
}

function stateFromRecord(value: Record<string, unknown>): OrganismState | null {
  if (!value.id || !value.lifecycle) return null;
  const energyCandidate = value.energy && typeof value.energy === "object" ? (value.energy as Partial<CognitiveEnergy>) : undefined;
  const energy =
    typeof energyCandidate?.current === "number" &&
    typeof energyCandidate.capacity === "number" &&
    typeof energyCandidate.reserve === "number" &&
    typeof energyCandidate.rechargeRate === "number" &&
    typeof energyCandidate.lastUpdatedAt === "string"
      ? (energyCandidate as CognitiveEnergy)
      : undefined;
  return {
    id: String(value.id),
    lifecycle: value.lifecycle as OrganismLifecycleState,
    mode: (value.mode as OrganismState["mode"]) ?? "offline",
    continuityId: typeof value.continuityId === "string" ? value.continuityId : undefined,
    uptimeStartedAt: String(value.uptimeStartedAt ?? nowIso()),
    lastWakeAt: String(value.lastWakeAt ?? nowIso()),
    lastSleepAt: typeof value.lastSleepAt === "string" ? value.lastSleepAt : undefined,
    cognitiveLoad: Number(value.cognitiveLoad ?? 0),
    workflowLoad: Number(value.workflowLoad ?? 0),
    resourceThrottle: Number(value.resourceThrottle ?? 0),
    energy: energyAt(nowIso(), energy),
    updatedAt: String(value.updatedAt ?? nowIso()),
  };
}

function defaultState(): OrganismState {
  const now = nowIso();
  return {
    id: "organism-primary",
    lifecycle: "booting",
    mode: "offline",
    uptimeStartedAt: now,
    lastWakeAt: now,
    cognitiveLoad: 0.18,
    workflowLoad: 0.12,
    resourceThrottle: 0,
    energy: energyAt(now),
    updatedAt: now,
  };
}

function parseHealth(row: HealthRow | undefined): CognitiveHealth {
  if (!row) {
    return {
      id: "health-cold-start",
      capturedAt: nowIso(),
      healthScore: 0.64,
      memoryIntegrity: 0.64,
      workflowStability: 0.64,
      identityCoherence: 0.55,
      goalAlignment: 0.58,
      resourceBalance: 0.62,
      immuneLoad: 0.1,
      issues: ["health model has not completed its first maintenance cycle"],
    };
  }
  return {
    id: row.id,
    capturedAt: row.captured_at,
    healthScore: row.health_score,
    memoryIntegrity: row.memory_integrity,
    workflowStability: row.workflow_stability,
    identityCoherence: row.identity_coherence,
    goalAlignment: row.goal_alignment,
    resourceBalance: row.resource_balance,
    immuneLoad: row.immune_load,
    issues: safeStringArray(row.issues_json),
  };
}

export class PersistentOrganismEngine {
  private readonly bus: BrainBus;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private dreamTimer: ReturnType<typeof setInterval> | null = null;

  constructor(bus: BrainBus) {
    this.bus = bus;
  }

  wake(): OrganismSnapshot {
    this.ensureSeeds();
    this.setLifecycle("booting", "restoring continuity after process start");
    const restored = this.restoreContinuity();
    this.updateWorldModel();
    const health = this.measureHealth();
    const continuity = this.captureContinuity("wake", restored, health);
    this.setState({
      lifecycle: health.healthScore < 0.42 ? "recovering" : "observing",
      continuityId: continuity.id,
      lastWakeAt: nowIso(),
      cognitiveLoad: health.healthScore < 0.42 ? 0.38 : 0.2,
      workflowLoad: this.activeGoals().length / 10,
      resourceThrottle: health.resourceBalance < 0.35 ? 0.55 : 0.08,
    });
    this.emitSnapshot();
    return this.snapshot();
  }

  snapshot(): OrganismSnapshot {
    this.ensureSeeds();
    const state = this.getState();
    return {
      generatedAt: nowIso(),
      state,
      goals: this.recentGoals(40),
      continuity: this.continuity(24),
      identity: this.identity(),
      health: this.latestHealth(),
      energyUsage: this.energyUsage(40),
      immuneEvents: this.immuneEvents(40),
      dreamCycles: this.dreamCycles(20),
      researchSessions: this.researchSessions(20),
      worldModel: this.worldModel(),
      subBrains: this.subBrains(20),
      memoryStrata: this.memoryStrata(),
    };
  }

  createGoal(input: GoalInput): { goal: PersistentGoal; snapshot: OrganismSnapshot } {
    const now = nowIso();
    const goal: PersistentGoal = {
      id: `goal-${ulid()}`,
      title: input.title.trim(),
      status: "active",
      progress: 0,
      priority: Math.round(clamp(input.priority ?? 62, 0, 100)),
      dependencies: input.dependencies ?? [],
      subgoals: input.subgoals ?? [],
      attempts: [],
      blockers: input.blockers ?? [],
      confidence: clamp01(input.confidence ?? 0.58),
      estimatedCompletionAt: input.estimatedCompletionAt,
      createdAt: now,
      updatedAt: now,
    };
    this.saveGoal(goal);
    this.consumeEnergy("planning", `track goal: ${goal.title}`, 3, { goalId: goal.id });
    this.setLifecycle("planning", `persistent goal created: ${goal.title}`);
    this.emitSnapshot();
    return { goal, snapshot: this.snapshot() };
  }

  updateGoal(input: GoalUpdateInput): { goal: PersistentGoal; snapshot: OrganismSnapshot } {
    const goal = this.goalById(input.goalId);
    if (!goal) throw new Error("goal not found");
    const attempt = input.attempt
      ? {
          id: `attempt-${ulid()}`,
          summary: input.attempt.summary,
          outcome: input.attempt.outcome,
          createdAt: nowIso(),
        }
      : null;
    const next: PersistentGoal = {
      ...goal,
      status: input.status ?? goal.status,
      progress: clamp01(input.progress ?? goal.progress),
      blockers: input.blockers ?? goal.blockers,
      attempts: attempt ? [...goal.attempts, attempt].slice(-18) : goal.attempts,
      confidence: clamp01(input.confidence ?? goal.confidence),
      updatedAt: nowIso(),
    };
    this.saveGoal(next);
    this.consumeEnergy("planning", `update goal: ${next.title}`, 2, { goalId: next.id });
    this.emitSnapshot();
    return { goal: next, snapshot: this.snapshot() };
  }

  runMaintenance(): { health: CognitiveHealth; snapshot: OrganismSnapshot } {
    this.setLifecycle("consolidating", "self-maintenance cycle started");
    const health = this.measureHealth();
    this.runImmuneScan(health);
    this.updateWorldModel();
    this.captureContinuity("maintenance", this.restoreContinuity(), health);
    this.consumeEnergy("maintenance", "memory, goal, world model, and immune maintenance", 7, {
      healthScore: health.healthScore,
    });
    this.setLifecycle(health.healthScore < 0.45 ? "recovering" : "idle", "self-maintenance cycle completed");
    this.emitSnapshot();
    return { health, snapshot: this.snapshot() };
  }

  dream(): { dream: DreamCycle; snapshot: OrganismSnapshot } {
    const startedAt = nowIso();
    this.setLifecycle("dreaming", "idle dream-state consolidation");
    const outputs: string[] = [];
    const activities = [
      "memory consolidation",
      "simulation replay",
      "abstraction formation",
      "skill refinement",
      "prediction retraining",
    ];
    try {
      const abstractions = getImaginationEngine().dream();
      outputs.push(`formed ${abstractions.length} abstraction(s)`);
    } catch (err) {
      outputs.push(`imagination consolidation skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const experiment = getCognitiveEvolutionEngine().runExperiment({
        name: "Dream-state skill refinement",
        targetKind: "reasoning-strategy",
        hypothesis: "Replay recent cognition to improve strategy selection without real-world execution.",
      }).experiment;
      outputs.push(`ran sandbox experiment ${experiment.id}`);
    } catch (err) {
      outputs.push(`evolution replay skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
    const energyCost = this.consumeEnergy("dream", "dream-state consolidation", 14, { activities });
    const dream: DreamCycle = {
      id: `dream-${ulid()}`,
      startedAt,
      endedAt: nowIso(),
      status: "completed",
      activities,
      outputs,
      energyCost,
    };
    this.saveDream(dream);
    this.setLifecycle("idle", "dream-state consolidation completed");
    this.emitSnapshot();
    return { dream, snapshot: this.snapshot() };
  }

  runResearch(input: ResearchInput = {}): { session: ResearchSession; snapshot: OrganismSnapshot } {
    this.setLifecycle("evolving", "sandboxed autonomous research session");
    const title = input.title?.trim() || "Autonomous organism architecture research";
    const hypothesis =
      input.hypothesis?.trim() ||
      "A sandboxed research loop can improve cognitive continuity without reducing safety or energy reserve.";
    const findings: string[] = [];
    try {
      const result = getCognitiveEvolutionEngine().runExperiment({
        name: title,
        targetKind: "architecture",
        hypothesis,
      }).experiment;
      findings.push(result.resultSummary);
    } catch (err) {
      findings.push(`research experiment could not run: ${err instanceof Error ? err.message : String(err)}`);
    }
    findings.push("No external network access or terminal execution was performed.");
    const risk = findings.some((finding) => finding.includes("could not")) ? 0.28 : 0.16;
    const now = nowIso();
    const session: ResearchSession = {
      id: `research-${ulid()}`,
      title,
      hypothesis,
      status: "completed",
      sandboxed: true,
      findings,
      risk,
      createdAt: now,
      updatedAt: now,
    };
    this.saveResearch(session);
    this.consumeEnergy("research", title, 16, { risk, sandboxed: true });
    this.setLifecycle("idle", "sandboxed research completed");
    this.emitSnapshot();
    return { session, snapshot: this.snapshot() };
  }

  reproduce(input: SubBrainInput): { subBrain: SubBrain; snapshot: OrganismSnapshot } {
    const identity = this.identity();
    const now = nowIso();
    const subBrain: SubBrain = {
      id: `subbrain-${ulid()}`,
      name: input.name.trim(),
      specialization: input.specialization.trim(),
      inheritedMemoryScopes: input.inheritedMemoryScopes ?? identity.projectExpertise.slice(0, 4),
      inheritedSkills: input.inheritedSkills ?? identity.trustedWorkflows.slice(0, 5),
      inheritedSafetyRules: [
        "local-first privacy",
        "sandbox before execution",
        "approval before mutation promotion",
        "quarantine unstable workflows",
      ],
      maturity: 0.34,
      createdAt: now,
      updatedAt: now,
    };
    openDb()
      .prepare(
        `INSERT INTO organism_subbrains
           (id, name, specialization, memory_scopes_json, skills_json, safety_rules_json, maturity, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        subBrain.id,
        subBrain.name,
        subBrain.specialization,
        JSON.stringify(subBrain.inheritedMemoryScopes),
        JSON.stringify(subBrain.inheritedSkills),
        JSON.stringify(subBrain.inheritedSafetyRules),
        subBrain.maturity,
        subBrain.createdAt,
        subBrain.updatedAt,
      );
    this.consumeEnergy("research", `create sub-brain: ${subBrain.name}`, 9, { subBrainId: subBrain.id });
    this.emitSnapshot();
    return { subBrain, snapshot: this.snapshot() };
  }

  observeBrainEvent(event: BrainEvent): void {
    switch (event.kind) {
      case "agent-status":
        if (event.state === "thinking") this.setLifecycle("planning", `${event.agent} is thinking`);
        if (event.state === "acting") this.setLifecycle("executing", `${event.agent} is acting`);
        if (event.state === "error") {
          this.recordImmuneEvent({
            kind: "anomalous-behavior",
            severity: "medium",
            status: "isolated",
            target: event.agent,
            detail: event.detail ?? `${event.agent} entered error state`,
            metadata: { agent: event.agent },
          });
        }
        break;
      case "activity-observed":
        this.setLifecycle("observing", `observed ${event.files.length} changed file(s)`);
        this.consumeEnergy("passive", `observe ${event.projectName}`, 0.8, { fileCount: event.files.length });
        break;
      case "summary-created":
        this.setLifecycle("learning", `stored summary memory ${event.memoryId}`);
        this.consumeEnergy("maintenance", "integrate summary memory", 1.4, { memoryId: event.memoryId });
        break;
      case "twin-anomaly":
        this.recordImmuneEvent({
          kind: "anomalous-behavior",
          severity: event.anomaly.severity === "critical" ? "critical" : event.anomaly.severity === "warn" ? "medium" : "low",
          status: "observed",
          target: event.anomaly.metric,
          detail: event.anomaly.detail ?? event.anomaly.kind,
          metadata: { anomalyId: event.anomaly.id, value: event.anomaly.value },
        });
        break;
      case "imagination-dream":
        this.setLifecycle("dreaming", `absorbed ${event.abstractions.length} dream abstraction(s)`);
        break;
      case "evolution-mutation":
        openDb()
          .prepare(
            `INSERT INTO organism_mutation_history (id, source_id, kind, summary, reversible, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            `org-mut-${ulid()}`,
            event.mutation.id,
            event.mutation.kind,
            `Cognitive mutation ${event.mutation.kind} benchmarked for ${event.mutation.componentId}`,
            event.mutation.reversible ? 1 : 0,
            event.at,
          );
        break;
      default:
        break;
    }
  }

  startAutonomy(intervalMs = 180_000): () => void {
    if (!this.maintenanceTimer) {
      this.maintenanceTimer = setInterval(() => {
        try {
          this.runMaintenance();
        } catch (err) {
          console.warn("[organism] maintenance failed:", err);
        }
      }, intervalMs);
      this.maintenanceTimer.unref?.();
    }
    if (!this.dreamTimer) {
      this.dreamTimer = setInterval(() => {
        try {
          const state = this.getState();
          if (state.lifecycle === "idle" && state.energy.current > 42) {
            this.dream();
          }
        } catch (err) {
          console.warn("[organism] dream cycle failed:", err);
        }
      }, intervalMs * 2);
      this.dreamTimer.unref?.();
    }
    return () => this.stopAutonomy();
  }

  stopAutonomy(): void {
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
    if (this.dreamTimer) {
      clearInterval(this.dreamTimer);
      this.dreamTimer = null;
    }
    this.setState({ lifecycle: "idle", lastSleepAt: nowIso() });
  }

  emitSnapshot(): void {
    this.bus.emit({ kind: "organism-snapshot", snapshot: this.snapshot(), at: nowIso() });
  }

  private ensureSeeds(): void {
    this.getState();
    this.identity();
    this.worldModel();
    if (this.recentGoals(1).length === 0) {
      const seedGoals = [
        "Stabilize persistent cognitive organism runtime",
        "Optimize memory architecture",
        "Improve Rust workflow automation",
      ];
      for (const title of seedGoals) {
        this.saveGoal({
          id: `goal-${ulid()}`,
          title,
          status: "active",
          progress: title.includes("persistent") ? 0.42 : 0.24,
          priority: title.includes("persistent") ? 82 : 64,
          dependencies: title.includes("Rust") ? ["memory recall", "simulation-first validation"] : ["continuity snapshots"],
          subgoals: title.includes("memory")
            ? ["measure memory strata", "compress stale memories", "repair graph drift"]
            : ["capture state", "restore context", "audit safety"],
          attempts: [],
          blockers: [],
          confidence: 0.62,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        });
      }
    }
  }

  private restoreContinuity(): string[] {
    const latest = this.continuity(1)[0];
    const restored: string[] = [];
    if (latest) {
      restored.push(...latest.restoredWorkflows);
      restored.push(...latest.activeGoalIds.map((id) => `goal:${id}`));
    }
    for (const goal of this.activeGoals().slice(0, 6)) {
      restored.push(`unfinished:${goal.title}`);
    }
    return Array.from(new Set(restored)).slice(0, 12);
  }

  private captureContinuity(reason: string, restoredWorkflows: string[], health: CognitiveHealth): ContinuitySnapshot {
    const state = this.getState();
    const goals = this.activeGoals();
    const world = this.worldModel();
    const contextSummary = `${reason}: ${goals.length} active goal(s), ${restoredWorkflows.length} restored workflow reference(s).`;
    const snapshot: ContinuitySnapshot = {
      id: `continuity-${ulid()}`,
      createdAt: nowIso(),
      lifecycle: state.lifecycle,
      activeGoalIds: goals.map((goal) => goal.id),
      restoredWorkflows,
      contextSummary,
      worldHash: sha1(JSON.stringify(world)),
      energy: state.energy,
      healthScore: health.healthScore,
    };
    openDb()
      .prepare(
        `INSERT INTO continuity_snapshots
           (id, created_at, lifecycle_state, active_goal_ids, context_json, world_json,
            restored_workflows, energy_json, health_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.id,
        snapshot.createdAt,
        snapshot.lifecycle,
        JSON.stringify(snapshot.activeGoalIds),
        JSON.stringify({ contextSummary }),
        JSON.stringify({ worldHash: snapshot.worldHash, summary: world.summary }),
        JSON.stringify(restoredWorkflows),
        JSON.stringify(snapshot.energy),
        JSON.stringify({ healthScore: health.healthScore, issues: health.issues }),
      );
    this.setState({ continuityId: snapshot.id });
    return snapshot;
  }

  private measureHealth(): CognitiveHealth {
    const db = openDb();
    const memory = db
      .prepare<[], { total: number; empty_count: number }>(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN LENGTH(TRIM(content)) = 0 THEN 1 ELSE 0 END) AS empty_count
         FROM memory_points`,
      )
      .get();
    const runs = db
      .prepare<[], { total: number; failed: number }>(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS failed
         FROM pipeline_runs WHERE started_at >= datetime('now', '-14 days')`,
      )
      .get();
    const twin = db
      .prepare<[], { health_score: number }>(`SELECT health_score FROM system_snapshots ORDER BY captured_at DESC LIMIT 1`)
      .get();
    const openImmune = db
      .prepare<[], { count: number }>(
        `SELECT COUNT(*) AS count FROM immune_events WHERE status IN ('observed','isolated','quarantined')`,
      )
      .get();
    const traits = this.identity().traits.length;
    const activeGoals = this.activeGoals();
    const blockedGoals = activeGoals.filter((goal) => goal.blockers.length > 0).length;
    const memoryIntegrity = clamp01(1 - (memory?.empty_count ?? 0) / Math.max(1, memory?.total ?? 1));
    const workflowStability = clamp01(1 - (runs?.failed ?? 0) / Math.max(1, runs?.total ?? 1));
    const identityCoherence = clamp01(0.48 + traits * 0.06);
    const goalAlignment = clamp01(0.76 - blockedGoals * 0.09 + activeGoals.length * 0.015);
    const resourceBalance = clamp01(twin?.health_score ?? 0.62);
    const immuneLoad = clamp01((openImmune?.count ?? 0) / 10);
    const issues = [
      memoryIntegrity < 0.92 ? "memory integrity requires cleanup" : "",
      workflowStability < 0.62 ? "recent workflow failures elevated" : "",
      identityCoherence < 0.58 ? "identity profile still low-confidence" : "",
      goalAlignment < 0.55 ? "active goals have blockers or conflict" : "",
      resourceBalance < 0.45 ? "resource pressure is high" : "",
      immuneLoad > 0.35 ? "immune system has unresolved events" : "",
    ].filter(Boolean);
    const healthScore = clamp01(
      memoryIntegrity * 0.18 +
        workflowStability * 0.18 +
        identityCoherence * 0.15 +
        goalAlignment * 0.15 +
        resourceBalance * 0.18 +
        (1 - immuneLoad) * 0.16,
    );
    const health: CognitiveHealth = {
      id: `health-${ulid()}`,
      capturedAt: nowIso(),
      healthScore,
      memoryIntegrity,
      workflowStability,
      identityCoherence,
      goalAlignment,
      resourceBalance,
      immuneLoad,
      issues,
    };
    db.prepare(
      `INSERT INTO cognitive_health
         (id, captured_at, health_score, memory_integrity, workflow_stability, identity_coherence,
          goal_alignment, resource_balance, immune_load, issues_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      health.id,
      health.capturedAt,
      health.healthScore,
      health.memoryIntegrity,
      health.workflowStability,
      health.identityCoherence,
      health.goalAlignment,
      health.resourceBalance,
      health.immuneLoad,
      JSON.stringify(health.issues),
    );
    this.setState({
      cognitiveLoad: clamp01(1 - health.healthScore + activeGoals.length * 0.04),
      workflowLoad: clamp01(activeGoals.length / 8),
      resourceThrottle: resourceBalance < 0.45 ? clamp01(1 - resourceBalance) : 0.08,
    });
    return health;
  }

  private runImmuneScan(health: CognitiveHealth): void {
    if (health.memoryIntegrity < 0.92) {
      this.recordImmuneEvent({
        kind: "corrupted-memory",
        severity: health.memoryIntegrity < 0.7 ? "high" : "medium",
        status: "isolated",
        target: "memory_points",
        detail: "Detected empty or malformed memory records; cleanup should stay local and auditable.",
        metadata: { memoryIntegrity: health.memoryIntegrity },
      });
    }
    if (health.workflowStability < 0.62) {
      this.recordImmuneEvent({
        kind: "unstable-reasoning",
        severity: "medium",
        status: "isolated",
        target: "pipeline_runs",
        detail: "Recent workflow failure ratio is elevated; prefer simulation-first planning.",
        metadata: { workflowStability: health.workflowStability },
      });
    }
    const active = this.activeGoals();
    const titles = new Set<string>();
    for (const goal of active) {
      const key = goal.title.toLowerCase();
      if (titles.has(key)) {
        this.recordImmuneEvent({
          kind: "conflicting-goals",
          severity: "low",
          status: "observed",
          target: goal.id,
          detail: `Duplicate active goal detected: ${goal.title}`,
          metadata: { goalId: goal.id },
        });
      }
      titles.add(key);
    }
  }

  private recordImmuneEvent(input: {
    kind: ImmuneEvent["kind"];
    severity: ImmuneSeverity;
    status: ImmuneStatus;
    target: string;
    detail: string;
    metadata?: Record<string, unknown>;
  }): ImmuneEvent {
    const db = openDb();
    const duplicate = db
      .prepare<[string, string], { id: string }>(
        `SELECT id FROM immune_events
         WHERE kind = ? AND target = ? AND status IN ('observed','isolated','quarantined')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(input.kind, input.target);
    if (duplicate) {
      const existing = this.immuneEvents(80).find((event) => event.id === duplicate.id);
      if (existing) return existing;
    }
    const event: ImmuneEvent = {
      id: `immune-${ulid()}`,
      kind: input.kind,
      severity: input.severity,
      status: input.status,
      target: input.target,
      detail: input.detail,
      metadata: input.metadata ?? {},
      createdAt: nowIso(),
    };
    db.prepare(
      `INSERT INTO immune_events
         (id, kind, severity, status, target, detail, metadata, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.id,
      event.kind,
      event.severity,
      event.status,
      event.target,
      event.detail,
      JSON.stringify(event.metadata),
      event.createdAt,
      event.resolvedAt ?? null,
    );
    this.bus.emit({ kind: "organism-immune-event", event, at: event.createdAt });
    return event;
  }

  private updateWorldModel(): WorldModel {
    const goals = this.recentGoals(12);
    const traits = this.identity().traits;
    const workflowRows = openDb()
      .prepare<[], { prompt: string }>(`SELECT prompt FROM pipeline_runs ORDER BY started_at DESC LIMIT 40`)
      .all();
    const workflowText = workflowRows.map((row) => row.prompt);
    const habits = [
      ...traits.filter((trait) => /sandbox|simulation|memory|distributed|rust/i.test(trait)),
      workflowText.some((text) => /rust|cargo|workspace/i.test(text)) ? "returns to Rust workspace reliability" : "",
      workflowText.some((text) => /memory|graph|embedding/i.test(text)) ? "iterates on memory architecture" : "",
    ].filter(Boolean);
    const world: WorldModel = {
      id: WORLD_ID,
      summary: `${goals.filter((goal) => goal.status === "active").length} active long-term goal(s); ${habits.length} stable behavior pattern(s).`,
      userHabits: Array.from(new Set(habits)).slice(0, 10),
      projectEvolution: goals.map((goal) => `${goal.title}: ${Math.round(goal.progress * 100)}%`).slice(0, 10),
      workflowPatterns: Array.from(new Set(workflowText.map(classifyWorkflow))).filter(Boolean).slice(0, 10),
      environmentChanges: this.environmentChanges(),
      installedToolChanges: this.installedToolChanges(),
      aiCapabilityChanges: this.aiCapabilityChanges(),
      historicalTrends: [
        "memory, simulation, swarm, evolution, and organism layers are converging",
        "local-first privacy and sandboxed mutation remain dominant constraints",
      ],
      updatedAt: nowIso(),
    };
    openDb()
      .prepare(
        `INSERT INTO organism_world_model
           (id, summary, user_habits_json, project_evolution_json, workflow_patterns_json,
            environment_changes_json, installed_tools_json, ai_capabilities_json, historical_trends_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           summary = excluded.summary,
           user_habits_json = excluded.user_habits_json,
           project_evolution_json = excluded.project_evolution_json,
           workflow_patterns_json = excluded.workflow_patterns_json,
           environment_changes_json = excluded.environment_changes_json,
           installed_tools_json = excluded.installed_tools_json,
           ai_capabilities_json = excluded.ai_capabilities_json,
           historical_trends_json = excluded.historical_trends_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        world.id,
        world.summary,
        JSON.stringify(world.userHabits),
        JSON.stringify(world.projectEvolution),
        JSON.stringify(world.workflowPatterns),
        JSON.stringify(world.environmentChanges),
        JSON.stringify(world.installedToolChanges),
        JSON.stringify(world.aiCapabilityChanges),
        JSON.stringify(world.historicalTrends),
        world.updatedAt,
      );
    return world;
  }

  private consumeEnergy(category: EnergyCategory, task: string, amount: number, metadata: Record<string, unknown>): number {
    const state = this.getState();
    const now = nowIso();
    const recharged = energyAt(now, state.energy);
    const balanceAfter = clamp(recharged.current - amount, 0, recharged.capacity);
    const nextEnergy = {
      ...recharged,
      current: balanceAfter,
      reserve: balanceAfter < 18 ? clamp(recharged.reserve - 1, 0, 35) : recharged.reserve,
      lastUpdatedAt: now,
    };
    this.setState({ energy: nextEnergy });
    openDb()
      .prepare(
        `INSERT INTO energy_usage (id, created_at, category, task, amount, balance_after, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(`energy-${ulid()}`, now, category, task, amount, balanceAfter, JSON.stringify(metadata));
    return amount;
  }

  private getState(): OrganismState {
    const row = openDb()
      .prepare<[string], { value: string }>(`SELECT value FROM organism_state WHERE key = ?`)
      .get(STATE_KEY);
    const state = stateFromRecord(row ? safeRecord(row.value) : {}) ?? defaultState();
    this.saveState({ ...state, energy: energyAt(nowIso(), state.energy), updatedAt: nowIso() });
    return state;
  }

  private setLifecycle(lifecycle: OrganismLifecycleState, reason: string): void {
    this.setState({ lifecycle });
    this.bus.emit({ kind: "organism-lifecycle", lifecycle, reason, at: nowIso() });
  }

  private setState(patch: Partial<OrganismState>): OrganismState {
    const row = openDb()
      .prepare<[string], { value: string }>(`SELECT value FROM organism_state WHERE key = ?`)
      .get(STATE_KEY);
    const existing = stateFromRecord(row ? safeRecord(row.value) : {}) ?? defaultState();
    const state: OrganismState = {
      ...existing,
      ...patch,
      energy: patch.energy ?? energyAt(nowIso(), existing.energy),
      updatedAt: nowIso(),
    };
    this.saveState(state);
    return state;
  }

  private saveState(state: OrganismState): void {
    openDb()
      .prepare(
        `INSERT INTO organism_state (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(STATE_KEY, JSON.stringify(state), state.updatedAt);
  }

  private saveGoal(goal: PersistentGoal): void {
    openDb()
      .prepare(
        `INSERT INTO goal_history
           (id, goal_id, title, status, progress, priority, dependencies_json, subgoals_json,
            attempts_json, blockers_json, confidence, estimated_completion, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `goal-row-${ulid()}`,
        goal.id,
        goal.title,
        goal.status,
        goal.progress,
        goal.priority,
        JSON.stringify(goal.dependencies),
        JSON.stringify(goal.subgoals),
        JSON.stringify(goal.attempts),
        JSON.stringify(goal.blockers),
        goal.confidence,
        goal.estimatedCompletionAt ?? null,
        goal.createdAt,
        goal.updatedAt,
      );
  }

  private goalById(goalId: string): PersistentGoal | null {
    return this.recentGoals(200).find((goal) => goal.id === goalId) ?? null;
  }

  private activeGoals(): PersistentGoal[] {
    return this.recentGoals(80).filter((goal) => goal.status === "active" || goal.status === "blocked");
  }

  private recentGoals(limit: number): PersistentGoal[] {
    const rows = openDb()
      .prepare<
        [number],
        {
          goal_id: string;
          title: string;
          status: PersistentGoalStatus;
          progress: number;
          priority: number;
          dependencies_json: string;
          subgoals_json: string;
          attempts_json: string;
          blockers_json: string;
          confidence: number;
          estimated_completion: string | null;
          created_at: string;
          updated_at: string;
        }
      >(`SELECT * FROM goal_history ORDER BY updated_at DESC LIMIT ?`)
      .all(Math.max(1, Math.min(400, limit * 8)));
    const seen = new Set<string>();
    const goals: PersistentGoal[] = [];
    for (const row of rows) {
      if (seen.has(row.goal_id)) continue;
      seen.add(row.goal_id);
      goals.push({
        id: row.goal_id,
        title: row.title,
        status: row.status,
        progress: row.progress,
        priority: row.priority,
        dependencies: safeStringArray(row.dependencies_json),
        subgoals: safeStringArray(row.subgoals_json),
        attempts: parseAttempts(row.attempts_json),
        blockers: safeStringArray(row.blockers_json),
        confidence: row.confidence,
        estimatedCompletionAt: row.estimated_completion ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
      if (goals.length >= limit) break;
    }
    return goals;
  }

  private continuity(limit: number): ContinuitySnapshot[] {
    return openDb()
      .prepare<
        [number],
        {
          id: string;
          created_at: string;
          lifecycle_state: OrganismLifecycleState;
          active_goal_ids: string;
          context_json: string;
          world_json: string;
          restored_workflows: string;
          energy_json: string;
          health_json: string;
        }
      >(`SELECT * FROM continuity_snapshots ORDER BY created_at DESC LIMIT ?`)
      .all(Math.max(1, Math.min(100, limit)))
      .map((row) => {
        const context = safeRecord(row.context_json);
        const world = safeRecord(row.world_json);
        const health = safeRecord(row.health_json);
        return {
          id: row.id,
          createdAt: row.created_at,
          lifecycle: row.lifecycle_state,
          activeGoalIds: safeStringArray(row.active_goal_ids),
          restoredWorkflows: safeStringArray(row.restored_workflows),
          contextSummary: String(context.contextSummary ?? "continuity snapshot"),
          worldHash: String(world.worldHash ?? sha1(row.world_json)),
          energy: energyAt(nowIso(), safeRecord(row.energy_json) as unknown as CognitiveEnergy),
          healthScore: Number(health.healthScore ?? 0.5),
        };
      });
  }

  private identity(): IdentityProfile {
    const row = openDb()
      .prepare<
        [string],
        {
          id: string;
          name: string;
          traits_json: string;
          preferences_json: string;
          expertise_json: string;
          tool_familiarity_json: string;
          communication_style: string;
          planning_style: string;
          execution_tendencies_json: string;
          trusted_workflows_json: string;
          confidence: number;
          updated_at: string;
        }
      >(`SELECT * FROM identity_profiles WHERE id = ?`)
      .get(IDENTITY_ID);
    if (row) {
      return {
        id: row.id,
        name: row.name,
        traits: safeStringArray(row.traits_json),
        cognitivePreferences: safeStringArray(row.preferences_json),
        projectExpertise: safeStringArray(row.expertise_json),
        toolFamiliarity: safeStringArray(row.tool_familiarity_json),
        communicationStyle: row.communication_style,
        planningStyle: row.planning_style,
        executionTendencies: safeStringArray(row.execution_tendencies_json),
        trustedWorkflows: safeStringArray(row.trusted_workflows_json),
        confidence: row.confidence,
        updatedAt: row.updated_at,
      };
    }
    const evolutionTraits = this.evolutionTraits();
    const identity: IdentityProfile = {
      id: IDENTITY_ID,
      name: "Computer Brain Organism",
      traits: evolutionTraits.length > 0 ? evolutionTraits : ["local-first", "simulation-before-execution", "memory-centered"],
      cognitivePreferences: ["sandboxed mutation", "risk-weighted decisions", "persistent continuity"],
      projectExpertise: ["distributed cognitive runtimes", "memory systems", "Rust workflow repair"],
      toolFamiliarity: ["Ollama", "SQLite", "Vite", "TypeScript", "Cargo"],
      communicationStyle: "direct, technical, continuity-aware",
      planningStyle: "simulation-first with rollback and audit trails",
      executionTendencies: ["prefer targeted checks", "store lessons", "avoid irreversible actions"],
      trustedWorkflows: ["local-first repair workflow", "mental sandbox", "cognitive evolution benchmark"],
      confidence: 0.62,
      updatedAt: nowIso(),
    };
    openDb()
      .prepare(
        `INSERT INTO identity_profiles
           (id, name, traits_json, preferences_json, expertise_json, tool_familiarity_json,
            communication_style, planning_style, execution_tendencies_json, trusted_workflows_json,
            confidence, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        identity.id,
        identity.name,
        JSON.stringify(identity.traits),
        JSON.stringify(identity.cognitivePreferences),
        JSON.stringify(identity.projectExpertise),
        JSON.stringify(identity.toolFamiliarity),
        identity.communicationStyle,
        identity.planningStyle,
        JSON.stringify(identity.executionTendencies),
        JSON.stringify(identity.trustedWorkflows),
        identity.confidence,
        identity.updatedAt,
      );
    return identity;
  }

  private worldModel(): WorldModel {
    const row = openDb()
      .prepare<
        [string],
        {
          id: string;
          summary: string;
          user_habits_json: string;
          project_evolution_json: string;
          workflow_patterns_json: string;
          environment_changes_json: string;
          installed_tools_json: string;
          ai_capabilities_json: string;
          historical_trends_json: string;
          updated_at: string;
        }
      >(`SELECT * FROM organism_world_model WHERE id = ?`)
      .get(WORLD_ID);
    if (!row) return this.updateWorldModel();
    return {
      id: row.id,
      summary: row.summary,
      userHabits: safeStringArray(row.user_habits_json),
      projectEvolution: safeStringArray(row.project_evolution_json),
      workflowPatterns: safeStringArray(row.workflow_patterns_json),
      environmentChanges: safeStringArray(row.environment_changes_json),
      installedToolChanges: safeStringArray(row.installed_tools_json),
      aiCapabilityChanges: safeStringArray(row.ai_capabilities_json),
      historicalTrends: safeStringArray(row.historical_trends_json),
      updatedAt: row.updated_at,
    };
  }

  private latestHealth(): CognitiveHealth {
    const row = openDb()
      .prepare<[], HealthRow>(`SELECT * FROM cognitive_health ORDER BY captured_at DESC LIMIT 1`)
      .get();
    return parseHealth(row);
  }

  private energyUsage(limit: number): EnergyUsage[] {
    return openDb()
      .prepare<
        [number],
        {
          id: string;
          created_at: string;
          category: EnergyCategory;
          task: string;
          amount: number;
          balance_after: number;
          metadata: string;
        }
      >(`SELECT * FROM energy_usage ORDER BY created_at DESC LIMIT ?`)
      .all(Math.max(1, Math.min(120, limit)))
      .map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        category: row.category,
        task: row.task,
        amount: row.amount,
        balanceAfter: row.balance_after,
        metadata: safeRecord(row.metadata),
      }));
  }

  private immuneEvents(limit: number): ImmuneEvent[] {
    return openDb()
      .prepare<
        [number],
        {
          id: string;
          kind: ImmuneEvent["kind"];
          severity: ImmuneSeverity;
          status: ImmuneStatus;
          target: string;
          detail: string;
          metadata: string;
          created_at: string;
          resolved_at: string | null;
        }
      >(`SELECT * FROM immune_events ORDER BY created_at DESC LIMIT ?`)
      .all(Math.max(1, Math.min(120, limit)))
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        severity: row.severity,
        status: row.status,
        target: row.target,
        detail: row.detail,
        metadata: safeRecord(row.metadata),
        createdAt: row.created_at,
        resolvedAt: row.resolved_at ?? undefined,
      }));
  }

  private dreamCycles(limit: number): DreamCycle[] {
    return openDb()
      .prepare<
        [number],
        {
          id: string;
          started_at: string;
          ended_at: string | null;
          status: DreamCycleStatus;
          activities_json: string;
          outputs_json: string;
          energy_cost: number;
        }
      >(`SELECT * FROM dream_cycles ORDER BY started_at DESC LIMIT ?`)
      .all(Math.max(1, Math.min(80, limit)))
      .map((row) => ({
        id: row.id,
        startedAt: row.started_at,
        endedAt: row.ended_at ?? undefined,
        status: row.status,
        activities: safeStringArray(row.activities_json),
        outputs: safeStringArray(row.outputs_json),
        energyCost: row.energy_cost,
      }));
  }

  private saveDream(dream: DreamCycle): void {
    openDb()
      .prepare(
        `INSERT INTO dream_cycles (id, started_at, ended_at, status, activities_json, outputs_json, energy_cost)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        dream.id,
        dream.startedAt,
        dream.endedAt ?? null,
        dream.status,
        JSON.stringify(dream.activities),
        JSON.stringify(dream.outputs),
        dream.energyCost,
      );
  }

  private researchSessions(limit: number): ResearchSession[] {
    return openDb()
      .prepare<
        [number],
        {
          id: string;
          title: string;
          hypothesis: string;
          status: ResearchSession["status"];
          sandboxed: number;
          findings_json: string;
          risk: number;
          created_at: string;
          updated_at: string;
        }
      >(`SELECT * FROM research_sessions ORDER BY updated_at DESC LIMIT ?`)
      .all(Math.max(1, Math.min(80, limit)))
      .map((row) => ({
        id: row.id,
        title: row.title,
        hypothesis: row.hypothesis,
        status: row.status,
        sandboxed: row.sandboxed === 1,
        findings: safeStringArray(row.findings_json),
        risk: row.risk,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  private saveResearch(session: ResearchSession): void {
    openDb()
      .prepare(
        `INSERT INTO research_sessions
           (id, title, hypothesis, status, sandboxed, findings_json, risk, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.title,
        session.hypothesis,
        session.status,
        session.sandboxed ? 1 : 0,
        JSON.stringify(session.findings),
        session.risk,
        session.createdAt,
        session.updatedAt,
      );
  }

  private subBrains(limit: number): SubBrain[] {
    return openDb()
      .prepare<
        [number],
        {
          id: string;
          name: string;
          specialization: string;
          memory_scopes_json: string;
          skills_json: string;
          safety_rules_json: string;
          maturity: number;
          created_at: string;
          updated_at: string;
        }
      >(`SELECT * FROM organism_subbrains ORDER BY maturity DESC, updated_at DESC LIMIT ?`)
      .all(Math.max(1, Math.min(80, limit)))
      .map((row) => ({
        id: row.id,
        name: row.name,
        specialization: row.specialization,
        inheritedMemoryScopes: safeStringArray(row.memory_scopes_json),
        inheritedSkills: safeStringArray(row.skills_json),
        inheritedSafetyRules: safeStringArray(row.safety_rules_json),
        maturity: row.maturity,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  private memoryStrata(): MemoryStratum[] {
    const db = openDb();
    const memory = db.prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM memory_points`).get()?.count ?? 0;
    const messages = db.prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM messages`).get()?.count ?? 0;
    const clusters = db.prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM memory_clusters`).get()?.count ?? 0;
    const access = db.prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM memory_access_log`).get()?.count ?? 0;
    return [
      { timescale: "immediate", count: this.energyUsage(12).length, compression: 0.08, priority: 0.86 },
      { timescale: "working", count: this.activeGoals().length, compression: 0.16, priority: 0.9 },
      { timescale: "short-term", count: messages, compression: 0.28, priority: 0.7 },
      { timescale: "episodic", count: this.continuity(100).length, compression: 0.36, priority: 0.72 },
      { timescale: "semantic", count: memory, compression: 0.52, priority: 0.82 },
      { timescale: "long-term", count: clusters, compression: 0.68, priority: 0.75 },
      { timescale: "archival", count: access, compression: 0.78, priority: 0.42 },
    ];
  }

  private evolutionTraits(): string[] {
    try {
      return openDb()
        .prepare<[], { trait: string }>(
          `SELECT trait FROM evolution_identity_traits ORDER BY confidence DESC LIMIT 8`,
        )
        .all()
        .map((row) => row.trait);
    } catch {
      return [];
    }
  }

  private environmentChanges(): string[] {
    try {
      const latest = openDb()
        .prepare<[], { captured_at: string; health_score: number }>(
          `SELECT captured_at, health_score FROM system_snapshots ORDER BY captured_at DESC LIMIT 1`,
        )
        .get();
      return latest ? [`latest system health ${Math.round(latest.health_score * 100)}% at ${latest.captured_at}`] : [];
    } catch {
      return [];
    }
  }

  private installedToolChanges(): string[] {
    try {
      return openDb()
        .prepare<[], { kind: string; state: string }>(`SELECT kind, state FROM connectors ORDER BY updated_at DESC LIMIT 8`)
        .all()
        .map((row) => `${row.kind}:${row.state}`);
    } catch {
      return [];
    }
  }

  private aiCapabilityChanges(): string[] {
    try {
      return openDb()
        .prepare<[], { name: string; model: string | null; state: string }>(
          `SELECT name, model, state FROM connectors ORDER BY updated_at DESC LIMIT 8`,
        )
        .all()
        .map((row) => `${row.name} ${row.model ?? "model-unset"} ${row.state}`);
    } catch {
      return [];
    }
  }
}

function parseAttempts(json: string): GoalAttempt[] {
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item) => ({
        id: String(item.id ?? `attempt-${ulid()}`),
        summary: String(item.summary ?? ""),
        outcome: (item.outcome as GoalAttempt["outcome"]) ?? "unknown",
        createdAt: String(item.createdAt ?? nowIso()),
      }));
  } catch {
    return [];
  }
}

function classifyWorkflow(prompt: string): string {
  const lower = prompt.toLowerCase();
  if (lower.includes("rust") || lower.includes("cargo")) return "Rust workspace repair";
  if (lower.includes("memory") || lower.includes("embedding")) return "Memory architecture";
  if (lower.includes("swarm") || lower.includes("distributed")) return "Distributed cognition";
  if (lower.includes("simulate") || lower.includes("prediction")) return "Simulation-first planning";
  if (lower.includes("evolution") || lower.includes("mutation")) return "Cognitive evolution";
  if (lower.includes("organism") || lower.includes("persistent")) return "Persistent organism continuity";
  return "general cognition";
}

let singleton: PersistentOrganismEngine | null = null;

export function createPersistentOrganism(bus: BrainBus = getEventBus()): PersistentOrganismEngine {
  if (!singleton) {
    singleton = new PersistentOrganismEngine(bus);
  }
  return singleton;
}

export function getPersistentOrganism(): PersistentOrganismEngine {
  return createPersistentOrganism(getEventBus());
}
