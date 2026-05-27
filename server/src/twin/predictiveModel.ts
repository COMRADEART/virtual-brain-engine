// Digital Twin predictive core — PURE & deterministic. No DB, no `os`, no
// native deps: it takes an array of already-captured snapshots and returns
// forecasts. This is what lets twin-selfcheck.ts exercise it offline with
// synthetic data.
//
// "Memory is the past, world state is the present, the Digital Twin is
// predicted reality." This module is the "predicted" part for resource trends
// and workflow failure likelihood.
//
// DEFERRED (blueprint §3 #6 / improvement plan Phase 2): a small GRU sequence
// model would beat OLS on non-stationary patterns (oscillating loads, periodic
// spikes). Blueprint flags this as a *minor* gap because the current OLS
// fit is good for the dominant use case — 5–15 min horizons on slowly-moving
// system metrics. The seam to add it later is `predictMetrics()` below: branch
// on `process.env.TWIN_USE_GRU === "1"` to a `gruForecast()` path, keep the
// OLS path as fallback. Training infrastructure (BPTT + Adam) would be a
// separate `twin/gru.ts` module. Skipped this session to invest in higher-
// leverage gaps (Phase 3 perception streaming, Phase 4 renderer 20k unlock).

import type { TwinSnapshot, TwinPrediction } from "../../../shared/twin.js";

export interface LinearFit {
  slope: number;
  intercept: number;
  r2: number;
}

/** Ordinary least-squares fit of y = slope·x + intercept, plus R². Pure. */
export function linearTrend(points: Array<{ x: number; y: number }>): LinearFit {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: n === 1 ? points[0].y : 0, r2: 0 };
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
    sxx += p.x * p.x;
    sxy += p.x * p.y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { slope: 0, intercept: sy / n, r2: 0 };
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const meanY = sy / n;
  let ssTot = 0;
  let ssRes = 0;
  for (const p of points) {
    const pred = slope * p.x + intercept;
    ssTot += (p.y - meanY) ** 2;
    ssRes += (p.y - pred) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot);
  return { slope, intercept, r2 };
}

// `snapshots` is newest-first (matches getRecentSnapshots). We map each to
// minutes-before-now so the slope is per-minute and the forecast is the value
// at +horizonMin.
function forecast(
  snapshots: TwinSnapshot[],
  pick: (s: TwinSnapshot) => number | null,
  metric: TwinPrediction["metric"],
  horizonMin: number,
): TwinPrediction | null {
  const newestMs = new Date(snapshots[0].capturedAt).getTime();
  const points: Array<{ x: number; y: number }> = [];
  for (const s of snapshots) {
    const y = pick(s);
    if (y === null || !Number.isFinite(y)) continue;
    const x = (new Date(s.capturedAt).getTime() - newestMs) / 60000; // ≤ 0
    points.push({ x, y });
  }
  if (points.length < 3) return null;
  const fit = linearTrend(points);
  const predicted = fit.slope * horizonMin + fit.intercept;
  // Confidence: trend strength (R²) damped by sample size. A flat-but-clean
  // series is still a confident "no change" forecast.
  const sizeFactor = Math.min(1, points.length / 10);
  const confidence = Math.max(
    0.05,
    Math.min(0.95, (0.3 + 0.7 * fit.r2) * sizeFactor),
  );
  const dir = fit.slope > 0 ? "rising" : fit.slope < 0 ? "falling" : "flat";
  return {
    metric,
    horizonMin,
    predicted: Math.round(predicted * 100) / 100,
    confidence: Math.round(confidence * 100) / 100,
    reason: `${dir} trend over ${points.length} snapshots (R²=${fit.r2.toFixed(2)})`,
  };
}

/**
 * Forecast resource metrics + workflow-failure likelihood `horizonMin`
 * minutes out. `snapshots` newest-first. Returns only the forecasts it can
 * support (≥3 usable points); never throws.
 */
export function predictMetrics(
  snapshots: TwinSnapshot[],
  horizonMin = 15,
): TwinPrediction[] {
  if (snapshots.length === 0) return [];
  const out: TwinPrediction[] = [];

  const cpu = forecast(snapshots, (s) => s.hardware.cpuPct, "cpuPct", horizonMin);
  if (cpu) {
    cpu.predicted = Math.max(0, Math.min(100, cpu.predicted));
    out.push(cpu);
  }
  const mem = forecast(
    snapshots,
    (s) => s.hardware.memUsedBytes,
    "memUsedBytes",
    horizonMin,
  );
  if (mem) {
    mem.predicted = Math.max(0, mem.predicted);
    out.push(mem);
  }
  const disk = forecast(
    snapshots,
    (s) => s.hardware.diskUsedBytes,
    "diskUsedBytes",
    horizonMin,
  );
  if (disk) {
    disk.predicted = Math.max(0, disk.predicted);
    out.push(disk);
  }

  // Workflow-failure likelihood from the newest snapshot's recent runs.
  const runs = snapshots[0].workflow.recentRuns;
  if (runs.length > 0) {
    const failed = runs.filter(
      (r) => r.status === "error" || r.status === "failed",
    ).length;
    const ratio = failed / runs.length;
    out.push({
      metric: "workflow-failure",
      horizonMin,
      predicted: Math.round(ratio * 100) / 100,
      confidence: Math.min(0.9, 0.4 + runs.length * 0.1),
      reason: `${failed}/${runs.length} recent runs failed`,
    });
  }

  return out;
}
