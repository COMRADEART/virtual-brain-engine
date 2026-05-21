// Digital Twin anomaly core — PURE & deterministic. Takes newest-first
// snapshots, returns anomaly *drafts* (no id / detectedAt — the caller stamps
// and persists those). Keeping persistence out keeps this module importable by
// twin-selfcheck.ts with zero DB/native deps.

import type { TwinSnapshot, TwinAnomaly } from "../../../shared/twin.js";

export type AnomalyDraft = Omit<TwinAnomaly, "id" | "detectedAt">;

// z-score threshold. 2.5σ ≈ flag the clearly-out-of-band, not normal jitter.
const Z_THRESHOLD = 2.5;
// Minimum baseline window before z-scoring is meaningful.
const MIN_BASELINE = 5;
// An agent+action repeated at least this many times in the recent-action
// window is treated as a possible runaway automation loop.
const LOOP_THRESHOLD = 5;

export function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

/** Signed z-score of `value` against a baseline sample. Pure. */
export function zScore(value: number, baseline: number[]): number {
  const sd = stddev(baseline);
  if (sd === 0) return 0;
  return (value - mean(baseline)) / sd;
}

function severityFor(z: number): TwinAnomaly["severity"] {
  const a = Math.abs(z);
  if (a >= 4) return "critical";
  if (a >= 3) return "warn";
  return "info";
}

/**
 * Detect anomalies in the newest snapshot relative to the prior window.
 * `snapshots` newest-first. Returns [] (not throws) when there is too little
 * history to baseline.
 */
export function detectAnomalies(snapshots: TwinSnapshot[]): AnomalyDraft[] {
  if (snapshots.length < MIN_BASELINE + 1) {
    // Still guard against runaway loops, which need no statistical baseline.
    return snapshots.length > 0 ? loopGuard(snapshots[0]) : [];
  }
  const newest = snapshots[0];
  const baseline = snapshots.slice(1); // exclude the point under test
  const out: AnomalyDraft[] = [];

  // CPU spike.
  const cpuBase = baseline.map((s) => s.hardware.cpuPct);
  const cpuZ = zScore(newest.hardware.cpuPct, cpuBase);
  if (cpuZ > Z_THRESHOLD) {
    out.push({
      kind: "cpu-spike",
      severity: severityFor(cpuZ),
      metric: "cpuPct",
      value: newest.hardware.cpuPct,
      baseline: Math.round(mean(cpuBase) * 10) / 10,
      detail: `CPU ${newest.hardware.cpuPct}% is ${cpuZ.toFixed(1)}σ above the ${cpuBase.length}-sample mean`,
    });
  }

  // Memory pressure (ratio).
  const memRatio = (s: TwinSnapshot): number =>
    s.hardware.memTotalBytes > 0
      ? s.hardware.memUsedBytes / s.hardware.memTotalBytes
      : 0;
  const memBase = baseline.map(memRatio);
  const memNow = memRatio(newest);
  const memZ = zScore(memNow, memBase);
  if (memZ > Z_THRESHOLD || memNow > 0.92) {
    out.push({
      kind: "mem-pressure",
      severity: memNow > 0.92 ? "critical" : severityFor(memZ),
      metric: "memUsedRatio",
      value: Math.round(memNow * 1000) / 1000,
      baseline: Math.round(mean(memBase) * 1000) / 1000,
      detail: `memory at ${(memNow * 100).toFixed(0)}% (${memZ.toFixed(1)}σ vs baseline)`,
    });
  }

  // Disk pressure (only when statfs supplied real numbers).
  const diskRatio = (s: TwinSnapshot): number | null =>
    s.hardware.diskTotalBytes && s.hardware.diskUsedBytes !== null
      ? s.hardware.diskUsedBytes / s.hardware.diskTotalBytes
      : null;
  const diskNow = diskRatio(newest);
  if (diskNow !== null) {
    const diskBase = baseline
      .map(diskRatio)
      .filter((v): v is number => v !== null);
    if (diskBase.length >= MIN_BASELINE) {
      const diskZ = zScore(diskNow, diskBase);
      if (diskZ > Z_THRESHOLD || diskNow > 0.95) {
        out.push({
          kind: "disk-pressure",
          severity: diskNow > 0.95 ? "critical" : severityFor(diskZ),
          metric: "diskUsedRatio",
          value: Math.round(diskNow * 1000) / 1000,
          baseline: Math.round(mean(diskBase) * 1000) / 1000,
          detail: `disk at ${(diskNow * 100).toFixed(0)}% (${diskZ.toFixed(1)}σ vs baseline)`,
        });
      }
    }
  }

  // Workflow-failure spike: newest failure ratio vs baseline failure ratios.
  const failRatio = (s: TwinSnapshot): number => {
    const r = s.workflow.recentRuns;
    if (r.length === 0) return 0;
    return (
      r.filter((x) => x.status === "error" || x.status === "failed").length /
      r.length
    );
  };
  const failBase = baseline.map(failRatio);
  const failNow = failRatio(newest);
  const failZ = zScore(failNow, failBase);
  if (failNow > 0 && (failZ > Z_THRESHOLD || failNow >= 0.5)) {
    out.push({
      kind: "workflow-failure-spike",
      severity: failNow >= 0.5 ? "warn" : "info",
      metric: "workflowFailureRatio",
      value: Math.round(failNow * 100) / 100,
      baseline: Math.round(mean(failBase) * 100) / 100,
      detail: `${(failNow * 100).toFixed(0)}% of recent runs failed`,
    });
  }

  out.push(...loopGuard(newest));
  return out;
}

/** Runaway-automation guard — needs no statistical baseline. Pure. */
function loopGuard(newest: TwinSnapshot): AnomalyDraft[] {
  const counts = new Map<string, number>();
  for (const a of newest.workflow.recentActions) {
    const key = `${a.agent}::${a.action}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out: AnomalyDraft[] = [];
  for (const [key, n] of counts) {
    if (n >= LOOP_THRESHOLD) {
      out.push({
        kind: "automation-loop",
        severity: n >= LOOP_THRESHOLD * 2 ? "critical" : "warn",
        metric: "repeatedAction",
        value: n,
        baseline: LOOP_THRESHOLD,
        detail: `"${key}" ran ${n}× in the recent-action window`,
      });
    }
  }
  return out;
}
