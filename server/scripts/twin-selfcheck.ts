// Offline, deterministic sanity check for the Digital Twin reasoning cores.
// No DB / network / native deps — imports ONLY the pure modules (cpuMath,
// predictiveModel, anomalyDetector, simulationEngine), exactly like
// ranker:selfcheck / agents:selfcheck. Run:
//   npm --prefix server run twin:selfcheck
//
// Asserts:
//   (1) computeCpuPct: cumulative (prev=null) vs instantaneous (delta) math,
//   (2) linearTrend recovers a known line (slope/intercept/R²),
//   (3) predictMetrics extrapolates a rising series upward with confidence∈(0,1],
//   (4) simulate orders risk (delete > test) and runtime is positive,
//   (5) anomalyDetector fires cpu-spike on a z-outlier and an automation-loop,
//       and does NOT fire on an in-band value (no false positive).

import { computeCpuPct, type CpuSample } from "../src/twin/cpuMath.js";
import { predictMetrics, linearTrend } from "../src/twin/predictiveModel.js";
import { detectAnomalies } from "../src/twin/anomalyDetector.js";
import { simulate, classifyAction } from "../src/twin/simulationEngine.js";
import type { TwinSnapshot } from "../../shared/twin.js";

function snap(over: {
  ts: string;
  cpuPct: number;
  memUsedBytes?: number;
  recentActions?: TwinSnapshot["workflow"]["recentActions"];
}): TwinSnapshot {
  return {
    id: over.ts,
    capturedAt: over.ts,
    healthScore: 0.7,
    hardware: {
      cpuPct: over.cpuPct,
      cores: 8,
      cpuModel: "synthetic",
      loadAvg1: null,
      memUsedBytes: over.memUsedBytes ?? 8_000_000_000,
      memTotalBytes: 16_000_000_000,
      diskUsedBytes: null,
      diskTotalBytes: null,
      uptimeSec: 1000,
      procRssBytes: 100_000_000,
      gpuTempC: null,
      cpuTempC: null,
      batteryPct: null,
    },
    software: {
      nodeVersion: "v0",
      platform: "test",
      arch: "x64",
      osRelease: "0",
      connectors: [],
      agents: [],
    },
    workflow: {
      activeRuns: 0,
      recentRuns: [],
      recentActions: over.recentActions ?? [],
      recurringPatterns: 0,
    },
    cognitive: {
      activeConversationId: null,
      lastMessageAt: null,
      recentMemoryAccess: 0,
      agentActivity: [],
      focus: 0,
    },
    project: { projects: [] },
  };
}

// Newest-first series, 1 minute apart, cpu rising toward "now".
function series(cpus: number[]): TwinSnapshot[] {
  const base = Date.UTC(2026, 0, 1, 12, 0, 0);
  return cpus.map((c, i) => snap({ ts: new Date(base - i * 60_000).toISOString(), cpuPct: c }));
}

const checks: Record<string, boolean> = {};

// (1) computeCpuPct
const prev: CpuSample[] = [{ user: 100, nice: 0, sys: 0, idle: 900, irq: 0 }];
const curr: CpuSample[] = [{ user: 200, nice: 0, sys: 0, idle: 1300, irq: 0 }];
const cumulative = computeCpuPct(null, prev); // 100 / 1000 = 10%
const instantaneous = computeCpuPct(prev, curr); // d busy 100 / d total 500 = 20%
checks.cpuCumulative = Math.abs(cumulative - 10) < 1e-6;
checks.cpuInstantaneous = Math.abs(instantaneous - 20) < 1e-6;

// (2) linearTrend recovers y = 2x + 1
const fit = linearTrend([
  { x: 0, y: 1 },
  { x: 1, y: 3 },
  { x: 2, y: 5 },
  { x: 3, y: 7 },
]);
checks.trendSlope = Math.abs(fit.slope - 2) < 1e-9;
checks.trendIntercept = Math.abs(fit.intercept - 1) < 1e-9;
checks.trendR2 = Math.abs(fit.r2 - 1) < 1e-9;

// (3) predictMetrics extrapolates a clean rising series upward.
const rising = series([60, 50, 40, 30, 20, 10]); // newest 60, oldest 10
const preds = predictMetrics(rising, 15);
const cpuPred = preds.find((p) => p.metric === "cpuPct");
checks.predictionExists = !!cpuPred;
checks.predictionRises = !!cpuPred && cpuPred.predicted > 60;
checks.predictionConfidence =
  !!cpuPred && cpuPred.confidence > 0 && cpuPred.confidence <= 1;

// (4) simulate risk ordering + classification.
const recent = series([30, 30, 30]);
const del = simulate("rm -rf build", recent, { pastRuns: 0, pastFailures: 0 });
const tst = simulate("npm test", recent, { pastRuns: 0, pastFailures: 0 });
checks.classifyDelete = classifyAction("rm -rf build") === "delete";
checks.classifyBuild = classifyAction("cargo build --release") === "build";
checks.riskOrdering = del.riskScore > tst.riskScore;
checks.runtimePositive = del.estimatedRuntimeMs > 0 && tst.estimatedRuntimeMs > 0;
checks.deleteNotReversible = /NOT cleanly reversible/.test(del.rollbackRecommendation);

// (5) anomaly z-score + loop guard, with a no-false-positive control.
const baselineCpus = [18, 20, 22, 19, 21, 20, 20]; // mean ~20, sd ~1.3
const spike = [95, ...baselineCpus];
const calm = [21, ...baselineCpus];
const spikeAnoms = detectAnomalies(series(spike));
const calmAnoms = detectAnomalies(series(calm));
checks.cpuSpikeFires = spikeAnoms.some((a) => a.kind === "cpu-spike");
checks.cpuSpikeNoFalsePositive = !calmAnoms.some((a) => a.kind === "cpu-spike");

// mem-pressure: newest at 95% of total (>0.92 critical path) vs ~50% baseline.
const memSeries = series(baselineCpus.concat([20])); // 8 snapshots, calm cpu
memSeries[0] = snap({
  ts: memSeries[0].capturedAt,
  cpuPct: 20,
  memUsedBytes: 15_200_000_000, // 15.2 / 16 GB ≈ 95%
});
checks.memPressureFires = detectAnomalies(memSeries).some(
  (a) => a.kind === "mem-pressure",
);

const loopActions = Array.from({ length: 6 }, () => ({
  agent: "runaway",
  action: "do-thing",
  at: "2026-01-01T12:00:00.000Z",
}));
const loopSeries = series(baselineCpus.concat([20]));
loopSeries[0] = snap({
  ts: loopSeries[0].capturedAt,
  cpuPct: 20,
  recentActions: loopActions,
});
checks.automationLoopFires = detectAnomalies(loopSeries).some(
  (a) => a.kind === "automation-loop",
);

const failed = Object.entries(checks)
  .filter(([, v]) => !v)
  .map(([k]) => k);
const ok = failed.length === 0;

console.log(
  JSON.stringify(
    { checks, failed, result: ok ? "PASS" : "FAIL" },
    null,
    2,
  ),
);
process.exit(ok ? 0 : 1);
