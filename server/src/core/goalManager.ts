// Goal manager — activates the organism's dormant goal HIERARCHY.
//
// PersistentGoal has carried `subgoals[]` and `dependencies[]` since the
// organism shipped, but nothing ever read them: goals lived as a flat
// salience-ordered title list. This module makes them a TREE without touching
// the organism's storage model:
//
//   • children are encoded as goal-id links inside the parent's `subgoals[]`
//     (entries matching /^goal-/ are links; legacy free-text entries remain
//     annotations and are ignored);
//   • depth IS the level: root = long-term, 1 = mid-term, 2 = short-term,
//     3 = action (decomposition refuses to go deeper);
//   • `goal_history` is append-only and already persists subgoals_json, so
//     the tree needs NO migration — the manager reconstructs the forest from
//     the latest row per goal (the organism's own recentGoals idiom).
//
// What the hierarchy does:
//   decomposeGoal()       — one cheap LLM call proposes 2-4 child goals
//                           (ask-JSON-then-validate, the resolver convention);
//                           no connector degrades to {decomposed: 0, reason}.
//   rollUpProgress()      — a child update propagates up: parent progress =
//                           priority-weighted mean of children, recursive.
//   nextActionableLeaves()— the deepest unblocked leaves whose goal-id
//                           dependencies are completed; the workspace's goal
//                           bidder uses these instead of flat titles.
//   emergence             — `exploration-scheduled` (curiosity) and high-
//                           divergence `imagination-reflection` events become
//                           goals (rate-limited), so goals genuinely originate
//                           from curiosity and reflection, not only the user.
//
// Every public method is failure-isolated; a goal fault never breaks the
// organism, the workspace, or /api/ask. Tree math is exported pure for the
// hermetic selfcheck.

import { openDb } from "../db/sqlite.js";
import { surfaceError } from "../util/diagnostics.js";
import { getDefaultConnectorInstance } from "../connectors/registry.js";
import type { Connector } from "../connectors/Connector.js";
import type { PersistentGoal, PersistentGoalStatus } from "../../../shared/organism.js";
import { clampMagnitude, regionsFor } from "../../../shared/cognition.js";
import { getEventBus, nowIso, type BrainBus } from "./eventBus.js";
import type { PersistentOrganismEngine } from "./organism.js";
import { getPersistentOrganism } from "./organism.js";

export type GoalLevel = "long-term" | "mid-term" | "short-term" | "action";

export interface GoalNode {
  goal: PersistentGoal;
  depth: number;
  level: GoalLevel;
  children: GoalNode[];
}

export interface ActionableLeaf {
  goal: PersistentGoal;
  depth: number;
  /** Root priority + a depth bonus — deeper leaves are nearer to action. */
  salience: number;
}

export interface DecomposeReport {
  decomposed: number;
  childIds: string[];
  reason?: string;
}

// Decomposition bounds.
export const MAX_DEPTH = 3; // 0 long-term → 3 action; refuse below.
export const MIN_CHILDREN = 2;
export const MAX_CHILDREN = 4;
// Emergent-goal rate limits (per source).
export const EXPLORE_GOAL_MIN_GAP_MS = 60 * 60_000; // ≤1/hour
export const REFLECTION_GOAL_MIN_GAP_MS = 6 * 60 * 60_000; // ≤1/6h
export const REFLECTION_DIVERGENCE_FLOOR = 0.6; // 1-accuracy ≥ this → a goal
// Roll-up events fire when parent progress crosses one of these.
export const PROGRESS_NOTCHES = [0.25, 0.5, 0.75, 1] as const;
// Stage-metric counter (core/stages.ts reads it).
export const EXPLORATION_EVENTS_KEY = "exploration-events-count-v1";

const DECOMPOSE_SYSTEM = `You decompose a goal into concrete subgoals for a personal cognitive system. Given ONE goal, output ONLY a JSON object {"subgoals": ["...", "..."]} with 2-4 subgoals. Each subgoal is one imperative sentence (max 14 words), strictly narrower than the parent, and independently completable. No numbering, no meta-commentary.`;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// -----------------------------------------------------------------------------
// PURE tree math (selfcheck-exercisable).
// -----------------------------------------------------------------------------

/** Entries in subgoals[]/dependencies[] that are goal-id LINKS (not free text). */
export function goalLinks(entries: ReadonlyArray<string>): string[] {
  return entries.filter((e) => /^goal-/.test(e));
}

export function levelForDepth(depth: number): GoalLevel {
  if (depth <= 0) return "long-term";
  if (depth === 1) return "mid-term";
  if (depth === 2) return "short-term";
  return "action";
}

/** Reconstruct the forest from a flat goal list. Children missing from the
 *  list are skipped; a goal referenced as a child never doubles as a root. */
