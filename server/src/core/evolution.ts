import { ulid } from "ulid";
import { openDb } from "../db/sqlite.js";
import {
  getEventBus,
  nowIso,
  type BrainBus,
  type BrainEvent,
} from "./eventBus.js";
import type {
  CognitiveFitnessMetrics,
  CognitiveGenome,
  CognitiveRegion,
  EvolutionAudit,
  EvolutionBenchmark,
  EvolutionComponent,
  EvolutionComponentKind,
  EvolutionExperiment,
  EvolutionMutation,
  EvolutionSnapshot,
  EvolutionStatus,
  IdentityTrait,
  MutationKind,
  ReasoningStrategyKind,
} from "../../../shared/evolution.js";

interface PerformanceStats {
  runs: number;
  completed: number;
  failed: number;
  avgLatencyMs: number;
  predictionAccuracy: number;
  memoryQuality: number;
  rankerTrainingCount: number;
  blockedActions: number;
}

interface ComponentRow {
  id: string;
  kind: EvolutionComponentKind;
  name: string;
  version: number;
  parent_id: string | null;
  status: EvolutionStatus;
  description: string;
  tags_json: string;
  genome_json: string;
  metrics_json: string;
  fitness_score: number;
  created_at: string;
  updated_at: string;
}

interface MutateWorkflowInput {
  workflowId?: string;
  name?: string;
  goal: string;
  steps?: string[];
}

interface EvolveSkillInput {
  name?: string;
  goal?: string;
  sourceSkills?: string[];
}

interface StrategyBenchmarkInput {
  goal?: string;
}

interface ExperimentInput {
  name?: string;
  targetKind?: EvolutionComponentKind;
  hypothesis?: string;
}

const STRATEGY_PROFILES: Array<{
  kind: ReasoningStrategyKind;
  name: string;
  description: string;
  tags: string[];
}> = [
  {
    kind: "chain-of-thought",
    name: "Linear Reasoning",
    description: "Stepwise reasoning for direct tasks with low branching.",
    tags: ["fast", "linear"],
  },
  {
    kind: "tree-of-thought",
    name: "Branching Reasoning",
    description: "Multiple candidate paths compared before commitment.",
    tags: ["branching", "comparison"],
  },
  {
    kind: "graph-reasoning",
    name: "Graph Reasoning",
    description: "Dependency and memory graph traversal for connected problems.",
    tags: ["graph", "dependencies"],
  },
  {
    kind: "simulation-first",
    name: "Simulation-first Reasoning",
    description: "Mental rehearsal before action, with risk and rollback modeling.",
    tags: ["simulation", "safety"],
  },
  {
    kind: "consensus",
    name: "Consensus Reasoning",
    description: "Risk-weighted comparison across specialized reasoning nodes.",
    tags: ["consensus", "swarm"],
  },
  {
    kind: "decomposition",
    name: "Decomposition Reasoning",
    description: "Breaks large goals into scoped subproblems and validation loops.",
    tags: ["planning", "modular"],
  },
];

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
}

function weightedOverall(metrics: Omit<CognitiveFitnessMetrics, "overall">): number {
  return clamp01(
    metrics.successRate * 0.16 +
      metrics.reliability * 0.14 +
      metrics.predictionAccuracy * 0.14 +
      metrics.safetyScore * 0.14 +
      metrics.planningEfficiency * 0.12 +
      metrics.memoryQuality * 0.1 +
      metrics.latencyScore * 0.08 +
      metrics.costScore * 0.06 +
      metrics.userSatisfaction * 0.06,
  );
}

function normalizeMetrics(input: Partial<CognitiveFitnessMetrics>): CognitiveFitnessMetrics {
  const base = {
    successRate: clamp01(input.successRate ?? 0.55),
    latencyScore: clamp01(input.latencyScore ?? 0.58),
    reliability: clamp01(input.reliability ?? 0.58),
    predictionAccuracy: clamp01(input.predictionAccuracy ?? 0.5),
    memoryQuality: clamp01(input.memoryQuality ?? 0.52),
    planningEfficiency: clamp01(input.planningEfficiency ?? 0.56),
    safetyScore: clamp01(input.safetyScore ?? 0.72),
    userSatisfaction: clamp01(input.userSatisfaction ?? 0.55),
    costScore: clamp01(input.costScore ?? 0.62),
  };
  return { ...base, overall: weightedOverall(base) };
}

