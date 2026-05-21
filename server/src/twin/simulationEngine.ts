// Digital Twin simulation core — PURE & deterministic, and crucially it
// NEVER EXECUTES ANYTHING. simulate() reasons about a proposed action against
// current twin state + history and returns a predicted-impact / risk report.
// That is what makes POST /api/twin/simulate inherently safe (read-only).

import type { TwinSnapshot, SimulationResult } from "../../../shared/twin.js";

export type ActionCategory =
  | "build"
  | "install"
  | "upgrade"
  | "clean"
  | "test"
  | "scan"
  | "delete"
  | "generic";

interface CategoryProfile {
  baseRuntimeMs: number;
  baseRisk: number; // 0-1 intrinsic risk before state/history adjustment
  cpuHeavy: boolean;
  diskHeavy: boolean;
  reversible: boolean;
}

const PROFILES: Record<ActionCategory, CategoryProfile> = {
  build: { baseRuntimeMs: 90_000, baseRisk: 0.2, cpuHeavy: true, diskHeavy: true, reversible: true },
  install: { baseRuntimeMs: 60_000, baseRisk: 0.35, cpuHeavy: false, diskHeavy: true, reversible: true },
  upgrade: { baseRuntimeMs: 120_000, baseRisk: 0.55, cpuHeavy: true, diskHeavy: true, reversible: false },
  clean: { baseRuntimeMs: 15_000, baseRisk: 0.25, cpuHeavy: false, diskHeavy: false, reversible: false },
  test: { baseRuntimeMs: 45_000, baseRisk: 0.1, cpuHeavy: true, diskHeavy: false, reversible: true },
  scan: { baseRuntimeMs: 30_000, baseRisk: 0.15, cpuHeavy: true, diskHeavy: false, reversible: true },
  delete: { baseRuntimeMs: 5_000, baseRisk: 0.8, cpuHeavy: false, diskHeavy: false, reversible: false },
  generic: { baseRuntimeMs: 20_000, baseRisk: 0.3, cpuHeavy: false, diskHeavy: false, reversible: true },
};

/** Keyword classification of a free-text action. Pure, order-sensitive. */
export function classifyAction(action: string): ActionCategory {
  const a = action.toLowerCase();
  if (/\b(rm|del|delete|drop|wipe|format|purge)\b/.test(a)) return "delete";
  if (/\b(upgrade|update|bump|migrate)\b/.test(a)) return "upgrade";
  if (/\b(install|add|npm i|pip install|cargo add)\b/.test(a)) return "install";
  if (/\b(clean|clear|prune|reset)\b/.test(a)) return "clean";
  if (/\b(build|compile|bundle|cargo build|tsc)\b/.test(a)) return "build";
  if (/\b(test|spec|verify|check|lint)\b/.test(a)) return "test";
  if (/\b(scan|index|crawl|walk)\b/.test(a)) return "scan";
  return "generic";
}

export interface SimHistory {
  pastRuns: number;
  pastFailures: number;
}

/**
 * Predict the impact of `action`. `recentSnapshots` newest-first; `history`
 * is prior run/failure counts for similar work. Deterministic; no side effects.
 */
export function simulate(
  action: string,
  recentSnapshots: TwinSnapshot[],
  history: SimHistory = { pastRuns: 0, pastFailures: 0 },
): SimulationResult {
  const category = classifyAction(action);
  const profile = PROFILES[category];
  const latest = recentSnapshots[0] ?? null;

  const health = latest ? latest.healthScore : 0.6;
  const cpuPct = latest ? latest.hardware.cpuPct : 50;
  const memRatio =
    latest && latest.hardware.memTotalBytes > 0
      ? latest.hardware.memUsedBytes / latest.hardware.memTotalBytes
      : 0.5;
  const diskRatio =
    latest && latest.hardware.diskTotalBytes && latest.hardware.diskUsedBytes !== null
      ? latest.hardware.diskUsedBytes / latest.hardware.diskTotalBytes
      : null;

  const failureRate =
    history.pastRuns > 0 ? history.pastFailures / history.pastRuns : 0;

  // Risk = intrinsic + low-headroom penalty + history penalty, clamped.
  let risk = profile.baseRisk;
  risk += (1 - health) * 0.3;
  risk += failureRate * 0.3;
  if (profile.cpuHeavy && cpuPct > 70) risk += 0.1;
  if (profile.diskHeavy && diskRatio !== null && diskRatio > 0.9) risk += 0.15;
  risk = Math.max(0, Math.min(1, Math.round(risk * 100) / 100));

  // Runtime scales up when the box is already busy.
  const loadMult = 1 + (profile.cpuHeavy ? cpuPct / 100 : 0);
  const estimatedRuntimeMs = Math.round(profile.baseRuntimeMs * loadMult);

  const conflicts: string[] = [];
  if (profile.cpuHeavy && cpuPct > 80) {
    conflicts.push(`CPU already at ${cpuPct}% — contention likely`);
  }
  if (memRatio > 0.85) {
    conflicts.push(`memory at ${(memRatio * 100).toFixed(0)}% — risk of pressure`);
  }
  if (profile.diskHeavy && diskRatio !== null && diskRatio > 0.9) {
    conflicts.push(`disk at ${(diskRatio * 100).toFixed(0)}% — may exhaust space`);
  }
  if (failureRate >= 0.3) {
    conflicts.push(
      `${history.pastFailures}/${history.pastRuns} similar past runs failed`,
    );
  }

  const rollbackRecommendation = profile.reversible
    ? `"${category}" is normally reversible — re-running usually recovers state.`
    : `"${category}" is NOT cleanly reversible — snapshot/commit before running and keep a backup.`;

  const predictedImpact =
    `${category} action: ~${(estimatedRuntimeMs / 1000).toFixed(0)}s, ` +
    `risk ${risk.toFixed(2)}, ` +
    (conflicts.length ? `${conflicts.length} potential conflict(s).` : "no resource conflicts foreseen.");

  return {
    action,
    predictedImpact,
    riskScore: risk,
    estimatedRuntimeMs,
    conflicts,
    rollbackRecommendation,
  };
}
