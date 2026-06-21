// Observability spine — the DURABLE half: persists the brain's vitals as a
// time-series (brain_vitals) and its error taxonomy (diagnostics_log), and reads
// them back for GET /api/brain/{vitals,metrics,diagnostics}.
//
// Every function is failure-isolated (a telemetry write must NEVER break a
// caller — least of all surfaceError, the universal error sink that calls
// persistDiagnostic). Gated on CONFIG.observability so the spine can be disabled
// wholesale. Retention-pruned so a long-running brain can't grow the tables
// unbounded.

import { ulid } from "ulid";
import { openDb } from "../db/sqlite.js";
import { CONFIG } from "../config.js";
import type { VitalSample, DiagnosticEntry } from "../../../shared/observability.js";

const RETENTION_DAYS = 7;

// Persist a batch of (metric → value) gauges with one shared timestamp. Called
// from the brainCore vitals tick; the keys are free-form dotted metric names.
export function recordVitals(samples: Record<string, number>, at = new Date().toISOString()): void {
  if (!CONFIG.observability) return;
  try {
    const db = openDb();
    const stmt = db.prepare(
      "INSERT INTO brain_vitals (id, metric, value, captured_at) VALUES (?, ?, ?, ?)",
    );
    const insertMany = db.transaction((rows: Array<[string, number]>) => {
      for (const [metric, value] of rows) {
        if (Number.isFinite(value)) stmt.run(ulid(), metric, value, at);
      }
    });
    insertMany(Object.entries(samples));
  } catch (err) {
    console.warn("[vitals] recordVitals failed:", err instanceof Error ? err.message : err);
  }
}

export function readVitals(sinceIso?: string, limit = 1000): VitalSample[] {
  try {
    const db = openDb();
    const rows = sinceIso
      ? db
          .prepare<[string, number], { metric: string; value: number; captured_at: string }>(
            "SELECT metric, value, captured_at FROM brain_vitals WHERE captured_at >= ? ORDER BY captured_at DESC LIMIT ?",
          )
          .all(sinceIso, limit)
      : db
          .prepare<[number], { metric: string; value: number; captured_at: string }>(
            "SELECT metric, value, captured_at FROM brain_vitals ORDER BY captured_at DESC LIMIT ?",
          )
          .all(limit);
    return rows.map((r) => ({ metric: r.metric, value: r.value, capturedAt: r.captured_at }));
  } catch {
    return [];
  }
}

// Persist one error/warning into the durable taxonomy. MUST be silent on
// failure — it is called from surfaceError, so a throw or a recursive
// surfaceError here would defeat the whole point.
export function persistDiagnostic(
  source: string,
  level: "warn" | "error",
  message: string,
  count: number,
): void {
  if (!CONFIG.observability) return;
  try {
    openDb()
      .prepare(
        "INSERT INTO diagnostics_log (id, source, level, message, count, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(ulid(), source, level, message.slice(0, 500), count, new Date().toISOString());
  } catch {
    // best-effort; deliberately swallowed (no surfaceError recursion)
  }
}

export function readDiagnostics(limit = 100): DiagnosticEntry[] {
  try {
    const rows = openDb()
      .prepare<[number], { source: string; level: string; message: string; count: number; created_at: string }>(
        "SELECT source, level, message, count, created_at FROM diagnostics_log ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit);
    return rows.map((r) => ({
      source: r.source,
      level: r.level === "error" ? "error" : "warn",
      message: r.message,
      count: r.count,
      createdAt: r.created_at,
    }));
  } catch {
    return [];
  }
}

// Bound both tables to RETENTION_DAYS. Cheap; called on the vitals tick.
export function pruneOldTelemetry(): void {
  if (!CONFIG.observability) return;
  try {
    const db = openDb();
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
    db.prepare("DELETE FROM brain_vitals WHERE captured_at < ?").run(cutoff);
    db.prepare("DELETE FROM diagnostics_log WHERE created_at < ?").run(cutoff);
  } catch {
    // best-effort
  }
}
