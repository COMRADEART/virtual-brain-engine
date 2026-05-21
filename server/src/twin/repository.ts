// Digital Twin persistence — the only module that touches the 4 twin tables.
// Whole-snapshot reads/writes only (the per-layer split was collapsed into
// `layers_json` by design — DIGITAL_TWIN_SPEC.md §4.2). Never throws; callers
// (the sensor agent loop) must not be wedged by a transient DB error.

import { ulid } from "ulid";
import { openDb } from "../db/sqlite.js";
import type {
  TwinSnapshot,
  TwinAnomaly,
  TwinPrediction,
  SimulationResult,
} from "../../../shared/twin.js";

const SNAPSHOT_RETENTION = 500;

type LayersBlob = Pick<
  TwinSnapshot,
  "hardware" | "software" | "workflow" | "cognitive" | "project"
>;

export function insertSnapshot(s: TwinSnapshot): void {
  try {
    const db = openDb();
    const layers: LayersBlob = {
      hardware: s.hardware,
      software: s.software,
      workflow: s.workflow,
      cognitive: s.cognitive,
      project: s.project,
    };
    db.prepare(
      `INSERT INTO system_snapshots (id, captured_at, health_score, layers_json)
       VALUES (?, ?, ?, ?)`,
    ).run(s.id, s.capturedAt, s.healthScore, JSON.stringify(layers));
  } catch (err) {
    console.warn("[twin] insertSnapshot failed:", err);
  }
}

interface SnapshotRow {
  id: string;
  captured_at: string;
  health_score: number;
  layers_json: string;
}

function rowToSnapshot(r: SnapshotRow): TwinSnapshot | null {
  try {
    const layers = JSON.parse(r.layers_json) as LayersBlob;
    return {
      id: r.id,
      capturedAt: r.captured_at,
      healthScore: r.health_score,
      hardware: layers.hardware,
      software: layers.software,
      workflow: layers.workflow,
      cognitive: layers.cognitive,
      project: layers.project,
    };
  } catch {
    return null;
  }
}

export function getLatestSnapshot(): TwinSnapshot | null {
  try {
    const db = openDb();
    const row = db
      .prepare<[], SnapshotRow>(
        `SELECT id, captured_at, health_score, layers_json
         FROM system_snapshots ORDER BY captured_at DESC LIMIT 1`,
      )
      .get();
    return row ? rowToSnapshot(row) : null;
  } catch {
    return null;
  }
}

export function getRecentSnapshots(limit: number): TwinSnapshot[] {
  try {
    const db = openDb();
    const rows = db
      .prepare<[number], SnapshotRow>(
        `SELECT id, captured_at, health_score, layers_json
         FROM system_snapshots ORDER BY captured_at DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(2000, limit)));
    return rows
      .map(rowToSnapshot)
      .filter((s): s is TwinSnapshot => s !== null);
  } catch {
    return [];
  }
}

export function pruneSnapshots(keep = SNAPSHOT_RETENTION): void {
  try {
    const db = openDb();
    db.prepare(
      `DELETE FROM system_snapshots
       WHERE id NOT IN (
         SELECT id FROM system_snapshots ORDER BY captured_at DESC LIMIT ?
       )`,
    ).run(keep);
  } catch (err) {
    console.warn("[twin] pruneSnapshots failed:", err);
  }
}

export function insertAnomaly(a: TwinAnomaly, snapshotId: string | null): void {
  try {
    const db = openDb();
    db.prepare(
      `INSERT INTO anomaly_logs
         (id, detected_at, kind, severity, metric, value, baseline, detail, snapshot_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      a.id,
      a.detectedAt,
      a.kind,
      a.severity,
      a.metric,
      a.value,
      a.baseline,
      a.detail,
      snapshotId,
    );
  } catch (err) {
    console.warn("[twin] insertAnomaly failed:", err);
  }
}

export function getRecentAnomalies(limit: number): TwinAnomaly[] {
  try {
    const db = openDb();
    return db
      .prepare<
        [number],
        {
          id: string;
          detected_at: string;
          kind: string;
          severity: string;
          metric: string;
          value: number;
          baseline: number;
          detail: string | null;
        }
      >(
        `SELECT id, detected_at, kind, severity, metric, value, baseline, detail
         FROM anomaly_logs ORDER BY detected_at DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(500, limit)))
      .map((r) => ({
        id: r.id,
        detectedAt: r.detected_at,
        kind: r.kind as TwinAnomaly["kind"],
        severity: r.severity as TwinAnomaly["severity"],
        metric: r.metric,
        value: r.value,
        baseline: r.baseline,
        detail: r.detail ?? "",
      }));
  } catch {
    return [];
  }
}

export function insertPrediction(p: TwinPrediction): void {
  try {
    const db = openDb();
    db.prepare(
      `INSERT INTO twin_predictions
         (id, created_at, metric, horizon_min, predicted, confidence, actual, reason)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      ulid(),
      new Date().toISOString(),
      p.metric,
      p.horizonMin,
      p.predicted,
      p.confidence,
      p.reason,
    );
  } catch (err) {
    console.warn("[twin] insertPrediction failed:", err);
  }
}

export function insertSimulation(r: SimulationResult): void {
  try {
    const db = openDb();
    db.prepare(
      `INSERT INTO simulation_results (id, created_at, action, risk_score, result_json)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      ulid(),
      new Date().toISOString(),
      r.action,
      r.riskScore,
      JSON.stringify(r),
    );
  } catch (err) {
    console.warn("[twin] insertSimulation failed:", err);
  }
}
