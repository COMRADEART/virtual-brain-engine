import { createHash } from "node:crypto";
import { ulid } from "ulid";
import { nowIso } from "./eventBus.js";
import type {
  CognitiveEnergy,
  CognitiveHealth,
  GoalAttempt,
  OrganismLifecycleState,
  OrganismState,
} from "../../../shared/organism.js";

export interface HealthRow {
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

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function safeStringArray(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function safeRecord(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

export function energyAt(now: string, previous?: CognitiveEnergy): CognitiveEnergy {
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

export function stateFromRecord(value: Record<string, unknown>): OrganismState | null {
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

export function defaultState(): OrganismState {
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

export function parseHealth(row: HealthRow | undefined): CognitiveHealth {
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

export function parseAttempts(json: string): GoalAttempt[] {
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

export function classifyWorkflow(prompt: string): string {
  const lower = prompt.toLowerCase();
  if (lower.includes("rust") || lower.includes("cargo")) return "Rust workspace repair";
  if (lower.includes("memory") || lower.includes("embedding")) return "Memory architecture";
  if (lower.includes("swarm") || lower.includes("distributed")) return "Distributed cognition";
  if (lower.includes("simulate") || lower.includes("prediction")) return "Simulation-first planning";
  if (lower.includes("evolution") || lower.includes("mutation")) return "Cognitive evolution";
  if (lower.includes("organism") || lower.includes("persistent")) return "Persistent organism continuity";
  return "general cognition";
}
