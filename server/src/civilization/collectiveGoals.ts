import { ulid } from "ulid";
import type {
  CollectiveGoal,
  Subgoal,
  GoalStatus,
  BrainPeer,
} from "../../../shared/civilization.js";
import { BrainNetwork } from "./brainNetwork.js";

export interface CollectiveGoalsConfig {
  decompositionDepthLimit: number;
  deadlineExtensionMs: number;
  progressReportIntervalMs: number;
  autoAbandonThreshold: number;
  creditAssignmentStrategy: "equal" | "contribution" | "trust-weighted";
}

const DEFAULT_CONFIG: CollectiveGoalsConfig = {
  decompositionDepthLimit: 5,
  deadlineExtensionMs: 86400000,
  progressReportIntervalMs: 3600000,
  autoAbandonThreshold: 0.3,
  creditAssignmentStrategy: "contribution",
};

export interface GoalEventHandlers {
  onGoalProposed?: (goal: CollectiveGoal) => void;
  onGoalAccepted?: (goal: CollectiveGoal) => void;
  onGoalCompleted?: (goal: CollectiveGoal) => void;
  onGoalAbandoned?: (goal: CollectiveGoal, reason: string) => void;
  onSubgoalCompleted?: (goalId: string, subgoalId: string) => void;
  onProgressUpdate?: (goalId: string, progress: number) => void;
}

export class CollectiveGoalSystem {
  private readonly config: CollectiveGoalsConfig;
  private readonly network: BrainNetwork;
  private readonly handlers: GoalEventHandlers;
  private readonly goals = new Map<string, CollectiveGoal>();
  private readonly goalAcceptances = new Map<string, Set<string>>();
  private myBrainId: string = "self";
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  private trustEvaluator: (brainId: string) => number = () => 0.5;

  constructor(
    network: BrainNetwork,
    config: Partial<CollectiveGoalsConfig> = {},
    handlers: GoalEventHandlers = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.network = network;
    this.handlers = handlers;
  }

  setMyBrainId(brainId: string): void {
    this.myBrainId = brainId;
  }

  setTrustEvaluator(evaluator: (brainId: string) => number): void {
    this.trustEvaluator = evaluator;
  }

  start(): void {
    this.progressTimer = setInterval(() => {
      this.checkProgress();
      this.checkDeadlines();
    }, this.config.progressReportIntervalMs);
    this.progressTimer.unref?.();
  }