export function buildForest(goals: ReadonlyArray<PersistentGoal>): GoalNode[] {
  const byId = new Map(goals.map((g) => [g.id, g]));
  const childIds = new Set<string>();
  for (const g of goals) for (const c of goalLinks(g.subgoals)) childIds.add(c);

  const seen = new Set<string>();
  const build = (goal: PersistentGoal, depth: number): GoalNode => {
    seen.add(goal.id);
    const children: GoalNode[] = [];
    if (depth < 8) {
      // hard recursion guard against accidental cycles
      for (const cid of goalLinks(goal.subgoals)) {
        const child = byId.get(cid);
        if (child && !seen.has(cid)) children.push(build(child, depth + 1));
      }
    }
    return { goal, depth, level: levelForDepth(depth), children };
  };

  return goals.filter((g) => !childIds.has(g.id)).map((g) => build(g, 0));
}

export function forestDepth(forest: ReadonlyArray<GoalNode>): number {
  let max = 0;
  const walk = (node: GoalNode): void => {
    if (node.depth > max) max = node.depth;
    for (const c of node.children) walk(c);
  };
  for (const root of forest) walk(root);
  return max;
}

/** Parent progress = priority-weighted mean of children (completed = 1). */
export function rollUpNode(node: GoalNode): number {
  if (node.children.length === 0) {
    return node.goal.status === "completed" ? 1 : clamp01(node.goal.progress);
  }
  let weight = 0;
  let sum = 0;
  for (const child of node.children) {
    const w = Math.max(1, child.goal.priority);
    weight += w;
    sum += w * rollUpNode(child);
  }
  return weight > 0 ? clamp01(sum / weight) : clamp01(node.goal.progress);
}

/** Deepest unblocked leaves whose goal-id dependencies are all completed. */
export function actionableLeaves(
  forest: ReadonlyArray<GoalNode>,
  limit = 3,
): ActionableLeaf[] {
  const byId = new Map<string, PersistentGoal>();
  const collect = (node: GoalNode): void => {
    byId.set(node.goal.id, node.goal);
    for (const c of node.children) collect(c);
  };
  for (const root of forest) collect(root);

  const leaves: ActionableLeaf[] = [];
  const walk = (node: GoalNode, rootPriority: number): void => {
    if (node.children.length === 0) {
      const g = node.goal;
      if (g.status !== "active") return;
      const deps = goalLinks(g.dependencies);
      const blocked = deps.some((d) => {
        const dep = byId.get(d);
        return dep ? dep.status !== "completed" : false; // unknown dep ≠ blocker
      });
      if (blocked) return;
      leaves.push({
        goal: g,
        depth: node.depth,
        salience: clamp01(rootPriority / 100 + Math.min(0.15, node.depth * 0.05)),
      });
      return;
    }
    for (const c of node.children) walk(c, rootPriority);
  };
  for (const root of forest) walk(root, root.goal.priority);

  return leaves.sort((a, b) => b.salience - a.salience || a.goal.id.localeCompare(b.goal.id)).slice(0, limit);
}

/** Extract the subgoals array from the decomposer's (possibly messy) JSON. */
export function parseSubgoals(text: string): string[] {
  const pick = (v: unknown): string[] =>
    Array.isArray(v)
      ? v
          .filter((s): s is string => typeof s === "string" && s.trim().length > 3)
          .map((s) => s.trim())
          .slice(0, MAX_CHILDREN)
      : [];
  try {
    return pick((JSON.parse(text) as { subgoals?: unknown }).subgoals);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return pick((JSON.parse(match[0]) as { subgoals?: unknown }).subgoals);
      } catch {
        return [];
      }
    }
  }
  return [];
}

// -----------------------------------------------------------------------------
// Manager.
// -----------------------------------------------------------------------------