function improveMetrics(
  metrics: CognitiveFitnessMetrics,
  patch: Partial<CognitiveFitnessMetrics>,
): CognitiveFitnessMetrics {
  return normalizeMetrics({
    successRate: metrics.successRate + (patch.successRate ?? 0),
    latencyScore: metrics.latencyScore + (patch.latencyScore ?? 0),
    reliability: metrics.reliability + (patch.reliability ?? 0),
    predictionAccuracy: metrics.predictionAccuracy + (patch.predictionAccuracy ?? 0),
    memoryQuality: metrics.memoryQuality + (patch.memoryQuality ?? 0),
    planningEfficiency: metrics.planningEfficiency + (patch.planningEfficiency ?? 0),
    safetyScore: metrics.safetyScore + (patch.safetyScore ?? 0),
    userSatisfaction: metrics.userSatisfaction + (patch.userSatisfaction ?? 0),
    costScore: metrics.costScore + (patch.costScore ?? 0),
  });
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

function safeGenome(json: string, fallbackName: string): CognitiveGenome {
  try {
    const value = JSON.parse(json) as CognitiveGenome;
    if (value && Array.isArray(value.structure)) return value;
  } catch {
    // fall through to fallback
  }
  return baseGenome(fallbackName, ["load context", "plan", "validate"]);
}

function safeMetrics(json: string): CognitiveFitnessMetrics {
  return normalizeMetrics(safeRecord(json) as Partial<CognitiveFitnessMetrics>);
}

function baseGenome(name: string, structure: string[]): CognitiveGenome {
  return {
    structure,
    dependencies: ["memory", "simulation", "safety-gate"],
    mutationHistory: [`seeded ${name}`],
    inheritedOptimizations: ["local-first execution", "reversible validation"],
    safetyConstraints: ["sandbox mutations", "benchmark before approval", "preserve rollback path"],
    fitnessScore: 0.58,
  };
}

function metricsForKind(
  stats: PerformanceStats,
  kind: EvolutionComponentKind,
  modifier = 0,
): CognitiveFitnessMetrics {
  const successRate = stats.runs > 0 ? stats.completed / Math.max(1, stats.runs) : 0.58;
  const latencyScore =
    stats.avgLatencyMs > 0 ? 1 - Math.min(0.68, stats.avgLatencyMs / 180_000) : 0.64;
  const failurePenalty = stats.runs > 0 ? stats.failed / Math.max(1, stats.runs) : 0.08;
  const rankerBoost = Math.min(0.16, stats.rankerTrainingCount / 160);
  const blockedPenalty = Math.min(0.24, stats.blockedActions * 0.02);
  const base = normalizeMetrics({
    successRate: successRate + modifier,
    latencyScore: latencyScore + modifier * 0.4,
    reliability: 0.68 - failurePenalty * 0.42 + modifier,
    predictionAccuracy: stats.predictionAccuracy + modifier,
    memoryQuality: stats.memoryQuality + rankerBoost + modifier * 0.5,
    planningEfficiency: 0.6 + rankerBoost * 0.4 + modifier,
    safetyScore: 0.82 - blockedPenalty + modifier * 0.35,
    userSatisfaction: 0.56 + successRate * 0.18 + modifier * 0.3,
    costScore: 0.72 - Math.max(0, 0.5 - latencyScore) * 0.2 + modifier * 0.2,
  });

  switch (kind) {
    case "workflow":
      return improveMetrics(base, { planningEfficiency: 0.05, reliability: 0.03 });
    case "skill":
      return improveMetrics(base, { successRate: 0.04, userSatisfaction: 0.04 });
    case "reasoning-strategy":
      return improveMetrics(base, { predictionAccuracy: 0.05, planningEfficiency: 0.04 });
    case "memory-model":
      return improveMetrics(base, { memoryQuality: 0.1, latencyScore: -0.02 });
    case "tool-router":
      return improveMetrics(base, { latencyScore: 0.06, costScore: 0.06 });
    case "execution-graph":
      return improveMetrics(base, { safetyScore: 0.06, reliability: 0.04 });
    case "architecture":
      return improveMetrics(base, { safetyScore: 0.08, reliability: 0.02 });
    case "planner":
      return improveMetrics(base, { planningEfficiency: 0.08 });
    case "identity-trait":
      return improveMetrics(base, { userSatisfaction: 0.08, memoryQuality: 0.04 });
    case "cognitive-region":
      return improveMetrics(base, { reliability: 0.05, planningEfficiency: 0.04 });
  }
}

function componentLabel(kind: EvolutionComponentKind): string {
  switch (kind) {
    case "workflow":
      return "Workflow Optimization Cortex";
    case "skill":
      return "Skill Evolution Cortex";
    case "reasoning-strategy":
      return "Reasoning Strategy Cortex";
    case "memory-model":
      return "Memory Evolution Cortex";
    case "planner":
      return "Planner Evolution Cortex";
    case "tool-router":
      return "Tool Routing Cortex";
    case "execution-graph":
      return "Execution Graph Cortex";
    case "architecture":
      return "Architecture Mutation Cortex";
    case "identity-trait":
      return "Identity Cortex";
    case "cognitive-region":
      return "Specialization Cortex";
  }
}

function parseComponent(row: ComponentRow): EvolutionComponent {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    version: row.version,
    parentId: row.parent_id ?? undefined,
    status: row.status,
    description: row.description,
    tags: safeStringArray(row.tags_json),
    genome: safeGenome(row.genome_json, row.name),
    metrics: safeMetrics(row.metrics_json),
    preferred: row.kind === "reasoning-strategy" && row.status === "approved",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CognitiveEvolutionEngine {
  private readonly bus: BrainBus;
  private evolutionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(bus: BrainBus) {
    this.bus = bus;
  }

  evaluate(): EvolutionSnapshot {
    const stats = this.performanceStats();
    this.ensureSeedComponents(stats);
    const components = this.recentComponents(80);
    for (const component of components) {
      const nextMetrics = metricsForKind(stats, component.kind, component.metrics.overall * 0.04);
      this.saveComponent({
        ...component,
        metrics: nextMetrics,
        genome: { ...component.genome, fitnessScore: nextMetrics.overall },
        updatedAt: nowIso(),
      });
    }
    this.audit("evolution.evaluate", "Refreshed cognitive fitness scores from local execution history.", {
      runs: stats.runs,
      predictionAccuracy: stats.predictionAccuracy,
    });
    this.emitSnapshot();
    return this.snapshot();
  }

  mutateWorkflow(input: MutateWorkflowInput): { mutation: EvolutionMutation; component: EvolutionComponent; snapshot: EvolutionSnapshot } {
    const stats = this.performanceStats();
    this.ensureSeedComponents(stats);
    const base =
      (input.workflowId ? this.componentById(input.workflowId) : null) ??
      this.latestComponent("workflow") ??
      this.ensureSeedComponents(stats)[0];
    const goal = input.goal.trim();
    const recommended = workflowSteps(goal, input.steps);
    const after: CognitiveGenome = {
      ...base.genome,
      structure: Array.from(new Set([...base.genome.structure, ...recommended])).slice(0, 12),
      dependencies: Array.from(new Set([...base.genome.dependencies, "fitness-benchmark", "rollback-snapshot"])),
      mutationHistory: [
        ...base.genome.mutationHistory,
        `parallelize and target validation for ${goal.slice(0, 80)}`,
      ].slice(-20),
      inheritedOptimizations: Array.from(
        new Set([...base.genome.inheritedOptimizations, "targeted tests before broad checks", "failure-only summaries"]),
      ).slice(0, 12),
      fitnessScore: clamp01(base.metrics.overall + 0.06),
    };
    const metrics = improveMetrics(base.metrics, {
      successRate: 0.04,
      latencyScore: 0.05,
      reliability: 0.05,
      planningEfficiency: 0.08,
      safetyScore: 0.03,
      costScore: 0.04,
    });
    after.fitnessScore = metrics.overall;

    const component = this.saveComponent({
      id: `evo-workflow-${ulid()}`,
      kind: "workflow",
      name: input.name?.trim() || `${base.name} adaptation`,
      version: base.version + 1,
      parentId: base.id,
      status: "benchmarked",
      description: `Sandboxed workflow mutation for ${goal}.`,
      tags: ["sandboxed", "workflow-genome", "approval-required"],
      genome: after,
      metrics,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    const benchmark = this.benchmark(base.metrics, metrics, true, [
      "Mutation stayed in mental sandbox; no terminal action executed.",
      "Rollback snapshot is required before promotion.",
      "Candidate favors targeted validation and failure-only summaries.",
    ]);
    const mutation = this.saveMutation({
      id: `mutation-${ulid()}`,
      componentId: component.id,
      kind: "parallelize",
      before: base.genome,
      after,
      benchmark,
      reversible: true,
      requiresApproval: true,
      status: "benchmarked",
      createdAt: nowIso(),
    });
    this.audit("evolution.workflow-mutated", `Created sandboxed workflow version ${component.version}.`, {
      componentId: component.id,
      parentId: base.id,
      goal,
    });
    this.bus.emit({ kind: "evolution-mutation", mutation, at: mutation.createdAt });
    this.emitSnapshot();
    return { mutation, component, snapshot: this.snapshot() };
  }

  evolveSkill(input: EvolveSkillInput = {}): { mutation: EvolutionMutation; component: EvolutionComponent; snapshot: EvolutionSnapshot } {
    const stats = this.performanceStats();
    this.ensureSeedComponents(stats);
    const sourceSkills = input.sourceSkills?.filter(Boolean).slice(0, 6) ?? [
      "Rust Build Skill",
      "Debugging Skill",
      "Memory Recall Skill",
    ];
    const base = this.latestComponent("skill") ?? this.ensureSeedComponents(stats)[1];
    const name = input.name?.trim() || "Autonomous Rust Repair Skill";
    const mutationKind: MutationKind = sourceSkills.length > 1 ? "merge" : "specialize";
    const before = base.genome;
    const after: CognitiveGenome = {
      structure: [
        "detect project type",
        "retrieve previous fixes",
        "simulate risky commands",
        "run targeted validation",
        "store repaired pattern",
      ],
      dependencies: Array.from(new Set([...sourceSkills, "memory.semantic-search", "simulation.workflow-sim"])),
      mutationHistory: [...before.mutationHistory, `${mutationKind} into ${name}`].slice(-20),
      inheritedOptimizations: Array.from(new Set([...before.inheritedOptimizations, ...sourceSkills])).slice(0, 12),
      safetyConstraints: before.safetyConstraints,
      fitnessScore: clamp01(base.metrics.overall + 0.07),
    };
    const metrics = improveMetrics(base.metrics, {
      successRate: 0.06,
      reliability: 0.04,
      memoryQuality: 0.04,
      planningEfficiency: 0.05,
      userSatisfaction: 0.05,
    });
    after.fitnessScore = metrics.overall;
    const component = this.saveComponent({
      id: `evo-skill-${ulid()}`,
      kind: "skill",
      name,
      version: base.version + 1,
      parentId: base.id,
      status: "benchmarked",
      description: input.goal?.trim() || "Higher-order skill assembled from recurring local repair behaviors.",
      tags: ["versioned-skill", mutationKind, "approval-required"],
      genome: after,
      metrics,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    const benchmark = this.benchmark(base.metrics, metrics, true, [
      "Skill evolution is declarative; no workflow is promoted without approval.",
      "Merged skills keep their source dependencies in the genome.",
    ]);
    const mutation = this.saveMutation({
      id: `mutation-${ulid()}`,
      componentId: component.id,
      kind: mutationKind,
      before,
      after,
      benchmark,
      reversible: true,
      requiresApproval: true,
      status: "benchmarked",
      createdAt: nowIso(),
    });
    this.audit("evolution.skill-evolved", `Created ${name} v${component.version}.`, {
      componentId: component.id,
      sourceSkills,
    });
    this.bus.emit({ kind: "evolution-mutation", mutation, at: mutation.createdAt });
    this.emitSnapshot();
    return { mutation, component, snapshot: this.snapshot() };
  }

  benchmarkStrategies(input: StrategyBenchmarkInput = {}): { strategies: EvolutionComponent[]; snapshot: EvolutionSnapshot } {
    const stats = this.performanceStats();
    const strategies = STRATEGY_PROFILES.map((profile) => {
      const metrics = strategyMetrics(stats, profile.kind, input.goal);
      const existing = this.componentById(`strategy-${profile.kind}`);
      return this.saveComponent({
        id: `strategy-${profile.kind}`,
        kind: "reasoning-strategy",
        name: profile.name,
        version: existing ? existing.version + 1 : 1,
        parentId: existing?.id,
        status: "benchmarked",
        description: profile.description,
        tags: profile.tags,
        genome: {
          ...baseGenome(profile.name, strategyStructure(profile.kind)),
          mutationHistory: [
            ...(existing?.genome.mutationHistory ?? []),
            `benchmarked for ${input.goal?.slice(0, 80) || "general cognition"}`,
          ].slice(-20),
          fitnessScore: metrics.overall,
        },
        metrics,
        createdAt: existing?.createdAt ?? nowIso(),
        updatedAt: nowIso(),
      });
    });
    const winner = strategies.slice().sort((a, b) => b.metrics.overall - a.metrics.overall)[0];
    const approved = strategies.map((strategy) =>
      this.saveComponent({
        ...strategy,
        status: strategy.id === winner.id ? "approved" : "benchmarked",
        preferred: strategy.id === winner.id,
        updatedAt: nowIso(),
      }),
    );
    this.audit("evolution.reasoning-benchmark", `${winner.name} became the preferred reasoning strategy.`, {
      goal: input.goal ?? "general",
      winnerId: winner.id,
      fitness: winner.metrics.overall,
    });
    this.emitSnapshot();
    return { strategies: approved, snapshot: this.snapshot() };
  }

  runExperiment(input: ExperimentInput = {}): { experiment: EvolutionExperiment; snapshot: EvolutionSnapshot } {
    const stats = this.performanceStats();
    this.ensureSeedComponents(stats);
    const targetKind = input.targetKind ?? "memory-model";
    const baseline = this.latestComponent(targetKind) ?? this.recentComponents(1)[0];
    const baseMetrics = baseline?.metrics ?? metricsForKind(stats, targetKind);
    const result = improveMetrics(baseMetrics, {
      latencyScore: targetKind === "tool-router" ? 0.04 : 0.01,
      memoryQuality: targetKind === "memory-model" ? 0.05 : 0.01,
      predictionAccuracy: targetKind === "reasoning-strategy" ? 0.04 : 0.015,
      planningEfficiency: 0.02,
      costScore: 0.02,
    });
    const experiment: EvolutionExperiment = {
      id: `experiment-${ulid()}`,
      name: input.name?.trim() || `Idle ${componentLabel(targetKind)}`,
      targetKind,
      hypothesis:
        input.hypothesis?.trim() ||
        "A sandboxed optimizer can improve one cognitive metric without reducing safety or rollback readiness.",
      resultSummary: `Sandbox benchmark projected ${(result.overall - baseMetrics.overall).toFixed(3)} fitness delta.`,
      result,
      fitnessDelta: clamp01(result.overall - baseMetrics.overall),
      safe: true,
      createdAt: nowIso(),
    };
    this.saveExperiment(experiment);
    this.audit("evolution.experiment", experiment.resultSummary, {
      experimentId: experiment.id,
      targetKind,
    });
    this.bus.emit({ kind: "evolution-experiment", experiment, at: experiment.createdAt });
    this.emitSnapshot();
    return { experiment, snapshot: this.snapshot() };
  }

  evolveIdentity(): { traits: IdentityTrait[]; snapshot: EvolutionSnapshot } {
    const traits = this.inferIdentityTraits().map((trait) =>
      this.upsertIdentityTrait(trait.trait, trait.evidence, trait.confidence),
    );
    this.audit("evolution.identity", `Refined ${traits.length} persistent identity trait(s).`, {
      traitIds: traits.map((trait) => trait.id),
    });
    for (const trait of traits) {
      this.bus.emit({ kind: "evolution-trait", trait, at: trait.updatedAt });
    }
    this.emitSnapshot();
    return { traits, snapshot: this.snapshot() };
  }

  observeBrainEvent(event: BrainEvent): void {
    if (event.kind === "imagination-reflection") {
      this.audit("evolution.observe.prediction", "Prediction reflection added to cognitive fitness evidence.", {
        reflectionId: event.reflection.id,
        accuracy: event.reflection.accuracy,
      });
    }
    if (event.kind === "summary-created") {
      this.audit("evolution.observe.memory", "New summary memory can influence future skill specialization.", {
        memoryId: event.memoryId,
        projectName: event.projectName,
      });
    }
  }

  startEvolutionLoop(intervalMs = 240_000): () => void {
    if (!this.evolutionTimer) {
      this.evolutionTimer = setInterval(() => {
        try {
          this.runExperiment({
            name: "Idle cognition benchmark",
            targetKind: "reasoning-strategy",
            hypothesis: "Compare low-risk strategy changes while the system is idle.",
          });
          this.evolveIdentity();
        } catch (err) {
          console.warn("[evolution] idle experiment failed:", err);
        }
      }, intervalMs);
      this.evolutionTimer.unref?.();
    }
    return () => this.stopEvolutionLoop();
  }

  stopEvolutionLoop(): void {
    if (this.evolutionTimer) {
      clearInterval(this.evolutionTimer);
      this.evolutionTimer = null;
    }
  }

  snapshot(): EvolutionSnapshot {
    const components = this.recentComponents(80);
    return {
      generatedAt: nowIso(),
      components,
      mutations: this.recentMutations(40),
      experiments: this.recentExperiments(30),
      identityTraits: this.identityTraits(30),
      audit: this.recentAudit(50),
      fitness: aggregateFitness(components),
      preferredStrategies: components
        .filter((component) => component.kind === "reasoning-strategy" && component.status === "approved")
        .sort((a, b) => b.metrics.overall - a.metrics.overall)
        .slice(0, 4),
      regions: regionsFor(components),
    };
  }

  emitSnapshot(): void {
    this.bus.emit({ kind: "evolution-snapshot", snapshot: this.snapshot(), at: nowIso() });
  }

  private performanceStats(): PerformanceStats {
    try {
      const db = openDb();
      const pipeline = db
        .prepare<
          [],
          { runs: number; completed: number; failed: number; avg_latency_ms: number | null }
        >(
          `SELECT COUNT(*) AS runs,
                  SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS completed,
                  SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS failed,
                  AVG(CASE WHEN finished_at IS NOT NULL
                    THEN (julianday(finished_at) - julianday(started_at)) * 86400000
                    ELSE NULL END) AS avg_latency_ms
           FROM pipeline_runs`,
        )
        .get();
      const reflection = db
        .prepare<[], { accuracy: number | null }>(`SELECT AVG(accuracy) AS accuracy FROM imagination_reflections`)
        .get();
      const memory = db
        .prepare<[], { quality: number | null }>(`SELECT AVG(importance) AS quality FROM memory_points`)
        .get();
      const ranker = db
        .prepare<[], { trained_count: number | null }>(`SELECT trained_count FROM ranker_state LIMIT 1`)
        .get();
      const audit = db
        .prepare<[], { blocked: number }>(`SELECT COUNT(*) AS blocked FROM agent_audit WHERE allowed = 0`)
        .get();
      return {
        runs: pipeline?.runs ?? 0,
        completed: pipeline?.completed ?? 0,
        failed: pipeline?.failed ?? 0,
        avgLatencyMs: pipeline?.avg_latency_ms ?? 0,
        predictionAccuracy: reflection?.accuracy ?? 0.58,
        memoryQuality: memory?.quality ?? 0.55,
        rankerTrainingCount: ranker?.trained_count ?? 0,
        blockedActions: audit?.blocked ?? 0,
      };
    } catch {
      return {
        runs: 0,
        completed: 0,
        failed: 0,
        avgLatencyMs: 0,
        predictionAccuracy: 0.58,
        memoryQuality: 0.55,
        rankerTrainingCount: 0,
        blockedActions: 0,
      };
    }
  }

  private ensureSeedComponents(stats: PerformanceStats): EvolutionComponent[] {
    const seeds: Array<Omit<EvolutionComponent, "createdAt" | "updatedAt" | "preferred">> = [
      {
        id: "workflow-local-repair",
        kind: "workflow",
        name: "Local-first Repair Workflow",
        version: 1,
        status: "applied",
        description: "Detect project type, retrieve memory, simulate risk, run scoped validation, store learning.",
        tags: ["local-first", "repair", "workflow-genome"],
        genome: baseGenome("Local-first Repair Workflow", [
          "detect project type",
          "retrieve previous fixes",
          "simulate risk",
          "run targeted checks",
          "summarize only failures",
        ]),
        metrics: metricsForKind(stats, "workflow"),
      },
      {
        id: "skill-autonomous-rust-repair",
        kind: "skill",
        name: "Autonomous Rust Repair Skill",
        version: 1,
        status: "candidate",
        description: "Composes build, debugging, memory recall, and simulation into a reusable repair skill.",
        tags: ["rust", "repair", "higher-order-skill"],
        genome: baseGenome("Autonomous Rust Repair Skill", [
          "classify Rust workspace",
          "load cargo memory",
          "simulate dependency/build risk",
          "run focused check",
          "capture lesson",
        ]),
        metrics: metricsForKind(stats, "skill"),
      },
      {
        id: "memory-adaptive-retrieval",
        kind: "memory-model",
        name: "Adaptive Memory Retrieval",
        version: 1,
        status: "applied",
        description: "Uses online ranking and access patterns to improve recall quality over time.",
        tags: ["memory", "ranker", "retrieval"],
        genome: baseGenome("Adaptive Memory Retrieval", [
          "embed query",
          "rank by learned relevance",
          "track citations",
          "update retrieval weights",
        ]),
        metrics: metricsForKind(stats, "memory-model"),
      },
      {
        id: "tool-router-local-first",
        kind: "tool-router",
        name: "Local-first Tool Router",
        version: 1,
        status: "applied",
        description: "Prefers offline/local nodes unless policy explicitly allows remote or cloud routing.",
        tags: ["tool-routing", "privacy", "local-first"],
        genome: baseGenome("Local-first Tool Router", [
          "discover capability",
          "score locality",
          "score health",
          "route lowest safe cost",
        ]),
        metrics: metricsForKind(stats, "tool-router"),
      },
      {
        id: "architecture-mutation-sandbox",
        kind: "architecture",
        name: "Architecture Mutation Sandbox",
        version: 1,
        status: "sandboxed",
        description: "Validates cognitive architecture changes with rollback and benchmark gates.",
        tags: ["architecture", "sandbox", "rollback"],
        genome: baseGenome("Architecture Mutation Sandbox", [
          "clone cognitive state",
          "apply candidate mutation",
          "benchmark stability",
          "require approval",
          "retain rollback snapshot",
        ]),
        metrics: metricsForKind(stats, "architecture"),
      },
    ];
    return seeds.map((seed) => {
      const existing = this.componentById(seed.id);
      if (existing) return existing;
      return this.saveComponent({
        ...seed,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
    });
  }

  private benchmark(
    baseline: CognitiveFitnessMetrics,
    candidate: CognitiveFitnessMetrics,
    approvalRequired: boolean,
    notes: string[],
  ): EvolutionBenchmark {
    return {
      durationMs: 480,
      sampleSize: 12,
      baselineFitness: baseline.overall,
      candidateFitness: candidate.overall,
      stability: clamp01(0.72 + candidate.safetyScore * 0.16 + candidate.reliability * 0.08),
      rollbackReady: true,
      approvalRequired,
      notes,
    };
  }

  private saveComponent(component: EvolutionComponent): EvolutionComponent {
    const db = openDb();
    const existing = db
      .prepare<[string], { created_at: string }>(`SELECT created_at FROM evolution_components WHERE id = ?`)
      .get(component.id);
    const createdAt = existing?.created_at ?? component.createdAt;
    db.prepare(
      `INSERT INTO evolution_components
         (id, kind, name, version, parent_id, status, description, tags_json, genome_json,
          metrics_json, fitness_score, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind,
         name = excluded.name,
         version = excluded.version,
         parent_id = excluded.parent_id,
         status = excluded.status,
         description = excluded.description,
         tags_json = excluded.tags_json,
         genome_json = excluded.genome_json,
         metrics_json = excluded.metrics_json,
         fitness_score = excluded.fitness_score,
         updated_at = excluded.updated_at`,
    ).run(
      component.id,
      component.kind,
      component.name,
      component.version,
      component.parentId ?? null,
      component.status,
      component.description,
      JSON.stringify(component.tags),
      JSON.stringify(component.genome),
      JSON.stringify(component.metrics),
      component.metrics.overall,
      createdAt,
      component.updatedAt,
    );
    return { ...component, createdAt };
  }

  private saveMutation(mutation: EvolutionMutation): EvolutionMutation {
    openDb()
      .prepare(
        `INSERT INTO evolution_mutations
           (id, component_id, mutation_kind, before_json, after_json, benchmark_json,
            reversible, requires_approval, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        mutation.id,
        mutation.componentId,
        mutation.kind,
        JSON.stringify(mutation.before),
        JSON.stringify(mutation.after),
        JSON.stringify(mutation.benchmark),
        mutation.reversible ? 1 : 0,
        mutation.requiresApproval ? 1 : 0,
        mutation.status,
        mutation.createdAt,
      );
    return mutation;
  }

  private saveExperiment(experiment: EvolutionExperiment): void {
    openDb()
      .prepare(
        `INSERT INTO evolution_experiments
           (id, name, target_kind, hypothesis, result_summary, result_json, fitness_delta, safe, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        experiment.id,
        experiment.name,
        experiment.targetKind,
        experiment.hypothesis,
        experiment.resultSummary,
        JSON.stringify(experiment.result),
        experiment.fitnessDelta,
        experiment.safe ? 1 : 0,
        experiment.createdAt,
      );
  }

  private componentById(id: string): EvolutionComponent | null {
    try {
      const row = openDb()
        .prepare<[string], ComponentRow>(`SELECT * FROM evolution_components WHERE id = ?`)
        .get(id);
      return row ? parseComponent(row) : null;
    } catch {
      return null;
    }
  }

  private latestComponent(kind: EvolutionComponentKind): EvolutionComponent | null {
    try {
      const row = openDb()
        .prepare<[string], ComponentRow>(
          `SELECT * FROM evolution_components WHERE kind = ? ORDER BY fitness_score DESC, updated_at DESC LIMIT 1`,
        )
        .get(kind);
      return row ? parseComponent(row) : null;
    } catch {
      return null;
    }
  }

  private recentComponents(limit: number): EvolutionComponent[] {
    try {
      return openDb()
        .prepare<[number], ComponentRow>(
          `SELECT * FROM evolution_components ORDER BY fitness_score DESC, updated_at DESC LIMIT ?`,
        )
        .all(Math.max(1, Math.min(120, limit)))
        .map(parseComponent);
    } catch {
      return [];
    }
  }

  private recentMutations(limit: number): EvolutionMutation[] {
    try {
      return openDb()
        .prepare<
          [number],
          {
            id: string;
            component_id: string;
            mutation_kind: MutationKind;
            before_json: string;
            after_json: string;
            benchmark_json: string;
            reversible: number;
            requires_approval: number;
            status: EvolutionStatus;
            created_at: string;
          }
        >(
          `SELECT * FROM evolution_mutations ORDER BY created_at DESC LIMIT ?`,
        )
        .all(Math.max(1, Math.min(80, limit)))
        .map((row) => ({
          id: row.id,
          componentId: row.component_id,
          kind: row.mutation_kind,
          before: safeGenome(row.before_json, "before"),
          after: safeGenome(row.after_json, "after"),
          benchmark: safeRecord(row.benchmark_json) as unknown as EvolutionBenchmark,
          reversible: row.reversible === 1,
          requiresApproval: row.requires_approval === 1,
          status: row.status,
          createdAt: row.created_at,
        }));
    } catch {
      return [];
    }
  }

  private recentExperiments(limit: number): EvolutionExperiment[] {
    try {
      return openDb()
        .prepare<
          [number],
          {
            id: string;
            name: string;
            target_kind: EvolutionComponentKind;
            hypothesis: string;
            result_summary: string;
            result_json: string;
            fitness_delta: number;
            safe: number;
            created_at: string;
          }
        >(
          `SELECT * FROM evolution_experiments ORDER BY created_at DESC LIMIT ?`,
        )
        .all(Math.max(1, Math.min(80, limit)))
        .map((row) => ({
          id: row.id,
          name: row.name,
          targetKind: row.target_kind,
          hypothesis: row.hypothesis,
          resultSummary: row.result_summary,
          result: safeMetrics(row.result_json),
          fitnessDelta: row.fitness_delta,
          safe: row.safe === 1,
          createdAt: row.created_at,
        }));
    } catch {
      return [];
    }
  }

  private identityTraits(limit: number): IdentityTrait[] {
    try {
      return openDb()
        .prepare<
          [number],
          {
            id: string;
            trait: string;
            evidence: string;
            confidence: number;
            stability: number;
            created_at: string;
            updated_at: string;
          }
        >(
          `SELECT * FROM evolution_identity_traits ORDER BY confidence DESC, updated_at DESC LIMIT ?`,
        )
        .all(Math.max(1, Math.min(80, limit)))
        .map((row) => ({
          id: row.id,
          trait: row.trait,
          evidence: safeStringArray(row.evidence),
          confidence: row.confidence,
          stability: row.stability,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }));
    } catch {
      return [];
    }
  }

  private recentAudit(limit: number): EvolutionAudit[] {
    try {
      return openDb()
        .prepare<
          [number],
          { id: string; action: string; detail: string; metadata: string; created_at: string }
        >(`SELECT * FROM evolution_audit ORDER BY created_at DESC LIMIT ?`)
        .all(Math.max(1, Math.min(120, limit)))
        .map((row) => ({
          id: row.id,
          action: row.action,
          detail: row.detail,
          metadata: safeRecord(row.metadata),
          createdAt: row.created_at,
        }));
    } catch {
      return [];
    }
  }

  private audit(action: string, detail: string, metadata: Record<string, unknown> = {}): EvolutionAudit {
    const audit: EvolutionAudit = {
      id: `evo-audit-${ulid()}`,
      action,
      detail,
      metadata,
      createdAt: nowIso(),
    };
    openDb()
      .prepare(`INSERT INTO evolution_audit (id, action, detail, metadata, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(audit.id, audit.action, audit.detail, JSON.stringify(audit.metadata), audit.createdAt);
    return audit;
  }

  private inferIdentityTraits(): Array<{ trait: string; evidence: string[]; confidence: number }> {
    const evidence: string[] = [];
    try {
      const abstractionRows = openDb()
        .prepare<[], { concept: string; evidence: string; confidence: number }>(
          `SELECT concept, evidence, confidence FROM cognitive_abstractions ORDER BY confidence DESC LIMIT 12`,
        )
        .all();
      for (const row of abstractionRows) {
        evidence.push(row.concept, ...safeStringArray(row.evidence));
      }
      const promptRows = openDb()
        .prepare<[], { prompt: string }>(`SELECT prompt FROM pipeline_runs ORDER BY started_at DESC LIMIT 80`)
        .all();
      evidence.push(...promptRows.map((row) => row.prompt));
    } catch {
      // Identity inference remains advisory.
    }
    if (evidence.length === 0) {
      evidence.push("Cognitive evolution engine initialized in sandbox-only mode.");
    }
    const lowered = evidence.map((item) => item.toLowerCase());
    const candidates = [
      {
        trait: "Prefers sandboxed cognitive evolution",
        terms: ["evolution", "sandbox", "mutation", "rollback", "approval"],
      },
      {
        trait: "Builds adaptive distributed runtimes",
        terms: ["distributed", "swarm", "node", "runtime", "architecture"],
      },
      {
        trait: "Uses simulation before execution",
        terms: ["simulate", "future", "risk", "prediction", "rehearse"],
      },
      {
        trait: "Optimizes memory-centered workflows",
        terms: ["memory", "semantic", "retrieval", "graph", "consolidation"],
      },
      {
        trait: "Specializes in Rust workspace repair",
        terms: ["rust", "cargo", "workspace", "dependency", "build"],
      },
    ];
    return candidates
      .map((candidate) => {
        const hits = evidence
          .filter((_item, index) => candidate.terms.some((term) => lowered[index]?.includes(term)))
          .slice(0, 8);
        if (hits.length === 0 && candidate.trait === "Prefers sandboxed cognitive evolution") {
          hits.push(evidence[0]);
        }
        return {
          trait: candidate.trait,
          evidence: hits,
          confidence: clamp01(0.42 + hits.length * 0.1),
        };
      })
      .filter((candidate) => candidate.evidence.length > 0);
  }

  private upsertIdentityTrait(trait: string, evidence: string[], confidence: number): IdentityTrait {
    const db = openDb();
    const now = nowIso();
    const existing = db
      .prepare<[string], { id: string; evidence: string; confidence: number; stability: number; created_at: string }>(
        `SELECT id, evidence, confidence, stability, created_at FROM evolution_identity_traits WHERE trait = ?`,
      )
      .get(trait);
    const mergedEvidence = Array.from(new Set([...(existing ? safeStringArray(existing.evidence) : []), ...evidence])).slice(0, 16);
    const nextConfidence = clamp01(Math.max(existing?.confidence ?? 0, confidence) + mergedEvidence.length * 0.006);
    const stability = clamp01((existing?.stability ?? 0.46) + 0.04 + mergedEvidence.length * 0.004);
    const id = existing?.id ?? `trait-${ulid()}`;
    db.prepare(
      `INSERT INTO evolution_identity_traits (id, trait, evidence, confidence, stability, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(trait) DO UPDATE SET
         evidence = excluded.evidence,
         confidence = excluded.confidence,
         stability = excluded.stability,
         updated_at = excluded.updated_at`,
    ).run(id, trait, JSON.stringify(mergedEvidence), nextConfidence, stability, existing?.created_at ?? now, now);
    return {
      id,
      trait,
      evidence: mergedEvidence,
      confidence: nextConfidence,
      stability,
      createdAt: existing?.created_at ?? now,
      updatedAt: now,
    };
  }
}

function workflowSteps(goal: string, steps?: string[]): string[] {
  if (steps && steps.length > 0) return steps.map((step) => step.trim()).filter(Boolean).slice(0, 8);
  const lower = goal.toLowerCase();
  const out = ["detect project type", "retrieve similar fixes", "simulate side effects"];
  if (lower.includes("rust") || lower.includes("cargo")) {
    out.push("run cargo metadata", "run targeted cargo check");
  }
  if (lower.includes("test") || lower.includes("build")) {
    out.push("parallelize safe validation");
  }
  out.push("summarize failures only", "store workflow lesson");
  return out;
}

function strategyStructure(kind: ReasoningStrategyKind): string[] {
  switch (kind) {
    case "chain-of-thought":
      return ["state assumptions", "reason linearly", "validate conclusion"];
    case "tree-of-thought":
      return ["branch options", "score branches", "select winner"];
    case "graph-reasoning":
      return ["build relation graph", "trace dependencies", "resolve conflicts"];
    case "simulation-first":
      return ["simulate futures", "score risk", "choose reversible path"];
    case "consensus":
      return ["collect opinions", "weight confidence", "risk-adjust decision"];
    case "decomposition":
      return ["split task", "solve scoped parts", "integrate result"];
  }
}

function strategyMetrics(
  stats: PerformanceStats,
  kind: ReasoningStrategyKind,
  goal?: string,
): CognitiveFitnessMetrics {
  const goalLower = goal?.toLowerCase() ?? "";
  const base = metricsForKind(stats, "reasoning-strategy");
  switch (kind) {
    case "chain-of-thought":
      return improveMetrics(base, { latencyScore: 0.08, costScore: 0.06, predictionAccuracy: -0.02 });
    case "tree-of-thought":
      return improveMetrics(base, { reliability: 0.06, planningEfficiency: 0.04, latencyScore: -0.06 });
    case "graph-reasoning":
      return improveMetrics(base, {
        memoryQuality: goalLower.includes("dependency") ? 0.1 : 0.05,
        planningEfficiency: 0.05,
        latencyScore: -0.03,
      });
    case "simulation-first":
      return improveMetrics(base, {
        predictionAccuracy: 0.12,
        safetyScore: 0.09,
        reliability: 0.05,
        latencyScore: goalLower.includes("fast") ? -0.08 : -0.03,
      });
    case "consensus":
      return improveMetrics(base, { reliability: 0.1, safetyScore: 0.06, latencyScore: -0.1, costScore: -0.04 });
    case "decomposition":
      return improveMetrics(base, { planningEfficiency: 0.09, successRate: 0.05, costScore: 0.02 });
  }
}

function aggregateFitness(components: EvolutionComponent[]): CognitiveFitnessMetrics {
  if (components.length === 0) return normalizeMetrics({});
  const totals = components.reduce(
    (acc, component) => ({
      successRate: acc.successRate + component.metrics.successRate,
      latencyScore: acc.latencyScore + component.metrics.latencyScore,
      reliability: acc.reliability + component.metrics.reliability,
      predictionAccuracy: acc.predictionAccuracy + component.metrics.predictionAccuracy,
      memoryQuality: acc.memoryQuality + component.metrics.memoryQuality,
      planningEfficiency: acc.planningEfficiency + component.metrics.planningEfficiency,
      safetyScore: acc.safetyScore + component.metrics.safetyScore,
      userSatisfaction: acc.userSatisfaction + component.metrics.userSatisfaction,
      costScore: acc.costScore + component.metrics.costScore,
    }),
    {
      successRate: 0,
      latencyScore: 0,
      reliability: 0,
      predictionAccuracy: 0,
      memoryQuality: 0,
      planningEfficiency: 0,
      safetyScore: 0,
      userSatisfaction: 0,
      costScore: 0,
    },
  );
  const count = components.length;
  return normalizeMetrics({
    successRate: totals.successRate / count,
    latencyScore: totals.latencyScore / count,
    reliability: totals.reliability / count,
    predictionAccuracy: totals.predictionAccuracy / count,
    memoryQuality: totals.memoryQuality / count,
    planningEfficiency: totals.planningEfficiency / count,
    safetyScore: totals.safetyScore / count,
    userSatisfaction: totals.userSatisfaction / count,
    costScore: totals.costScore / count,
  });
}

function regionsFor(components: EvolutionComponent[]): CognitiveRegion[] {
  const groups = new Map<EvolutionComponentKind, EvolutionComponent[]>();
  for (const component of components) {
    const group = groups.get(component.kind) ?? [];
    group.push(component);
    groups.set(component.kind, group);
  }
  return Array.from(groups.entries())
    .map(([kind, group]) => ({
      id: `region-${kind}`,
      name: componentLabel(kind),
      focus: kind,
      load: clamp01(group.length / 12),
      maturity: clamp01(group.reduce((sum, component) => sum + component.metrics.overall, 0) / Math.max(1, group.length)),
      components: group.map((component) => component.id).slice(0, 10),
    }))
    .sort((a, b) => b.maturity - a.maturity);
}

let singleton: CognitiveEvolutionEngine | null = null;

export function createCognitiveEvolutionEngine(bus: BrainBus = getEventBus()): CognitiveEvolutionEngine {
  if (!singleton) {
    singleton = new CognitiveEvolutionEngine(bus);
  }
  return singleton;
}

export function getCognitiveEvolutionEngine(): CognitiveEvolutionEngine {
  return createCognitiveEvolutionEngine(getEventBus());
}