  stop(): void {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  proposeGoal(
    title: string,
    description: string,
    assignedBrainIds: string[] = [],
    priority: number = 50,
    deadline?: string,
  ): CollectiveGoal {
    const goal: CollectiveGoal = {
      id: `goal-${ulid()}`,
      title,
      description,
      status: "proposed",
      proposerId: this.myBrainId,
      assignedBrainIds,
      subgoals: [],
      progress: 0,
      priority,
      deadline,
      createdAt: new Date().toISOString(),
    };

    this.goals.set(goal.id, goal);
    this.goalAcceptances.set(goal.id, new Set());

    this.handlers.onGoalProposed?.(goal);
    this.broadcastGoal(goal);

    return goal;
  }

  acceptGoal(goalId: string, brainId: string): boolean {
    const goal = this.goals.get(goalId);
    if (!goal || goal.status !== "proposed") return false;

    const acceptances = this.goalAcceptances.get(goalId)!;
    acceptances.add(brainId);

    if (!goal.assignedBrainIds.includes(brainId)) {
      goal.assignedBrainIds.push(brainId);
    }

    if (goal.assignedBrainIds.length > 0 && acceptances.size >= goal.assignedBrainIds.length * 0.5) {
      goal.status = "accepted";
      this.handlers.onGoalAccepted?.(goal);
    }

    return true;
  }

  declineGoal(goalId: string, brainId: string): void {
    const goal = this.goals.get(goalId);
    if (!goal) return;

    if (goal.assignedBrainIds.includes(brainId)) {
      goal.assignedBrainIds = goal.assignedBrainIds.filter((id) => id !== brainId);
    }

    if (goal.assignedBrainIds.length === 0) {
      goal.status = "abandoned";
      goal.completedAt = new Date().toISOString();
      this.handlers.onGoalAbandoned?.(goal, "No participants accepted");
    }
  }

  decomposeGoal(
    goalId: string,
    subgoals: Array<{ title: string; assignedBrainId?: string; dependsOn: string[] }>,
  ): Subgoal[] {
    const goal = this.goals.get(goalId);
    if (!goal || goal.status === "completed" || goal.status === "abandoned") return [];

    const depth = this.calculateGoalDepth(goal);
    if (depth >= this.config.decompositionDepthLimit) return [];

    const createdSubgoals: Subgoal[] = [];

    for (const sg of subgoals) {
      const validDepends = sg.dependsOn.filter((depId) =>
        goal.subgoals.some((s) => s.id === depId) || createdSubgoals.some((s) => s.id === depId)
      );

      const subgoal: Subgoal = {
        id: `subgoal-${ulid()}`,
        goalId,
        title: sg.title,
        assignedBrainId: sg.assignedBrainId,
        status: "proposed",
        dependsOn: validDepends,
      };

      goal.subgoals.push(subgoal);
      createdSubgoals.push(subgoal);
    }

    this.broadcastGoalUpdate(goal);

    return createdSubgoals;
  }

  updateSubgoalStatus(goalId: string, subgoalId: string, status: GoalStatus, result?: unknown): boolean {
    const goal = this.goals.get(goalId);
    if (!goal) return false;

    const subgoal = goal.subgoals.find((s) => s.id === subgoalId);
    if (!subgoal) return false;

    subgoal.status = status;
    if (result !== undefined) {
      subgoal.result = result;
    }

    this.recalculateGoalProgress(goalId);

    if (status === "completed") {
      this.handlers.onSubgoalCompleted?.(goalId, subgoalId);
    }

    this.broadcastGoalUpdate(goal);

    return true;
  }

  updateProgress(goalId: string, progress: number): void {
    const goal = this.goals.get(goalId);
    if (!goal) return;

    goal.progress = Math.max(0, Math.min(100, progress));

    if (goal.progress >= 100) {
      goal.status = "completed";
      goal.completedAt = new Date().toISOString();
      this.handlers.onGoalCompleted?.(goal);
    }

    this.handlers.onProgressUpdate?.(goalId, goal.progress);
    this.broadcastGoalUpdate(goal);
  }

  completeGoal(goalId: string): boolean {
    const goal = this.goals.get(goalId);
    if (!goal || goal.status === "completed" || goal.status === "abandoned") return false;

    goal.status = "completed";
    goal.progress = 100;
    goal.completedAt = new Date().toISOString();

    this.recalculateGoalProgress(goalId);
    this.handlers.onGoalCompleted?.(goal);
    this.broadcastGoalUpdate(goal);

    return true;
  }

  abandonGoal(goalId: string, reason: string = "Manual abandonment"): boolean {
    const goal = this.goals.get(goalId);
    if (!goal || goal.status === "completed" || goal.status === "abandoned") return false;

    goal.status = "abandoned";
    goal.completedAt = new Date().toISOString();

    this.handlers.onGoalAbandoned?.(goal, reason);
    this.broadcastGoalUpdate(goal);

    return true;
  }

  getGoal(goalId: string): CollectiveGoal | undefined {
    return this.goals.get(goalId);
  }

  getAllGoals(status?: GoalStatus): CollectiveGoal[] {
    let results = Array.from(this.goals.values());
    if (status) {
      results = results.filter((g) => g.status === status);
    }
    return results.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }

  getActiveGoals(): CollectiveGoal[] {
    return this.getAllGoals("in-progress");
  }

  getGoalsForBrain(brainId: string): CollectiveGoal[] {
    return Array.from(this.goals.values()).filter(
      (g) => g.assignedBrainIds.includes(brainId) || g.proposerId === brainId
    );
  }

  getSubgoalProgress(goalId: string, subgoalId: string): number | undefined {
    const goal = this.goals.get(goalId);
    if (!goal) return undefined;

    const subgoal = goal.subgoals.find((s) => s.id === subgoalId);
    if (!subgoal) return undefined;

    return subgoal.status === "completed" ? 100 :
           subgoal.status === "in-progress" ? 50 :
           subgoal.status === "proposed" ? 0 : 0;
  }

  getCreditAssignment(goalId: string): Record<string, number> {
    const goal = this.goals.get(goalId);
    if (!goal) return {};

    const participants = new Set<string>();
    participants.add(goal.proposerId);
    for (const sg of goal.subgoals) {
      if (sg.assignedBrainId) participants.add(sg.assignedBrainId);
    }

    const credits: Record<string, number> = {};
    const totalParticipants = participants.size;

    switch (this.config.creditAssignmentStrategy) {
      case "equal":
        for (const id of participants) {
          credits[id] = 100 / totalParticipants;
        }
        break;

      case "contribution":
        for (const sg of goal.subgoals) {
          if (sg.assignedBrainId && sg.status === "completed") {
            credits[sg.assignedBrainId] = (credits[sg.assignedBrainId] ?? 0) + 1;
          }
        }
        if (goal.proposerId in credits === false) {
          credits[goal.proposerId] = 0.5;
        }
        break;

      case "trust-weighted":
        for (const id of participants) {
          const trust = this.trustEvaluator(id);
          credits[id] = trust;
        }
        break;
    }

    const total = Object.values(credits).reduce((a, b) => a + b, 0);
    if (total > 0) {
      for (const id of Object.keys(credits)) {
        credits[id] = (credits[id] / total) * 100;
      }
    }

    return credits;
  }

  handleIncomingGoal(goal: CollectiveGoal): void {
    const existing = this.goals.get(goal.id);
    if (existing) {
      if (new Date(goal.completedAt ?? 0).getTime() > new Date(existing.completedAt ?? 0).getTime()) {
        this.goals.set(goal.id, goal);
      }
    } else {
      this.goals.set(goal.id, goal);
      this.goalAcceptances.set(goal.id, new Set());

      if (goal.status === "proposed") {
        this.handlers.onGoalProposed?.(goal);
      } else if (goal.status === "completed") {
        this.handlers.onGoalCompleted?.(goal);
      }
    }
  }

  handleIncomingSubgoalUpdate(goalId: string, subgoal: Subgoal): void {
    const goal = this.goals.get(goalId);
    if (!goal) return;

    const existingSubgoal = goal.subgoals.find((s) => s.id === subgoal.id);
    if (existingSubgoal) {
      Object.assign(existingSubgoal, subgoal);
    } else {
      goal.subgoals.push(subgoal);
    }

    this.recalculateGoalProgress(goalId);
  }

  private recalculateGoalProgress(goalId: string): void {
    const goal = this.goals.get(goalId);
    if (!goal) return;

    if (goal.subgoals.length === 0) return;

    let completedWeight = 0;
    let totalWeight = 0;

    for (const sg of goal.subgoals) {
      const weight = 1 / goal.subgoals.length;
      totalWeight += weight;

      if (sg.status === "completed") {
        completedWeight += weight;
      } else if (sg.status === "in-progress") {
        completedWeight += weight * 0.5;
      }
    }

    goal.progress = totalWeight > 0 ? (completedWeight / totalWeight) * 100 : 0;

    if (goal.progress >= 100) {
      goal.status = "completed";
      goal.completedAt = new Date().toISOString();
    } else if (goal.progress > 0) {
      goal.status = "in-progress";
    }
  }

  private calculateGoalDepth(goal: CollectiveGoal, depth = 0): number {
    if (goal.subgoals.length === 0) return depth;

    let maxChildDepth = depth;
    for (const sg of goal.subgoals) {
      const parentGoal = Array.from(this.goals.values()).find((g) => g.subgoals.some((s) => s.id === sg.id));
      if (parentGoal) {
        const childDepth = this.calculateGoalDepth(parentGoal, depth + 1);
        maxChildDepth = Math.max(maxChildDepth, childDepth);
      }
    }

    return maxChildDepth;
  }

  private checkProgress(): void {
    for (const goal of this.goals.values()) {
      if (goal.status !== "in-progress") continue;

      if (goal.progress > 0) {
        const progressRate = goal.progress / ((Date.now() - new Date(goal.createdAt).getTime()) / 3600000);
        if (progressRate < this.config.autoAbandonThreshold) {
          // Could auto-abandon but let's not do it automatically
        }
      }
    }
  }

  private checkDeadlines(): void {
    for (const goal of this.goals.values()) {
      if (goal.status !== "in-progress" || !goal.deadline) continue;

      const deadline = new Date(goal.deadline).getTime();
      const now = Date.now();

      if (deadline < now) {
        if (goal.progress < 80) {
          goal.deadline = new Date(deadline + this.config.deadlineExtensionMs).toISOString();
        }
      }
    }
  }

  private broadcastGoal(goal: CollectiveGoal): void {
    const message = {
      id: ulid(),
      type: "goal-propose" as const,
      sourceBrainId: this.myBrainId,
      payload: { goal },
      timestamp: new Date().toISOString(),
    };
    this.network.broadcast(message);
  }

  private broadcastGoalUpdate(goal: CollectiveGoal): void {
    const message = {
      id: ulid(),
      type: "goal-update" as const,
      sourceBrainId: this.myBrainId,
      payload: { goal },
      timestamp: new Date().toISOString(),
    };
    this.network.broadcast(message);
  }
}

let singleton: CollectiveGoalSystem | null = null;

export function createCollectiveGoals(
  network: BrainNetwork,
  config?: Partial<CollectiveGoalsConfig>,
  handlers?: GoalEventHandlers,
): CollectiveGoalSystem {
  if (!singleton) {
    singleton = new CollectiveGoalSystem(network, config, handlers);
  }
  return singleton;
}

export function getCollectiveGoals(): CollectiveGoalSystem | null {
  return singleton;
}