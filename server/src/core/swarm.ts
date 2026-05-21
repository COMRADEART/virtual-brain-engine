import { ulid } from "ulid";
import {
  getEventBus,
  nowIso,
  type BrainBus,
  type BrainEvent,
} from "./eventBus.js";
import type {
  SwarmCapabilityDescriptor,
  SwarmConsensusOpinion,
  SwarmConsensusRound,
  SwarmEvent,
  SwarmHealth,
  SwarmNodeDescriptor,
  SwarmNodeLocation,
  SwarmPolicy,
  SwarmPrivacyMode,
  SwarmResourceUsage,
  SwarmRouteHop,
  SwarmSnapshot,
  SwarmTask,
  SwarmTaskState,
  SwarmTopologyEdge,
  SwarmTrustLevel,
} from "../../../shared/swarm.js";

export type SwarmNodeRegistration = Omit<
  SwarmNodeDescriptor,
  "registeredAt" | "lastHeartbeatAt" | "activeTasks" | "resources" | "health"
> &
  Partial<Pick<SwarmNodeDescriptor, "resources" | "health" | "activeTasks">>;

export interface SwarmTaskInput {
  goal: string;
  requiredCapabilities: string[];
  priority?: number;
  privacyMode?: SwarmPrivacyMode;
  payload?: Record<string, unknown>;
}

export interface SwarmWorkflowOptions {
  includeExecution?: boolean;
  privacyMode?: SwarmPrivacyMode;
  priority?: number;
}

