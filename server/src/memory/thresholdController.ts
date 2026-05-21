import { openDb, type SqliteDatabase } from "../db/sqlite.js";

export interface AdaptiveThresholds {
  forget: number;
  consolidate: number;
  promote: number;
  archive: number;
  decayRate: number;
}

export interface ThresholdMetrics {
  memoryPressure: number;
  retentionRate: number;
  consolidationRate: number;
  adaptationStrength: number;
  lastAdapted: string;
  thresholds: AdaptiveThresholds;
}

const DEFAULT_THRESHOLDS: AdaptiveThresholds = {
  forget: 0.08,
  consolidate: 0.35,
  promote: 0.60,
  archive: 0.15,
  decayRate: 0.05,
};

const ADAPTATION_RATE = 0.02;
const MIN_ADAPTATION_INTERVAL_MS = 5 * 60 * 1000;
const MEMORY_PRESSURE_WINDOW = 500;

let lastAdaptationTime = 0;
let adaptationHistory: number[] = [];
let cachedThresholds: AdaptiveThresholds = { ...DEFAULT_THRESHOLDS };

export function getCurrentThresholds(): AdaptiveThresholds {
  return { ...cachedThresholds };
}

export function adaptThresholds(force = false): AdaptiveThresholds {
  const now = Date.now();
  if (!force && now - lastAdaptationTime < MIN_ADAPTATION_INTERVAL_MS) {
    return cachedThresholds;
  }
  lastAdaptationTime = now;

  try {
    const db = openDb();
    const metrics = computeMemoryMetrics(db);
    const pressureFactor = computePressureFactor(metrics);
    const retentionFactor = computeRetentionFactor(metrics);
    const consolidationEfficiency = computeConsolidationEfficiency(db);

    const newThresholds: AdaptiveThresholds = {
      forget: clampThreshold(
        DEFAULT_THRESHOLDS.forget *
          (1 - ADAPTATION_RATE * 0.5 * pressureFactor) *
          (1 + ADAPTATION_RATE * 0.3 * retentionFactor),
      ),
      consolidate: clampThreshold(
        DEFAULT_THRESHOLDS.consolidate *
          (1 - ADAPTATION_RATE * 0.4 * pressureFactor) *
          (1 + ADAPTATION_RATE * 0.2 * consolidationEfficiency),
      ),
      promote: clampThreshold(
        DEFAULT_THRESHOLDS.promote *
          (1 + ADAPTATION_RATE * 0.2 * retentionFactor) *
          (1 - ADAPTATION_RATE * 0.1 * pressureFactor),
      ),
      archive: clampThreshold(
        DEFAULT_THRESHOLDS.archive *
          (1 + ADAPTATION_RATE * 0.3 * pressureFactor),
      ),
      decayRate: clampDecayRate(
        DEFAULT_THRESHOLDS.decayRate *
          (1 + ADAPTATION_RATE * 0.5 * (pressureFactor - 0.5)),
      ),
    };

    cachedThresholds = newThresholds;
    adaptationHistory.push(pressureFactor);
    if (adaptationHistory.length > 50) {
      adaptationHistory = adaptationHistory.slice(-50);
    }

    persistThresholds(newThresholds);
    return newThresholds;
  } catch {
    return cachedThresholds;
  }
}

interface MemoryMetrics {
  totalMemories: number;
  highImportance: number;
  mediumImportance: number;
  lowImportance: number;
  veryLowImportance: number;
  archivedCount: number;
  consolidationCandidates: number;
  recentGrowth: number;
  avgImportance: number;
}