interface GoalRow {
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

function safeStringArray(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export interface GoalManagerOptions {
  /** Injectable for the hermetic selfcheck. */
  connector?: Connector | null;
  clock?: () => number;
}

export class GoalManager {
  private lastExploreGoalAt = 0;
  private lastReflectionGoalAt = 0;
  private readonly clock: () => number;
  private readonly unsubscribes: Array<() => void> = [];

  constructor(
    private readonly bus: BrainBus,
    private readonly organism: PersistentOrganismEngine,
    opts: GoalManagerOptions = {},
  ) {
    this.clock = opts.clock ?? (() => Date.now());

    // Goal EMERGENCE — curiosity and reflection grow the goal forest.
    this.unsubscribes.push(
      bus.on("exploration-scheduled", (e) => {
        this.onExploration(e.target, e.curiosity, e.reason);
      }),
    );
    this.unsubscribes.push(
      bus.on("imagination-reflection", (e) => {
        this.onReflection(e.reflection.accuracy, e.reflection.lesson, e.reflection.actualSummary);
      }),
    );
  }

  stop(): void {
    for (const u of this.unsubscribes.splice(0)) u();
  }

  private emitCognition(
    kind: "goal-formed" | "goal-progress",
    label: string,
    magnitude: number,
    reason: string,
    detail?: string,
  ): void {
    try {
      this.bus.emit({
        kind: "cognition",
        event: {
          kind,
          label: label.slice(0, 160),
          detail: detail?.slice(0, 240),
          magnitude: clampMagnitude(magnitude),
          logicalRegions: regionsFor(kind),
          reason,
          at: nowIso(),
        },
        at: nowIso(),
      });
    } catch (err) {
      surfaceError("goalManager.emit", err);
    }
  }

  /** Latest row per goal — the organism's recentGoals idiom, read directly. */
  private allGoals(limit = 120): PersistentGoal[] {
    try {
      const rows = openDb()
        .prepare<[number], GoalRow>(`SELECT * FROM goal_history ORDER BY updated_at DESC LIMIT ?`)
        .all(Math.max(1, Math.min(1200, limit * 8)));
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
          attempts: [],
          blockers: safeStringArray(row.blockers_json),
          confidence: row.confidence,
          estimatedCompletionAt: row.estimated_completion ?? undefined,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        });
        if (goals.length >= limit) break;
      }
      return goals;
    } catch (err) {
      surfaceError("goalManager.allGoals", err);
      return [];
    }
  }

  goalTree(): GoalNode[] {
    try {
      return buildForest(this.allGoals());
    } catch (err) {
      surfaceError("goalManager.tree", err);
      return [];
    }
  }

  goalTreeDepth(): number {
    try {
      return forestDepth(this.goalTree());
    } catch {
      return 0;
    }
  }

  private depthOf(goalId: string): number {
    const find = (nodes: ReadonlyArray<GoalNode>): number => {
      for (const n of nodes) {
        if (n.goal.id === goalId) return n.depth;
        const d = find(n.children);
        if (d >= 0) return d;
      }
      return -1;
    };
    return find(this.goalTree());
  }

  /**
   * LLM-decompose a goal into 2-4 child goals (one level deeper). Depth-capped
   * at the action level; no connector degrades with a reason; the model's JSON
   * is validated before anything persists (ask-JSON-then-validate).
   */
  async decomposeGoal(goalId: string, opts: GoalManagerOptions = {}): Promise<DecomposeReport> {
    try {
      const goal = this.allGoals().find((g) => g.id === goalId);
      if (!goal) return { decomposed: 0, childIds: [], reason: "goal not found" };
      const depth = Math.max(0, this.depthOf(goalId));
      if (depth >= MAX_DEPTH) {
        return { decomposed: 0, childIds: [], reason: "already at action level" };
      }
      if (goalLinks(goal.subgoals).length > 0) {
        return { decomposed: 0, childIds: [], reason: "already decomposed" };
      }
      const connector =
        opts.connector !== undefined ? opts.connector : getDefaultConnectorInstance();
      if (!connector) return { decomposed: 0, childIds: [], reason: "no connector" };

      const raw = await connector.send(
        `Goal: ${goal.title}\nLevel: ${levelForDepth(depth)} → propose ${levelForDepth(depth + 1)} subgoals.`,
        { system: DECOMPOSE_SYSTEM, format: "json", temperature: 0.3 },
      );
      const titles = parseSubgoals(raw);
      if (titles.length < MIN_CHILDREN) {
        return { decomposed: 0, childIds: [], reason: "model returned too few subgoals" };
      }

      const childIds: string[] = [];
      for (const title of titles) {
        const child = this.organism.createGoal({
          title,
          priority: Math.max(10, goal.priority - 10),
          confidence: goal.confidence,
        }).goal;
        childIds.push(child.id);
      }
      // Link the children into the parent (free-text annotations preserved).
      this.organism.updateGoal({ goalId, subgoals: [...goal.subgoals, ...childIds] });
      this.emitCognition(
        "goal-formed",
        `Decomposed goal "${goal.title}" into ${childIds.length} ${levelForDepth(depth + 1)} subgoals`,
        0.8,
        "goal-manager:decompose",
        titles.join(" · "),
      );
      return { decomposed: childIds.length, childIds };
    } catch (err) {
      surfaceError("goalManager.decompose", err);
      return { decomposed: 0, childIds: [], reason: "decomposition failed" };
    }
  }

  /**
   * Propagate a child's progress up its ancestor chain. Each ancestor's
   * progress becomes the priority-weighted mean of its children; crossing a
   * quarter notch emits a `goal-progress` cognition event.
   */
  rollUpProgress(goalId: string): number {
    try {
      const forest = this.goalTree();
      // Path from root to the node (so we can update ancestors bottom-up).
      const path: GoalNode[] = [];
      const find = (node: GoalNode, trail: GoalNode[]): boolean => {
        const next = [...trail, node];
        if (node.goal.id === goalId) {
          path.push(...next);
          return true;
        }
        return node.children.some((c) => find(c, next));
      };
      forest.some((root) => find(root, []));
      if (path.length <= 1) return -1; // root or not found — nothing to roll up

      let last = -1;
      for (let i = path.length - 2; i >= 0; i -= 1) {
        const ancestor = path[i];
        const before = ancestor.goal.progress;
        const after = rollUpNode(ancestor);
        if (Math.abs(after - before) < 1e-6) {
          last = after;
          continue;
        }
        this.organism.updateGoal({
          goalId: ancestor.goal.id,
          progress: after,
          status: after >= 1 ? "completed" : undefined,
        });
        // Refresh the node's local copy so higher ancestors see the new value.
        ancestor.goal.progress = after;
        const crossed = PROGRESS_NOTCHES.find((n) => before < n && after >= n);
        if (crossed !== undefined) {
          this.emitCognition(
            "goal-progress",
            `Goal "${ancestor.goal.title}" reached ${Math.round(after * 100)}%`,
            after,
            "goal-manager:roll-up",
          );
        }
        last = after;
      }
      return last;
    } catch (err) {
      surfaceError("goalManager.rollUp", err);
      return -1;
    }
  }

  nextActionableLeaves(limit = 3): ActionableLeaf[] {
    try {
      return actionableLeaves(this.goalTree(), limit);
    } catch (err) {
      surfaceError("goalManager.leaves", err);
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Emergence.
  // ---------------------------------------------------------------------------

  private bumpExplorationCounter(): void {
    try {
      openDb()
        .prepare(
          `INSERT INTO brain_metadata (key, value) VALUES (?, '1')
           ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
        )
        .run(EXPLORATION_EVENTS_KEY);
    } catch (err) {
      surfaceError("goalManager.explorationCounter", err);
    }
  }

  /** Curiosity → a short-term "Explore: …" goal, ≤1/hour. */
  onExploration(target: string, curiosity: number, reason: string): PersistentGoal | null {
    try {
      this.bumpExplorationCounter();
      const now = this.clock();
      if (now - this.lastExploreGoalAt < EXPLORE_GOAL_MIN_GAP_MS) return null;
      const title = `Explore: ${target}`.slice(0, 120);
      // Don't re-create an identical standing exploration goal.
      if (this.allGoals().some((g) => g.title === title && g.status === "active")) return null;
      this.lastExploreGoalAt = now;
      const goal = this.organism.createGoal({
        title,
        priority: 45,
        confidence: clamp01(curiosity),
      }).goal;
      this.emitCognition(
        "goal-formed",
        `Curiosity grew a goal: ${title}`,
        clamp01(curiosity),
        `goal-manager:curiosity (${reason})`,
      );
      return goal;
    } catch (err) {
      surfaceError("goalManager.onExploration", err);
      return null;
    }
  }

  /** High-divergence reflection → a mid-term "understand why" goal, ≤1/6h. */
  onReflection(accuracy: number, lesson: string, actualSummary: string): PersistentGoal | null {
    try {
      const divergence = clamp01(1 - accuracy);
      if (divergence < REFLECTION_DIVERGENCE_FLOOR) return null;
      const now = this.clock();
      if (now - this.lastReflectionGoalAt < REFLECTION_GOAL_MIN_GAP_MS) return null;
      this.lastReflectionGoalAt = now;
      const what = (lesson || actualSummary || "a diverging prediction").slice(0, 90);
      const goal = this.organism.createGoal({
        title: `Understand why prediction diverged: ${what}`.slice(0, 120),
        priority: 55,
        confidence: 0.4,
      }).goal;
      this.emitCognition(
        "goal-formed",
        `Reflection grew a goal: understand ${what}`,
        divergence,
        "goal-manager:reflection",
      );
      return goal;
    } catch (err) {
      surfaceError("goalManager.onReflection", err);
      return null;
    }
  }
}

let singleton: GoalManager | null = null;

export function createGoalManager(
  bus: BrainBus,
  organism: PersistentOrganismEngine,
  opts: GoalManagerOptions = {},
): GoalManager {
  if (singleton) singleton.stop();
  singleton = new GoalManager(bus, organism, opts);
  return singleton;
}

/** Lazy accessor — creates against the process bus + organism singleton. */
export function getGoalManager(): GoalManager {
  if (!singleton) {
    singleton = new GoalManager(getEventBus(), getPersistentOrganism());
  }
  return singleton;
}

export function __resetGoalManagerForTests(): void {
  if (singleton) singleton.stop();
  singleton = null;
}