const DEFAULT_POLICY: SwarmPolicy = {
  operatingMode: "hybrid",
  localFirst: true,
  allowRemoteNodes: false,
  allowCloudNodes: false,
  encryptedSync: true,
  maxTaskAttempts: 3,
  consensusThreshold: 0.62,
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function cap(
  id: string,
  label: string,
  category: SwarmCapabilityDescriptor["category"],
  options: Partial<Omit<SwarmCapabilityDescriptor, "id" | "label" | "category">> = {},
): SwarmCapabilityDescriptor {
  return {
    id,
    label,
    category,
    cost: options.cost ?? 0.35,
    requiresNetwork: options.requiresNetwork ?? false,
    permissions: options.permissions ?? [],
    modelProfile: options.modelProfile,
  };
}

function baselineResources(location: SwarmNodeLocation): SwarmResourceUsage {
  return {
    cpu: location === "cloud" ? 0.12 : 0.18,
    ram: location === "cloud" ? 0.08 : 0.22,
    gpu: 0,
    batteryImpact: location === "local" || location === "worker" ? 0.18 : 0.03,
    thermalLoad: location === "local" || location === "worker" ? 0.14 : 0.02,
    latencyMs: location === "local" ? 18 : location === "worker" ? 35 : location === "remote" ? 110 : 260,
    activeTasks: 0,
  };
}

function trustWeight(trust: SwarmTrustLevel): number {
  switch (trust) {
    case "system":
      return 1;
    case "trusted":
      return 0.82;
    case "sandboxed":
      return 0.66;
    case "untrusted":
      return 0.28;
  }
}

function locationWeight(location: SwarmNodeLocation, privacy: SwarmPrivacyMode, policy: SwarmPolicy): number {
  if (privacy === "offline-only" && (location === "remote" || location === "cloud")) return -1000;
  if (location === "cloud" && !policy.allowCloudNodes) return -1000;
  if (location === "remote" && !policy.allowRemoteNodes) return -1000;
  if (privacy === "local-first" && (location === "local" || location === "worker")) return 1;
  if (privacy === "hybrid-allowed" && location !== "cloud") return 0.78;
  if (privacy === "cloud-allowed") return location === "cloud" ? 0.72 : 0.85;
  return location === "local" ? 0.9 : 0.45;
}

function healthWeight(health: SwarmHealth): number {
  switch (health) {
    case "healthy":
      return 1;
    case "degraded":
      return 0.45;
    case "offline":
      return -1000;
  }
}

function routeReason(node: SwarmNodeDescriptor, matches: string[]): string {
  const load = node.resources.activeTasks > 0 ? `${node.resources.activeTasks} active` : "idle";
  return `${node.organ} matched ${matches.join(", ")} with ${node.health} health, ${node.location} locality, ${load} load`;
}

export class CognitiveSwarm {
  private readonly bus: BrainBus;
  private readonly nodes = new Map<string, SwarmNodeDescriptor>();
  private readonly tasks = new Map<string, SwarmTask>();
  private readonly events: SwarmEvent[] = [];
  private readonly consensus: SwarmConsensusRound[] = [];
  private policy: SwarmPolicy = { ...DEFAULT_POLICY };
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private defaultsInstalled = false;

  constructor(bus: BrainBus) {
    this.bus = bus;
  }

  installDefaultNodes(): void {
    if (this.defaultsInstalled) return;
    this.defaultsInstalled = true;
    for (const node of defaultNodeRegistrations()) {
      this.registerNode(node);
    }
    this.emitSnapshot();
  }

  startHeartbeat(intervalMs = 15_000): () => void {
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        this.pulseManagedNodes();
        this.emitSnapshot();
      }, intervalMs);
      this.heartbeatTimer.unref?.();
    }
    return () => this.stopHeartbeat();
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  updatePolicy(next: Partial<SwarmPolicy>): SwarmPolicy {
    this.policy = { ...this.policy, ...next };
    this.append({ kind: "policy-updated", policy: this.policy, at: nowIso() });
    this.emitSnapshot();
    return this.policy;
  }

  registerNode(input: SwarmNodeRegistration): SwarmNodeDescriptor {
    const existing = this.nodes.get(input.id);
    const at = nowIso();
    const resources = input.resources ?? existing?.resources ?? baselineResources(input.location);
    const node: SwarmNodeDescriptor = {
      ...input,
      health: input.health ?? existing?.health ?? "healthy",
      resources: {
        ...resources,
        activeTasks: input.activeTasks?.length ?? existing?.activeTasks.length ?? resources.activeTasks,
      },
      activeTasks: input.activeTasks ?? existing?.activeTasks ?? [],
      registeredAt: existing?.registeredAt ?? at,
      lastHeartbeatAt: at,
    };
    this.nodes.set(node.id, node);
    this.append({ kind: "node-registered", node, at });
    return node;
  }

  heartbeat(nodeId: string, resources?: Partial<SwarmResourceUsage>, health?: SwarmHealth): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    const nextResources: SwarmResourceUsage = {
      ...node.resources,
      ...resources,
      activeTasks: node.activeTasks.length,
    };
    const nextHealth = health ?? deriveHealth(nextResources, node.health);
    const next = {
      ...node,
      health: nextHealth,
      resources: nextResources,
      lastHeartbeatAt: nowIso(),
    };
    this.nodes.set(nodeId, next);
    this.append({
      kind: "node-heartbeat",
      nodeId,
      health: next.health,
      resources: next.resources,
      at: next.lastHeartbeatAt,
    });
  }

  enqueueTask(input: SwarmTaskInput): SwarmTask {
    const at = nowIso();
    const task: SwarmTask = {
      id: `swarm-task-${ulid()}`,
      goal: input.goal,
      requiredCapabilities: input.requiredCapabilities,
      priority: Math.max(0, Math.min(100, input.priority ?? 50)),
      privacyMode: input.privacyMode ?? "local-first",
      state: "queued",
      attempts: 0,
      trace: [],
      payload: input.payload ?? {},
      createdAt: at,
      updatedAt: at,
    };
    this.tasks.set(task.id, task);
    this.append({ kind: "task-queued", task, at });
    this.routeTask(task.id);
    return this.tasks.get(task.id) ?? task;
  }

  routeTask(taskId: string): SwarmTask | null {
    const task = this.tasks.get(taskId);
    if (!task || task.state === "completed" || task.state === "failed") {
      return task ?? null;
    }
    const route = this.bestRoute(task);
    if (!route) {
      const next = this.updateTask(task, "queued", {
        trace: [
          ...task.trace,
          {
            nodeId: "none",
            nodeName: "No available node",
            capability: task.requiredCapabilities.join(", "),
            reason: "No healthy node currently satisfies the privacy, trust, and capability constraints",
            score: 0,
          },
        ],
      });
      this.tasks.set(next.id, next);
      return next;
    }

    const node = this.nodes.get(route.nodeId);
    if (node) {
      const activeTasks = Array.from(new Set([...node.activeTasks, task.id]));
      this.nodes.set(node.id, {
        ...node,
        activeTasks,
        resources: { ...node.resources, activeTasks: activeTasks.length },
      });
    }

    const next = this.updateTask(task, "routed", {
      assignedNodeId: route.nodeId,
      attempts: task.attempts + 1,
      trace: [...task.trace, route],
    });
    this.tasks.set(task.id, next);
    this.append({ kind: "task-routed", task: next, route, at: nowIso() });
    this.scheduleCompletion(next.id);
    this.emitSnapshot();
    return next;
  }

  completeTask(taskId: string): SwarmTask | null {
    const task = this.tasks.get(taskId);
    if (!task || task.state === "completed") return task ?? null;
    const next = this.updateTask(task, "completed");
    this.tasks.set(taskId, next);
    if (task.assignedNodeId) {
      const node = this.nodes.get(task.assignedNodeId);
      if (node) {
        const activeTasks = node.activeTasks.filter((id) => id !== taskId);
        this.nodes.set(node.id, {
          ...node,
          activeTasks,
          resources: { ...node.resources, activeTasks: activeTasks.length },
        });
      }
    }
    this.append({ kind: "task-completed", task: next, at: nowIso() });
    this.emitSnapshot();
    return next;
  }

  routeCognitiveWorkflow(goal: string, payload: Record<string, unknown> = {}, options: SwarmWorkflowOptions = {}): SwarmTask[] {
    const privacyMode = options.privacyMode ?? "local-first";
    const priority = options.priority ?? 62;
    const steps: SwarmTaskInput[] = [
      {
        goal: `Load context for: ${goal}`,
        requiredCapabilities: ["context.project-state"],
        priority: priority + 4,
        privacyMode,
        payload,
      },
      {
        goal: `Retrieve distributed memory for: ${goal}`,
        requiredCapabilities: ["memory.semantic-search"],
        priority: priority + 6,
        privacyMode,
        payload,
      },
      {
        goal: `Create plan for: ${goal}`,
        requiredCapabilities: ["reasoning.plan"],
        priority: priority + 5,
        privacyMode,
        payload,
      },
      {
        goal: `Predict workflow risk for: ${goal}`,
        requiredCapabilities: ["simulation.risk-predict"],
        priority: priority + 3,
        privacyMode,
        payload,
      },
      {
        goal: `Compare reflections for: ${goal}`,
        requiredCapabilities: ["reflection.compare"],
        priority: priority + 2,
        privacyMode,
        payload,
      },
      {
        goal: `Evaluate cognitive fitness for: ${goal}`,
        requiredCapabilities: ["evolution.evaluate"],
        priority: priority + 1,
        privacyMode,
        payload,
      },
      {
        goal: `Preserve continuity for: ${goal}`,
        requiredCapabilities: ["organism.continuity"],
        priority,
        privacyMode,
        payload,
      },
    ];

    if (options.includeExecution) {
      steps.push({
        goal: `Execute safe workflow for: ${goal}`,
        requiredCapabilities: ["execution.workflow-run"],
        priority: priority + 1,
        privacyMode,
        payload,
      });
    }

    steps.push(
      {
        goal: `Store learning from: ${goal}`,
        requiredCapabilities: ["memory.long-term-store"],
        priority,
        privacyMode,
        payload,
      },
      {
        goal: `Render swarm update for: ${goal}`,
        requiredCapabilities: ["ui.notify"],
        priority: priority - 3,
        privacyMode,
        payload,
      },
    );

    const tasks = steps.map((step) => this.enqueueTask(step));
    this.runConsensus(`Select safest route for: ${goal}`, tasks[2]?.id);
    return tasks;
  }

  runConsensus(question: string, taskId?: string): SwarmConsensusRound {
    const candidates = this.snapshotNodes()
      .filter((node) => ["reasoning", "simulation", "reflection", "evolution"].includes(node.type))
      .filter((node) => node.health !== "offline")
      .slice(0, 5);

    const opinions: SwarmConsensusOpinion[] = candidates.map((node, index) => {
      const trust = trustWeight(node.trust);
      const loadPenalty = node.resources.activeTasks * 0.04;
      const risk = clamp01((node.type === "simulation" ? 0.32 : 0.24) + loadPenalty + index * 0.015);
      const confidence = clamp01(0.52 + trust * 0.28 - loadPenalty + (node.type === "reasoning" ? 0.08 : 0));
      const weight = clamp01(confidence * (1 - risk) * trust);
      return {
        nodeId: node.id,
        nodeName: node.name,
        planId: `plan-${node.id}`,
        summary:
          node.type === "simulation"
            ? "Prefer simulated low-risk route before execution."
            : node.type === "evolution"
              ? "Prefer sandboxed workflow mutation with benchmark and rollback gates."
            : node.type === "reflection"
              ? "Prefer reversible steps with explicit learning capture."
              : "Prefer local-first plan with memory recall, risk check, then action.",
        confidence,
        risk,
        weight,
      };
    });

    const winner = opinions
      .slice()
      .sort((a, b) => b.weight - a.weight)[0] ?? {
      nodeId: "none",
      nodeName: "No reasoning node",
      planId: "plan-none",
      summary: "No healthy reasoning node could vote.",
      confidence: 0,
      risk: 1,
      weight: 0,
    };

    const round: SwarmConsensusRound = {
      id: `consensus-${ulid()}`,
      taskId,
      question,
      opinions,
      winningPlanId: winner.planId,
      decision: winner.summary,
      confidence: winner.confidence,
      risk: winner.risk,
      createdAt: nowIso(),
    };
    this.consensus.push(round);
    if (this.consensus.length > 40) this.consensus.shift();
    this.append({ kind: "consensus-completed", round, at: round.createdAt });
    this.emitSnapshot();
    return round;
  }

  observeBrainEvent(event: BrainEvent): void {
    switch (event.kind) {
      case "agent-status":
        this.heartbeat(agentToNodeId(event.agent), undefined, event.state === "error" ? "degraded" : undefined);
        break;
      case "activity-observed":
        this.routeCognitiveWorkflow(`Understand project activity in ${event.projectName}`, {
          source: "activity-observed",
          projectName: event.projectName,
          fileCount: event.files.length,
        });
        break;
      case "summary-created":
        this.enqueueTask({
          goal: `Replicate and index summary memory ${event.memoryId}`,
          requiredCapabilities: ["memory.long-term-store"],
          priority: 58,
          privacyMode: "local-first",
          payload: { memoryId: event.memoryId, projectName: event.projectName },
        });
        break;
      case "twin-anomaly":
        this.enqueueTask({
          goal: `Simulate anomaly recovery for ${event.anomaly.kind}`,
          requiredCapabilities: ["simulation.risk-predict"],
          priority: 72,
          privacyMode: "local-first",
          payload: { anomaly: event.anomaly },
        });
        break;
      case "twin-snapshot":
        this.heartbeat("observer-vision-local");
        break;
      default:
        break;
    }
  }

  snapshot(): SwarmSnapshot {
    return {
      generatedAt: nowIso(),
      policy: this.policy,
      nodes: this.snapshotNodes(),
      tasks: this.snapshotTasks(),
      recentEvents: this.events.slice().reverse().slice(0, 50),
      topology: this.topology(),
      consensus: this.consensus.slice().reverse().slice(0, 20),
    };
  }

  emitSnapshot(): void {
    const at = nowIso();
    this.bus.emit({ kind: "swarm-snapshot", snapshot: this.snapshot(), at });
  }

  private append(event: SwarmEvent): void {
    this.events.push(event);
    if (this.events.length > 200) this.events.shift();
    this.bus.emit({ kind: "swarm-event", event, at: event.at });
  }

  private pulseManagedNodes(): void {
    for (const node of this.nodes.values()) {
      if (node.location === "remote" || node.location === "cloud") {
        continue;
      }
      this.heartbeat(node.id, simulateResources(node));
    }
  }

  private bestRoute(task: SwarmTask): SwarmRouteHop | null {
    let best: SwarmRouteHop | null = null;
    for (const node of this.nodes.values()) {
      const matches = task.requiredCapabilities.filter((required) =>
        node.capabilities.some((capability) => capability.id === required),
      );
      if (matches.length === 0) continue;

      const location = locationWeight(node.location, task.privacyMode, this.policy);
      const health = healthWeight(node.health);
      if (location < 0 || health < 0) continue;

      const capabilityScore = matches.length / Math.max(1, task.requiredCapabilities.length);
      const loadPenalty = node.resources.activeTasks * 0.08 + node.resources.cpu * 0.08 + node.resources.ram * 0.06;
      const latencyPenalty = Math.min(0.2, node.resources.latencyMs / 2000);
      const score = clamp01(
        0.24 +
          capabilityScore * 0.34 +
          trustWeight(node.trust) * 0.18 +
          location * 0.14 +
          health * 0.14 -
          loadPenalty -
          latencyPenalty,
      );
      const route: SwarmRouteHop = {
        nodeId: node.id,
        nodeName: node.name,
        capability: matches[0] ?? task.requiredCapabilities[0] ?? "unknown",
        reason: routeReason(node, matches),
        score,
      };
      if (!best || route.score > best.score) {
        best = route;
      }
    }
    return best;
  }

  private scheduleCompletion(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const delay = Math.max(900, 2600 - task.priority * 12);
    const timer = setTimeout(() => this.completeTask(taskId), delay);
    timer.unref?.();
  }

  private updateTask(task: SwarmTask, state: SwarmTaskState, patch: Partial<SwarmTask> = {}): SwarmTask {
    return {
      ...task,
      ...patch,
      state,
      updatedAt: nowIso(),
    };
  }

  private snapshotNodes(): SwarmNodeDescriptor[] {
    return Array.from(this.nodes.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  private snapshotTasks(): SwarmTask[] {
    return Array.from(this.tasks.values())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 80);
  }

  private topology(): SwarmTopologyEdge[] {
    const ids = new Set(this.nodes.keys());
    const edges: SwarmTopologyEdge[] = [];
    for (const node of this.nodes.values()) {
      if (node.id !== "brain-core-orchestrator" && ids.has("brain-core-orchestrator")) {
        edges.push({
          fromId: "brain-core-orchestrator",
          toId: node.id,
          kind: "routes-to",
          weight: node.health === "healthy" ? 0.82 : node.health === "degraded" ? 0.42 : 0.12,
          active: node.activeTasks.length > 0,
        });
      }
    }
    if (ids.has("memory-cortex-local") && ids.has("context-cortex-local")) {
      edges.push({ fromId: "context-cortex-local", toId: "memory-cortex-local", kind: "observes", weight: 0.68, active: true });
    }
    if (ids.has("memory-cortex-local") && ids.has("memory-replica-worker")) {
      edges.push({ fromId: "memory-cortex-local", toId: "memory-replica-worker", kind: "replicates", weight: 0.54, active: true });
    }
    if (ids.has("reasoning-cortex-local") && ids.has("simulation-cortex-local")) {
      edges.push({ fromId: "reasoning-cortex-local", toId: "simulation-cortex-local", kind: "votes-with", weight: 0.74, active: true });
    }
    return edges;
  }
}

