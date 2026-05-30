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
import { trainGru, gruPredictNext, gruForecast } from "../src/twin/gru.js";
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

// ---------------------------------------------------------------------------
// (6) GRU sequence predictor — FAIR head-to-head vs OLS on an oscillating
// series, plus determinism, gate routing, graceful fallback, and finiteness.
// The GRU path is `twin/gru.ts`; the gate is TWIN_USE_GRU=1 in predictiveModel.
// ---------------------------------------------------------------------------

// Oscillating ground truth: period 12, 48 points. Train on the first 36; hold
// out the last 12 as ground truth. OLS fits a near-flat line through the sine
// (its forecast error stays ~21+), so a GRU that learns the period wins.
const osc: number[] = [];
for (let i = 0; i < 48; i++) {
  osc.push(50 + 30 * Math.sin((i * 2 * Math.PI) / 12));
}
const oscTrain = osc.slice(0, 36); // oldest→newest, the training window
const oscTruth = osc.slice(36); // last 12 = held-out ground truth

// GRU: one model trained on the 36 training points, then teacher-forced
// one-step-ahead over the held-out region (predict osc[t] from ACTUAL
// osc[0..t-1]). This is the apples-to-apples comparison the brief mandates.
const gruModel = trainGru(oscTrain, { hiddenSize: 8, epochs: 400, lr: 0.01, seed: 1337 });
let gruSE = 0;
for (let t = 36; t < 48; t++) {
  const pred = gruPredictNext(gruModel, osc.slice(0, t)); // actual history
  gruSE += (pred - osc[t]) ** 2;
}
const gruRMSE = Math.sqrt(gruSE / oscTruth.length);

// OLS: the STRONGEST fair OLS — fit once on all 36 training points, extrapolate
// to the SAME held-out indices. Not crippled; this is OLS at its best here.
const olsPts = oscTrain.map((y, i) => ({ x: i, y }));
const olsFit = linearTrend(olsPts);
let olsSE = 0;
for (let t = 36; t < 48; t++) {
  const pred = olsFit.slope * t + olsFit.intercept;
  olsSE += (pred - osc[t]) ** 2;
}
const olsRMSE = Math.sqrt(olsSE / oscTruth.length);

checks.gruBeatsOls = gruRMSE < olsRMSE;
checks.gruRmseReasonable = gruRMSE < 10; // learned the dynamics, not flat

// Determinism: identical (series, cfg) ⇒ identical forecast.
const detA = gruForecast(osc, 5, { seed: 1337 });
const detB = gruForecast(osc, 5, { seed: 1337 });
checks.gruDeterministic = detA === detB;

// Finiteness/bounds of all GRU outputs touched so far.
checks.gruOutputsFinite =
  Number.isFinite(gruRMSE) &&
  Number.isFinite(olsRMSE) &&
  Number.isFinite(detA) &&
  Number.isFinite(gruPredictNext(gruModel, oscTrain));

// Gate routing through predictMetrics. Build a newest-first cpu snapshot series
// from the oscillating values (≥12 points so the GRU path is eligible).
const oscSnapsNewestFirst = series([...osc].reverse());

// Default path (env unset): predictMetrics output must equal the pre-GRU OLS
// output. Assert byte-equality against a direct linearTrend-derived expected.
const priorEnv = process.env.TWIN_USE_GRU;
delete process.env.TWIN_USE_GRU;
const olsPreds = predictMetrics(oscSnapsNewestFirst, 15);
const olsCpu = olsPreds.find((p) => p.metric === "cpuPct");
// Recompute the expected OLS cpu forecast exactly as predictiveModel.forecast
// does: x = minutes-before-newest (≤0), newest-first, +horizonMin=15.
const newestMs = new Date(oscSnapsNewestFirst[0].capturedAt).getTime();
const expectPts = oscSnapsNewestFirst.map((s) => ({
  x: (new Date(s.capturedAt).getTime() - newestMs) / 60000,
  y: s.hardware.cpuPct,
}));
const expectFit = linearTrend(expectPts);
let expectPredicted = expectFit.slope * 15 + expectFit.intercept;
expectPredicted = Math.max(0, Math.min(100, Math.round(expectPredicted * 100) / 100));
checks.gateDefaultIsOls =
  !!olsCpu && olsCpu.predicted === expectPredicted;

// Gated path (env "1", ≥12 points): the GRU path runs. Assert it produced a
// DIFFERENT forecast on the oscillating cpu metric than OLS (proves it ran).
process.env.TWIN_USE_GRU = "1";
const gruPreds = predictMetrics(oscSnapsNewestFirst, 15);
const gruCpu = gruPreds.find((p) => p.metric === "cpuPct");
checks.gatedPathRuns =
  !!gruCpu && !!olsCpu && gruCpu.predicted !== olsCpu.predicted &&
  / \[gru\]$/.test(gruCpu.reason);

// Graceful fallback: env "1" but only 3 points ⇒ still returns a forecast
// (falls back to OLS, no throw, finite).
const tinySnaps = series([30, 20, 10]); // 3 points, newest-first
const tinyPreds = predictMetrics(tinySnaps, 15);
const tinyCpu = tinyPreds.find((p) => p.metric === "cpuPct");
checks.gatedFallbackShortSeries =
  !!tinyCpu && Number.isFinite(tinyCpu.predicted);

// Restore the prior env so nothing leaks to later checks (there are none after
// this, but keep the contract clean).
if (priorEnv === undefined) delete process.env.TWIN_USE_GRU;
else process.env.TWIN_USE_GRU = priorEnv;

// Surface the head-to-head numbers the brief asks for.
console.log(
  `GRU vs OLS on oscillating series — gruRMSE=${gruRMSE.toFixed(3)} olsRMSE=${olsRMSE.toFixed(3)} (gru beats ols: ${gruRMSE < olsRMSE})`,
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
