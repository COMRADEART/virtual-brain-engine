import { openDb, type SqliteDatabase } from "../db/sqlite.js";
import { surfaceError } from "../util/diagnostics.js";

export interface StrengthEvent {
  fromId: string;
  toId: string;
  strengthDelta: number;
  eventType: "cite" | "coaccess" | "derive" | "contradict" | "decay";
  timestamp: string;
}

interface StrengthUpdate {
  id: string;
  importance: number;
}

const HEBBIAN_LEARNING_RATE = 0.08;
// Kept as plain numeric literals: these are interpolated directly into the
// clamp SQL in updateMemoryStrength/batchUpdateStrength. Safe only because
// they are compile-time constants — never assign runtime/user values here.
const MAX_STRENGTH = 1.0;
const MIN_STRENGTH = 0.01;
const CONTRADICTION_STRENGTHEN = -0.15;
const CITATION_BOOST = 0.06;
const COACCESS_BOOST = 0.03;
const DERIVE_BOOST = 0.04;

export function applyStrengthEvent(
  event: StrengthEvent,
  db: SqliteDatabase = openDb(),
): void {
  const { fromId, toId, strengthDelta, eventType } = event;
  const delta = computeHebbianDelta(fromId, toId, strengthDelta, eventType, db);
  if (Math.abs(delta) < 0.001) return;
  updateMemoryStrength(toId, delta, db);
}

function computeHebbianDelta(
  fromId: string,
  toId: string,
  correlation: number,
  eventType: StrengthEvent["eventType"],
  db: SqliteDatabase,
): number {
  let baseDelta: number;
  switch (eventType) {
    case "cite":
      baseDelta = CITATION_BOOST * correlation;
      break;
    case "coaccess":
      baseDelta = COACCESS_BOOST * correlation;
      break;
    case "derive":
      baseDelta = DERIVE_BOOST * correlation;
      break;
    case "contradict":
      baseDelta = CONTRADICTION_STRENGTHEN * Math.abs(correlation);
      break;
    case "decay":
      baseDelta = -0.02;
      break;
    default:
      baseDelta = HEBBIAN_LEARNING_RATE * correlation;
  }

  if (eventType === "cite" || eventType === "derive") {
    const reciprocalBoost = baseDelta * 0.3;
    updateMemoryStrength(fromId, reciprocalBoost, db);
  }

  return baseDelta;
}

export function updateMemoryStrength(
  id: string,
  delta: number,
  db: SqliteDatabase = openDb(),
): void {
  if (Math.abs(delta) < 0.001) return;
  try {
    db.prepare(
      `UPDATE memory_points
       SET importance = MAX(${MIN_STRENGTH}, MIN(${MAX_STRENGTH}, importance + ?)),
           updated_at = ?
       WHERE id = ?`,
    ).run(delta, new Date().toISOString(), id);
  } catch (err) {
    // A strength write must never break the caller's pipeline — but it is no
    // longer silent: surfaceError logs + counts + (throttled) broadcasts it.
    // This catch is what let the MIN_STRENGTH/MAX_STRENGTH SQL-identifier bug
    // stay silent before.
    surfaceError("memoryStrength.updateMemoryStrength", err);
  }
}

export function applyCorrelationDecay(baseImportance: number, ageDays: number, accessCount: number): number {
  const timeDecay = Math.exp(-ageDays / 14);
  const accessBonus = Math.min(0.15, accessCount * 0.015);
  const strength = baseImportance * timeDecay + accessBonus;
  return Math.max(MIN_STRENGTH, Math.min(MAX_STRENGTH, strength));
}

export function strengthenPathway(
  fromId: string,
  toId: string,
  db: SqliteDatabase = openDb(),
): void {
  applyStrengthEvent(
    {
      fromId,
      toId,
      strengthDelta: 1.0,
      eventType: "cite",
      timestamp: new Date().toISOString(),
    },
    db,
  );
}

export function weakenPathway(fromId: string, toId: string, reason: "contradict" | "decay"): void {
  const delta = reason === "contradict" ? CONTRADICTION_STRENGTHEN : -0.02;
  applyStrengthEvent({
    fromId,
    toId,
    strengthDelta: delta,
    eventType: reason,
    timestamp: new Date().toISOString(),
  });
}

export function getPathwayStrength(fromId: string, toId: string): number {
  try {
    const db = openDb();
    const row = db
      .prepare<[string, string, string, string], { weight: number }>(
        `SELECT weight FROM memory_relations
         WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)`,
      )
      .get(fromId, toId, toId, fromId);
    return row?.weight ?? 0;
  } catch {
    return 0;
  }
}