function deriveHealth(resources: SwarmResourceUsage, fallback: SwarmHealth): SwarmHealth {
  if (resources.cpu > 0.94 || resources.ram > 0.94 || resources.thermalLoad > 0.9) return "degraded";
  if (fallback === "offline") return "offline";
  return "healthy";
}

function simulateResources(node: SwarmNodeDescriptor): Partial<SwarmResourceUsage> {
  const active = node.activeTasks.length;
  const typePressure =
    node.type === "execution" ? 0.12 : node.type === "memory" ? 0.08 : node.type === "reasoning" ? 0.1 : 0.05;
  const base = baselineResources(node.location);
  return {
    cpu: clamp01(base.cpu + active * typePressure),
    ram: clamp01(base.ram + active * 0.06),
    gpu: node.modelProfile?.includes("gpu") ? clamp01(0.18 + active * 0.12) : node.resources.gpu,
    batteryImpact: clamp01(base.batteryImpact + active * 0.04),
    thermalLoad: clamp01(base.thermalLoad + active * 0.05),
    latencyMs: Math.round(base.latencyMs + active * 18),
  };
}

function agentToNodeId(agent: string): string {
  switch (agent) {
    case "observer":
    case "system-sensor":
      return "observer-vision-local";
    case "summary":
      return "reasoning-cortex-local";
    case "scheduler":
      return "brain-core-orchestrator";
    default:
      return "brain-core-orchestrator";
  }
}

