import { openDb, type SqliteDatabase } from "../db/sqlite.js";
import { ulid } from "ulid";

export interface AccessEvent {
  memoryId: string;
  timestamp: number;
  context?: string;
}

interface AccessPatternRow {
  memory_a: string;
  memory_b: string;
  coaccess_count: number;
  last_coaccess: string;
  total_activation_b: number;
}

const SPREADING_DECAY = 0.85;
const MIN_COACCESS_COUNT = 2;
const ACTIVATION_BOOST_PER_HOP = 0.15;
const MAX_HOPS = 3;

let recentAccessLog: AccessEvent[] = [];
let activationCache = new Map<string, number>();
let activationDirty = false;

export function recordAccess(memoryId: string, context?: string): void {
  const event: AccessEvent = { memoryId, timestamp: Date.now(), context };
  recentAccessLog.push(event);
  if (recentAccessLog.length > 200) {
    recentAccessLog = recentAccessLog.slice(-200);
  }
  activateNeighbors(memoryId);
  activationDirty = true;
}

function activateNeighbors(memoryId: string, depth = 0): void {
  if (depth >= MAX_HOPS) return;
  const boost = ACTIVATION_BOOST_PER_HOP * Math.pow(SPREADING_DECAY, depth);
  const current = activationCache.get(memoryId) ?? 0;
  activationCache.set(memoryId, current + boost);
  const neighbors = getCoaccessedNeighbors(memoryId);
  for (const neighbor of neighbors) {
    activateNeighbors(neighbor, depth + 1);
  }
}

function getCoaccessedNeighbors(memoryId: string): string[] {
  try {
    const db = openDb();
    const rows = db
      .prepare<[string, string, number], { memory_a: string; memory_b: string; coaccess_count: number }>(
        `SELECT memory_a, memory_b, coaccess_count FROM memory_access_patterns
         WHERE (memory_a = ? OR memory_b = ?) AND coaccess_count >= ?
         ORDER BY coaccess_count DESC LIMIT 10`,
      )
      .all(memoryId, memoryId, MIN_COACCESS_COUNT);
    return rows.map((r) => (r.memory_a === memoryId ? r.memory_b : r.memory_a));
  } catch {
    return [];
  }
}

export function getActivationLevel(memoryId: string): number {
  return activationCache.get(memoryId) ?? 0;
}

export function flushActivationCache(): Map<string, number> {
  const snapshot = new Map(activationCache);
  activationCache.clear();
  activationDirty = false;
  return snapshot;
}

export function applySpreadingActivation(): void {
  if (!activationDirty) return;
  const db = openDb();
  const snapshot = flushActivationCache();
  const stmt = db.prepare(
    `UPDATE memory_points SET importance = MIN(1.0, importance + ?), updated_at = ? WHERE id = ?`,
  );
  for (const [id, boost] of snapshot) {
    if (boost > 0.01) {
      stmt.run(boost, new Date().toISOString(), id);
    }
  }
}

export function buildAccessPattern(
  fromId: string,
  toId: string,
  db: SqliteDatabase = openDb(),
): void {
  try {
    const now = new Date().toISOString();
    const existing = db
      .prepare<[string, string, string, string], { coaccess_count: number }>(
        `SELECT coaccess_count FROM memory_access_patterns
         WHERE (memory_a = ? AND memory_b = ?) OR (memory_a = ? AND memory_b = ?)`,
      )
      .get(fromId, toId, toId, fromId);
    if (existing) {
      db.prepare(
        `UPDATE memory_access_patterns
         SET coaccess_count = coaccess_count + 1, last_coaccess = ?
         WHERE (memory_a = ? AND memory_b = ?) OR (memory_a = ? AND memory_b = ?)`,
      ).run(now, fromId, toId, toId, fromId);
    } else {
      const id = ulid();
      db.prepare(
        `INSERT INTO memory_access_patterns (id, memory_a, memory_b, coaccess_count, last_coaccess, total_activation_b, created_at)
         VALUES (?, ?, ?, 1, ?, 0, ?)`,
      ).run(id, fromId, toId, now, now);
    }
  } catch {
    // Swallowed: co-access tracking is best-effort and must not break the
    // consolidation caller. This catch is what hid the missing created_at
    // column (memory_access_patterns.created_at is NOT NULL) — see test.
  }
}

export function getRelatedMemories(memoryId: string, limit = 10): string[] {
  try {
    const db = openDb();
    const rows = db
      .prepare<[string, string, number, string, string], { related_id: string; score: number }>(
        `SELECT related_id, score FROM (
           SELECT CASE WHEN memory_a = ? THEN memory_b ELSE memory_a END AS related_id,
                  coaccess_count AS score
           FROM memory_access_patterns
           WHERE (memory_a = ? OR memory_b = ?) AND coaccess_count >= ?
           UNION ALL
           SELECT to_id AS related_id, weight AS score
           FROM memory_relations
           WHERE from_id = ? OR to_id = ?
         ) combined
         GROUP BY related_id
         ORDER BY score DESC
         LIMIT ${limit}`,
      )
      .all(memoryId, memoryId, MIN_COACCESS_COUNT, memoryId, memoryId);
    return rows.map((r) => r.related_id);
  } catch {
    return [];
  }
}

export function getHotMemories(hours = 24, limit = 20): { id: string; heat: number }[] {
  try {
    const db = openDb();
    const rows = db
      .prepare<[number], { id: string; recent_accesses: number; importance: number }>(
        `SELECT mp.id, COUNT(mar.id) AS recent_accesses, mp.importance
         FROM memory_points mp
         LEFT JOIN memory_access_log mar ON mar.memory_id = mp.id
           AND datetime(mar.accessed_at) > datetime('now', '-${hours} hours')
         WHERE mp.importance >= 0.3
         GROUP BY mp.id
         ORDER BY recent_accesses DESC, mp.importance DESC
         LIMIT ?`,
      )
      .all(limit);
    return rows.map((r) => ({
      id: r.id,
      heat: r.recent_accesses + r.importance * 2,
    }));
  } catch {
    return [];
  }
}

export function getAccessStats(): {
  logSize: number;
  cachedActivations: number;
  dirty: boolean;
} {
  return {
    logSize: recentAccessLog.length,
    cachedActivations: activationCache.size,
    dirty: activationDirty,
  };
}