function computeMemoryMetrics(db: ReturnType<typeof openDb>): MemoryMetrics {
  const total = db
    .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM memory_points WHERE summary_id IS NULL`)
    .get();
  const importanceDist = db
    .prepare<[], { high: number; med: number; low: number; very_low: number }>(
      `SELECT
         COUNT(CASE WHEN importance >= 0.6 THEN 1 END) AS high,
         COUNT(CASE WHEN importance >= 0.35 AND importance < 0.6 THEN 1 END) AS med,
         COUNT(CASE WHEN importance >= 0.08 AND importance < 0.35 THEN 1 END) AS low,
         COUNT(CASE WHEN importance < 0.08 THEN 1 END) AS very_low
       FROM memory_points WHERE summary_id IS NULL`,
    )
    .get();
  const archived = db
    .prepare<[], { c: number }>(
      `SELECT COUNT(*) AS c FROM memory_points WHERE json_extract(metadata, '$.archived') = 1`,
    )
    .get();
  const recentGrowth = computeRecentGrowth(db);
  const avg = db
    .prepare<[], { avg: number }>(
      `SELECT AVG(importance) AS avg FROM memory_points WHERE summary_id IS NULL`,
    )
    .get();

  return {
    totalMemories: total?.c ?? 0,
    highImportance: importanceDist?.high ?? 0,
    mediumImportance: importanceDist?.med ?? 0,
    lowImportance: importanceDist?.low ?? 0,
    veryLowImportance: importanceDist?.very_low ?? 0,
    archivedCount: archived?.c ?? 0,
    consolidationCandidates: importanceDist?.low ?? 0,
    recentGrowth: recentGrowth,
    avgImportance: avg?.avg ?? 0.5,
  };
}

function computeRecentGrowth(db: ReturnType<typeof openDb>): number {
  const recent = db
    .prepare<[], { c: number }>(
      `SELECT COUNT(*) AS c FROM memory_points WHERE datetime(created_at) > datetime('now', '-7 days')`,
    )
    .get();
  const older = db
    .prepare<[], { c: number }>(
      `SELECT COUNT(*) AS c FROM memory_points WHERE datetime(created_at) <= datetime('now', '-7 days')
       AND datetime(created_at) > datetime('now', '-30 days')`,
    )
    .get();
  if (!older || older.c === 0) return recent?.c ?? 0;
  return ((recent?.c ?? 0) - (older.c ?? 0)) / (older.c ?? 1);
}

function computePressureFactor(m: MemoryMetrics): number {
  const targetHigh = 0.3;
  const targetMedium = 0.4;
  const pressure =
    (m.lowImportance / Math.max(1, m.totalMemories)) * 0.4 +
    (m.veryLowImportance / Math.max(1, m.totalMemories)) * 0.3 +
    Math.max(0, m.recentGrowth) * 0.2 +
    (m.totalMemories > 5000 ? 0.2 : 0) +
    Math.max(0, 1 - m.avgImportance / 0.5) * 0.1;
  return Math.max(0, Math.min(1, pressure));
}

function computeRetentionFactor(m: MemoryMetrics): number {
  if (m.totalMemories === 0) return 0.5;
  const retention =
    (m.highImportance / m.totalMemories) * 0.5 +
    (m.mediumImportance / m.totalMemories) * 0.3 +
    Math.max(0, 1 - m.veryLowImportance / Math.max(1, m.lowImportance)) * 0.2;
  return Math.max(0, Math.min(1, retention));
}

function computeConsolidationEfficiency(db: ReturnType<typeof openDb>): number {
  const consolidated = db
    .prepare<[], { c: number }>(
      `SELECT COUNT(*) AS c FROM memory_points WHERE summary_id IS NOT NULL
       AND datetime(created_at) > datetime('now', '-7 days')`,
    )
    .get();
  const eligible = db
    .prepare<[], { c: number }>(
      `SELECT COUNT(*) AS c FROM memory_points
       WHERE importance < 0.35 AND summary_id IS NULL AND importance >= 0.08
       AND datetime(created_at) < datetime('now', '-7 days')`,
    )
    .get();
  if (!eligible || eligible.c === 0) return 0.5;
  return Math.min(1, (consolidated?.c ?? 0) / eligible.c);
}

function clampThreshold(v: number): number {
  return Math.max(0.02, Math.min(0.5, v));
}

function clampDecayRate(v: number): number {
  return Math.max(0.01, Math.min(0.2, v));
}

function persistThresholds(t: AdaptiveThresholds): void {
  try {
    const db = openDb();
    const encoded = JSON.stringify(t);
    db.prepare(
      `INSERT OR REPLACE INTO brain_metadata (key, value) VALUES ('adaptive_thresholds', ?)`,
    ).run(encoded);
  } catch {
    // ignore
  }
}

export function loadThresholds(
  db: SqliteDatabase = openDb(),
): AdaptiveThresholds {
  try {
    const row = db
      .prepare<[], { value: string }>(
        `SELECT value FROM brain_metadata WHERE key = 'adaptive_thresholds'`,
      )
      .get();
    if (row?.value) {
      const parsed = JSON.parse(row.value) as AdaptiveThresholds;
      if (
        typeof parsed.forget === "number" &&
        typeof parsed.consolidate === "number" &&
        typeof parsed.promote === "number"
      ) {
        cachedThresholds = parsed;
        return parsed;
      }
    }
  } catch {
    // Swallowed: threshold load is best-effort, falls back to defaults.
    // This catch is what hid the spurious .get() bind arg against a
    // zero-placeholder query — see thresholdController.test.ts.
  }
  return { ...DEFAULT_THRESHOLDS };
}

export function getThresholdMetrics(): ThresholdMetrics {
  try {
    const db = openDb();
    const m = computeMemoryMetrics(db);
    return {
      memoryPressure: computePressureFactor(m),
      retentionRate: computeRetentionFactor(m),
      consolidationRate: computeConsolidationEfficiency(db),
      adaptationStrength: adaptationHistory.length > 0
        ? avg(adaptationHistory.slice(-20))
        : 0.5,
      lastAdapted: new Date(lastAdaptationTime).toISOString(),
      thresholds: { ...cachedThresholds },
    };
  } catch {
    return {
      memoryPressure: 0,
      retentionRate: 0.5,
      consolidationRate: 0.5,
      adaptationStrength: 0.5,
      lastAdapted: new Date(lastAdaptationTime).toISOString(),
      thresholds: { ...cachedThresholds },
    };
  }
}

function avg(vals: number[]): number {
  if (vals.length === 0) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}