function defaultNodeRegistrations(): SwarmNodeRegistration[] {
  return [
    {
      id: "brain-core-orchestrator",
      name: "Brain Core",
      organ: "Coordinator Cortex",
      type: "reasoning",
      location: "local",
      mode: "offline",
      trust: "system",
      permissions: ["route.tasks", "vote.consensus", "discover.capabilities"],
      modelProfile: "local-orchestrator",
      capabilities: [
        cap("swarm.orchestrate", "Coordinate distributed cognition", "reasoning"),
        cap("swarm.consensus", "Run consensus votes", "reasoning"),
        cap("swarm.route", "Route tasks by capability and load", "reasoning"),
        cap("capability.discover", "Discover node capabilities", "tool"),
      ],
    },
    {
      id: "context-cortex-local",
      name: "Context Cortex",
      organ: "Context Node",
      type: "context",
      location: "local",
      mode: "offline",
      trust: "trusted",
      permissions: ["read.project-state", "read.active-files"],
      modelProfile: "local-context-heuristic",
      capabilities: [
        cap("context.project-state", "Load project state", "context"),
        cap("context.active-files", "Track active files", "context"),
      ],
    },
    {
      id: "memory-cortex-local",
      name: "Memory Cortex",
      organ: "Memory Node",
      type: "memory",
      location: "local",
      mode: "offline",
      trust: "system",
      permissions: ["read.memory", "write.memory", "index.semantic"],
      modelProfile: "local-embedding",
      capabilities: [
        cap("memory.semantic-search", "Semantic memory search", "memory"),
        cap("memory.vector-index", "Vector indexing", "memory"),
        cap("memory.long-term-store", "Long-term memory storage", "memory"),
        cap("memory.compress", "Memory compression", "memory"),
        cap("memory.knowledge-graph", "Knowledge graph processing", "memory"),
      ],
    },
    {
      id: "memory-replica-worker",
      name: "Memory Replica Worker",
      organ: "Memory Shard",
      type: "memory",
      location: "worker",
      mode: "isolated-secure",
      trust: "trusted",
      permissions: ["read.memory-shard", "write.encrypted-replica"],
      modelProfile: "hashed-embedding-worker",
      capabilities: [
        cap("memory.replicate", "Replicate critical memory", "memory"),
        cap("memory.sync-encrypted", "Encrypted memory sync", "memory"),
      ],
    },
    {
      id: "reasoning-cortex-local",
      name: "Reasoning Cortex",
      organ: "Reasoning Node",
      type: "reasoning",
      location: "local",
      mode: "hybrid",
      trust: "trusted",
      permissions: ["plan.tasks", "reflect", "estimate.risk"],
      modelProfile: "reasoning-focused-local",
      capabilities: [
        cap("reasoning.plan", "Planning", "reasoning", { modelProfile: "reasoning-focused-local" }),
        cap("reasoning.decompose", "Task decomposition", "reasoning"),
        cap("reasoning.risk-estimate", "Risk estimation", "reasoning"),
        cap("reflection.compare", "Reflection comparison", "reflection"),
        cap("consensus.vote", "Consensus voting", "reasoning"),
      ],
    },
    {
      id: "execution-cortex-sandbox",
      name: "Execution Cortex",
      organ: "Execution Node",
      type: "execution",
      location: "worker",
      mode: "isolated-secure",
      trust: "sandboxed",
      permissions: ["terminal.safe", "workflow.run", "build.test"],
      modelProfile: "no-model-sandbox",
      capabilities: [
        cap("execution.terminal-command", "Terminal commands", "execution", { permissions: ["terminal.safe"] }),
        cap("execution.workflow-run", "Workflow automation", "execution"),
        cap("execution.build-test", "Build and test runner", "execution"),
        cap("execution.browser-action", "Browser actions", "execution"),
      ],
    },
    {
      id: "tool-cortex-local",
      name: "Tool Cortex",
      organ: "Tool Node",
      type: "tool",
      location: "local",
      mode: "hybrid",
      trust: "trusted",
      permissions: ["invoke.local-tool", "route.model"],
      modelProfile: "local-tool-router",
      capabilities: [
        cap("tool.ai-model-route", "AI model routing", "tool"),
        cap("tool.local-invoke", "Local tool invocation", "tool"),
        cap("tool.api-call", "External API calls", "tool", { requiresNetwork: true }),
      ],
    },
    {
      id: "observer-vision-local",
      name: "Observer Vision",
      organ: "Observer Node",
      type: "observer",
      location: "local",
      mode: "offline",
      trust: "trusted",
      permissions: ["watch.files", "read.telemetry", "monitor.process"],
      modelProfile: "telemetry-heuristic",
      capabilities: [
        cap("observer.telemetry", "Telemetry", "observer"),
        cap("observer.file-watch", "File watching", "observer"),
        cap("observer.process-monitor", "Process monitoring", "observer"),
        cap("observer.system-analysis", "System analysis", "observer"),
      ],
    },
    {
      id: "simulation-cortex-local",
      name: "Simulation Cortex",
      organ: "Simulation Node",
      type: "simulation",
      location: "local",
      mode: "offline",
      trust: "trusted",
      permissions: ["simulate.workflow", "simulate.dependencies"],
      modelProfile: "predictive-simulator",
      capabilities: [
        cap("simulation.workflow-sim", "Workflow simulation", "simulation"),
        cap("simulation.dependency-predict", "Dependency prediction", "simulation"),
        cap("simulation.resource-forecast", "Resource forecasting", "simulation"),
        cap("simulation.failure-predict", "Failure prediction", "simulation"),
        cap("simulation.risk-predict", "Risk prediction", "simulation"),
        cap("imagination.future-branch", "Branch possible futures", "simulation"),
        cap("imagination.mental-sandbox", "Mental sandboxing", "simulation"),
      ],
    },
    {
      id: "workflow-simulation-node",
      name: "Workflow Simulation",
      organ: "Workflow Simulation Node",
      type: "simulation",
      location: "worker",
      mode: "isolated-secure",
      trust: "trusted",
      permissions: ["simulate.workflow", "read.workflow-state"],
      modelProfile: "workflow-rehearsal",
      capabilities: [
        cap("simulation.workflow-sim", "Workflow rehearsal", "simulation"),
        cap("imagination.execution-graph", "Temporary execution graphs", "simulation"),
      ],
    },
    {
      id: "dependency-prediction-node",
      name: "Dependency Predictor",
      organ: "Dependency Prediction Node",
      type: "simulation",
      location: "worker",
      mode: "isolated-secure",
      trust: "trusted",
      permissions: ["simulate.dependencies"],
      modelProfile: "dependency-heuristic",
      capabilities: [
        cap("simulation.dependency-predict", "Dependency conflict prediction", "simulation"),
        cap("simulation.rollback-complexity", "Rollback complexity estimate", "simulation"),
      ],
    },
    {
      id: "resource-forecast-node",
      name: "Resource Forecaster",
      organ: "Resource Forecasting Node",
      type: "simulation",
      location: "local",
      mode: "offline",
      trust: "trusted",
      permissions: ["read.telemetry", "forecast.resources"],
      modelProfile: "digital-twin-forecast",
      capabilities: [
        cap("simulation.resource-forecast", "CPU/RAM/disk forecast", "simulation"),
        cap("simulation.duration-estimate", "Workflow duration estimate", "simulation"),
      ],
    },
    {
      id: "failure-prediction-node",
      name: "Failure Predictor",
      organ: "Failure Prediction Node",
      type: "simulation",
      location: "local",
      mode: "offline",
      trust: "trusted",
      permissions: ["read.failure-history", "predict.failure"],
      modelProfile: "failure-patterns",
      capabilities: [
        cap("simulation.failure-predict", "Predict likely failures", "simulation"),
        cap("simulation.uncertainty-model", "Cognitive uncertainty model", "simulation"),
      ],
    },
    {
      id: "cognitive-reflection-node",
      name: "Cognitive Reflection",
      organ: "Cognitive Reflection Node",
      type: "reflection",
      location: "local",
      mode: "offline",
      trust: "trusted",
      permissions: ["compare.prediction", "write.lessons"],
      modelProfile: "self-reflection",
      capabilities: [
        cap("reflection.prediction-compare", "Predicted versus actual comparison", "reflection"),
        cap("reflection.meta-reason", "Meta-reasoning", "reflection"),
      ],
    },
    {
      id: "skill-optimization-node",
      name: "Skill Optimizer",
      organ: "Skill Optimization Node",
      type: "reflection",
      location: "worker",
      mode: "offline",
      trust: "trusted",
      permissions: ["read.skill-history", "suggest.skill-update"],
      modelProfile: "skill-optimizer",
      capabilities: [
        cap("skill.optimize", "Skill refinement from prediction accuracy", "reflection"),
        cap("dream.consolidate", "Background consolidation", "reflection"),
      ],
    },
    {
      id: "cognitive-evolution-node",
      name: "Cognitive Evolution",
      organ: "Cognitive Evolution Engine",
      type: "evolution",
      location: "local",
      mode: "offline",
      trust: "system",
      permissions: ["read.cognitive-metrics", "write.evolution-log", "suggest.mutations"],
      modelProfile: "fitness-optimizer",
      capabilities: [
        cap("evolution.evaluate", "Evaluate cognitive fitness", "evolution"),
        cap("evolution.workflow-mutate", "Mutate workflow genomes", "evolution"),
        cap("evolution.skill-evolve", "Evolve versioned skills", "evolution"),
        cap("evolution.reasoning-benchmark", "Benchmark reasoning strategies", "evolution"),
        cap("evolution.identity-refine", "Refine persistent identity traits", "evolution"),
      ],
    },
    {
      id: "architecture-mutation-sandbox",
      name: "Mutation Sandbox",
      organ: "Architecture Mutation System",
      type: "evolution",
      location: "worker",
      mode: "isolated-secure",
      trust: "sandboxed",
      permissions: ["clone.cognitive-state", "benchmark.candidate", "rollback.candidate"],
      modelProfile: "safe-architecture-mutator",
      capabilities: [
        cap("evolution.architecture-mutate", "Sandbox architecture mutations", "evolution"),
        cap("evolution.rollback-snapshot", "Prepare cognitive rollback snapshots", "evolution"),
        cap("evolution.stability-test", "Run architecture stability tests", "evolution"),
      ],
    },
    {
      id: "persistent-organism-core",
      name: "Persistent Organism",
      organ: "Continuity Organ",
      type: "organism",
      location: "local",
      mode: "offline",
      trust: "system",
      permissions: ["read.continuity", "write.goals", "monitor.health", "quarantine.cognition"],
      modelProfile: "persistent-life-cycle",
      capabilities: [
        cap("organism.continuity", "Restore and preserve continuity", "organism"),
        cap("organism.goal-track", "Track long-term goals", "organism"),
        cap("organism.homeostasis", "Regulate cognitive load and energy", "organism"),
        cap("organism.immune-scan", "Detect and quarantine unstable cognition", "organism"),
        cap("organism.dream", "Run idle dream consolidation", "organism"),
      ],
    },
    {
      id: "research-organism-node",
      name: "Research Organism",
      organ: "Sandboxed Research Node",
      type: "organism",
      location: "worker",
      mode: "isolated-secure",
      trust: "sandboxed",
      permissions: ["run.sandboxed-research", "write.reports"],
      modelProfile: "autonomous-research-sandbox",
      capabilities: [
        cap("organism.research", "Sandboxed autonomous research", "organism"),
        cap("organism.subbrain-spawn", "Create specialized sub-brains", "organism"),
      ],
    },
    {
      id: "ui-cortex-desktop",
      name: "UI Cortex",
      organ: "UI Node",
      type: "ui",
      location: "local",
      mode: "offline",
      trust: "trusted",
      permissions: ["notify.user", "render.dashboard"],
      modelProfile: "fast-ui-summary",
      capabilities: [
        cap("ui.notify", "Desktop pet and notifications", "ui"),
        cap("ui.dashboard", "Dashboard visualization", "ui"),
        cap("ui.topology", "Swarm topology graph", "ui"),
      ],
    },
    {
      id: "remote-reasoning-gateway",
      name: "Remote Reasoning Gateway",
      organ: "Remote Cortex",
      type: "reasoning",
      location: "remote",
      mode: "hybrid",
      trust: "untrusted",
      health: "offline",
      permissions: ["network.model-call"],
      modelProfile: "remote-reasoning-model",
      endpoint: "not-configured",
      capabilities: [
        cap("reasoning.plan-heavy", "Heavy remote planning", "reasoning", {
          requiresNetwork: true,
          modelProfile: "cloud-reasoning",
        }),
      ],
    },
    {
      id: "cloud-model-gateway",
      name: "Cloud Model Gateway",
      organ: "Language Cortex",
      type: "tool",
      location: "cloud",
      mode: "cloud-assisted",
      trust: "untrusted",
      health: "offline",
      permissions: ["network.cloud-model"],
      modelProfile: "cloud-model-disabled",
      endpoint: "not-configured",
      capabilities: [
        cap("tool.cloud-model", "Cloud model inference", "tool", {
          requiresNetwork: true,
          modelProfile: "cloud-assisted",
        }),
      ],
    },
  ];
}

let singleton: CognitiveSwarm | null = null;

export function createCognitiveSwarm(bus: BrainBus = getEventBus()): CognitiveSwarm {
  if (!singleton) {
    singleton = new CognitiveSwarm(bus);
    singleton.installDefaultNodes();
  }
  return singleton;
}

export function getCognitiveSwarm(): CognitiveSwarm {
  return createCognitiveSwarm(getEventBus());
}