export function applySpreadingActivationBoost(
  centerId: string,
  neighbors: string[],
  baseBoost = 0.05,
): void {
  if (neighbors.length === 0) return;
  const decayFactor = 0.6;
  const db = openDb();
  const stmt = db.prepare(
    `UPDATE memory_points
     SET importance = MIN(1.0, importance + ?), updated_at = ?
     WHERE id = ?`,
  );
  for (let i = 0; i < neighbors.length; i++) {
    const boost = baseBoost * Math.pow(decayFactor, i + 1);
    if (boost > 0.005) {
      stmt.run(boost, new Date().toISOString(), neighbors[i]);
    }
  }
}

export function computeMemoryHalfLife(
  importance: number,
  accessCount: number,
  citationCount: number,
): number {
  const baseHalfLife = 14;
  const accessMultiplier = Math.max(0.5, 1 - accessCount * 0.02);
  const citationMultiplier = Math.max(0.3, 1 - citationCount * 0.03);
  const importanceMultiplier = Math.max(0.5, importance);
  return baseHalfLife * accessMultiplier * citationMultiplier * importanceMultiplier;
}

export function propagateStrength(anchorId: string, depth = 2): void {
  if (depth <= 0) return;
  const db = openDb();
  const neighbors = db
    .prepare<[string, string], { neighbor_id: string; weight: number }>(
      `SELECT CASE WHEN from_id = ? THEN to_id ELSE from_id END AS neighbor_id,
              weight
       FROM memory_relations
       WHERE from_id = ? OR to_id = ?
       ORDER BY weight DESC
       LIMIT 10`,
    )
    .all(anchorId, anchorId);
  for (const { neighbor_id, weight } of neighbors) {
    if (weight > 0.2) {
      const boost = weight * 0.02 * depth;
      updateMemoryStrength(neighbor_id, boost);
      propagateStrength(neighbor_id, depth - 1);
    }
  }
}

export function batchUpdateStrength(
  updates: Array<{ id: string; delta: number }>,
  db: SqliteDatabase = openDb(),
): void {
  if (updates.length === 0) return;
  try {
    const stmt = db.prepare(
      `UPDATE memory_points
       SET importance = MAX(${MIN_STRENGTH}, MIN(${MAX_STRENGTH}, importance + ?)),
           updated_at = ?
       WHERE id = ?`,
    );
    const now = new Date().toISOString();
    for (const { id, delta } of updates) {
      if (Math.abs(delta) >= 0.001) {
        stmt.run(delta, now, id);
      }
    }
  } catch {
    // Swallowed by design (batch strength is best-effort). See the
    // matching note on updateMemoryStrength — same hidden-failure risk.
  }
}

export function normalizeStrengths(sampleSize = 100): void {
  try {
    const db = openDb();
    const rows = db
      .prepare<[number], { id: string; importance: number }>(
        `SELECT id, importance FROM memory_points
         WHERE summary_id IS NULL
         ORDER BY importance DESC
         LIMIT ?`,
      )
      .all(sampleSize);
    if (rows.length < 2) return;
    const maxImp = rows[0].importance;
    const minImp = rows[rows.length - 1].importance;
    if (maxImp <= minImp) return;
    const range = maxImp - minImp;
    const stmt = db.prepare(
      `UPDATE memory_points SET importance = ?, updated_at = ? WHERE id = ?`,
    );
    const now = new Date().toISOString();
    for (const row of rows) {
      const normalized = minImp + (row.importance - minImp) / range * (maxImp - minImp);
      stmt.run(normalized, now, row.id);
    }
  } catch {
    // ignore
  }
}

export function getStrengthStats(): {
  avgImportance: number;
  highStrength: number;
  lowStrength: number;
  totalRelations: number;
} {
  try {
    const db = openDb();
    const stats = db
      .prepare<[], { avg_imp: number; high: number; low: number }>(
        `SELECT AVG(importance) AS avg_imp,
                COUNT(CASE WHEN importance >= 0.6 THEN 1 END) AS high,
                COUNT(CASE WHEN importance <= 0.1 THEN 1 END) AS low
         FROM memory_points WHERE summary_id IS NULL`,
      )
      .get();
    const relCount = db
      .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM memory_relations`)
      .get();
    return {
      avgImportance: stats?.avg_imp ?? 0.5,
      highStrength: stats?.high ?? 0,
      lowStrength: stats?.low ?? 0,
      totalRelations: relCount?.c ?? 0,
    };
  } catch {
    return { avgImportance: 0.5, highStrength: 0, lowStrength: 0, totalRelations: 0 };
  }
}