// Digital Twin snapshot engine — assembles one TwinSnapshot from the
// collectors, scores its health, persists it, prunes old rows, and emits a
// `twin-snapshot` event on the internal bus (bridged to /ws/brain by
// brainCore.ts).
//
// Cadence is NOT owned here. The SystemSensorAgent's think()/act() decides
// when to call captureSnapshot() — that routes the capture through the safety
// gate + agent_audit and matches the established agentic pattern. (Contrast
// scheduleDecayTick, which predates the agent layer; new code does not copy
// it.)

import { ulid } from "ulid";
import { getEventBus } from "../core/eventBus.js";
import type {
  TwinSnapshot,
  HardwareState,
  TwinAnomaly,
} from "../../../shared/twin.js";
import {
  type CpuSample,
  collectHardware,
  collectSoftware,
  collectWorkflow,
  collectCognitive,
  collectProject,
} from "./collectors.js";
import {
  insertSnapshot,
  pruneSnapshots,
  getRecentSnapshots,
  insertAnomaly,
  insertPrediction,
} from "./repository.js";
import { detectAnomalies } from "./anomalyDetector.js";
import { predictMetrics } from "./predictiveModel.js";

// How much history the reasoning cores look back over per analysis pass.
const ANALYSIS_WINDOW = 60;

let prevCpu: CpuSample[] | null = null;

/**
 * Composite 0-1 health from resource headroom. Pure. When disk is unknown
 * (statfs unsupported) it contributes a neutral 0.85 rather than dragging the
 * score with a fake 0.
 */
export function computeHealthScore(hw: HardwareState): number {
  const cpuHeadroom = 1 - hw.cpuPct / 100;
  const memHeadroom =
    hw.memTotalBytes > 0 ? 1 - hw.memUsedBytes / hw.memTotalBytes : 0.85;
  const diskHeadroom =
    hw.diskTotalBytes && hw.diskUsedBytes !== null && hw.diskTotalBytes > 0
      ? 1 - hw.diskUsedBytes / hw.diskTotalBytes
      : 0.85;
  const score = 0.4 * cpuHeadroom + 0.4 * memHeadroom + 0.2 * diskHeadroom;
  return Math.max(0, Math.min(1, Math.round(score * 1000) / 1000));
}

/**
 * Capture + persist + emit one snapshot. Returns it so the caller (the sensor
 * agent) can feed it to the anomaly detector without a second read.
 */
export function captureSnapshot(): TwinSnapshot {
  const { hardware, cpuSample } = collectHardware(prevCpu);
  prevCpu = cpuSample;

  const snapshot: TwinSnapshot = {
    id: ulid(),
    capturedAt: new Date().toISOString(),
    healthScore: computeHealthScore(hardware),
    hardware,
    software: collectSoftware(),
    workflow: collectWorkflow(),
    cognitive: collectCognitive(),
    project: collectProject(),
  };

  insertSnapshot(snapshot);
  pruneSnapshots();

  getEventBus().emit({
    kind: "twin-snapshot",
    snapshot,
    at: snapshot.capturedAt,
  });

  return snapshot;
}

/**
 * Run the pure reasoning cores over recent history (incl. the just-captured
 * snapshot), persist + emit any anomalies, and log forecasts. Anomaly drafts
 * are stamped with id + detectedAt here — the detector itself stays pure.
 * Never throws; the sensor agent loop must not be wedged by an analysis fault.
 */
export function analyzeAndPersist(snapshot: TwinSnapshot): TwinAnomaly[] {
  const stamped: TwinAnomaly[] = [];
  try {
    const recent = getRecentSnapshots(ANALYSIS_WINDOW);
    const bus = getEventBus();

    for (const draft of detectAnomalies(recent)) {
      const anomaly: TwinAnomaly = {
        ...draft,
        id: ulid(),
        detectedAt: new Date().toISOString(),
      };
      insertAnomaly(anomaly, snapshot.id);
      bus.emit({ kind: "twin-anomaly", anomaly, at: anomaly.detectedAt });
      stamped.push(anomaly);
    }

    for (const prediction of predictMetrics(recent)) {
      insertPrediction(prediction);
    }
  } catch (err) {
    console.warn("[twin] analyzeAndPersist failed:", err);
  }
  return stamped;
}
