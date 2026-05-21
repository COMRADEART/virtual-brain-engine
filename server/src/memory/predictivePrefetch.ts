import { openDb, type SqliteDatabase } from "../db/sqlite.js";
import { ulid } from "ulid";

export interface Prediction {
  memoryIds: string[];
  confidence: number;
  reason: string;
  category: "contextual" | "sequential" | "project" | "temporal" | "ensemble";
}

interface SequenceRow {
  id: string;
  sequence_pattern: string;
  next_id: string | null;
  frequency: number;
  last_used: string;
  confidence: number;
}

interface ProjectPatternRow {
  project_name: string;
  typical_sequence: string;
  frequency: number;
}

interface TemporalRow {
  hour_of_day: number;
  day_of_week: number;
  avg_accesses: number;
}

interface ConversationContext {
  lastN: string[];
  projectName: string | null;
  hourOfDay: number;
  dayOfWeek: number;
}

const MAX_PREFETCH = 8;
const MIN_CONFIDENCE = 0.3;
const TEMPORAL_WINDOW_HOURS = 2;

let conversationSequence: string[] = [];
let lastPrefetchTime = 0;

export function recordConversationSequence(
  memoryId: string,
  db: SqliteDatabase = openDb(),
): void {
  conversationSequence.push(memoryId);
  if (conversationSequence.length > 50) {
    conversationSequence = conversationSequence.slice(-50);
  }
  saveSequencePattern(db);
}

function saveSequencePattern(db: SqliteDatabase): void {
  if (conversationSequence.length < 2) return;
  try {
    const pattern = conversationSequence.slice(-10).join("→");
    const nextId = conversationSequence[conversationSequence.length - 1];
    const prevIds = conversationSequence.slice(-10, -1);
    for (let i = 0; i < prevIds.length; i++) {
      const seq = prevIds.slice(i).join("→");
      const next = prevIds[i + 1] ?? nextId;
      const existing = db
        .prepare<[string], { id: string; frequency: number }>(
          `SELECT id, frequency FROM memory_sequence_patterns
           WHERE sequence_pattern = ? ORDER BY last_used DESC LIMIT 1`,
        )
        .get(seq);
      const now = new Date().toISOString();
      if (existing) {
        db.prepare(
          `UPDATE memory_sequence_patterns
           SET frequency = frequency + 1, next_id = ?, last_used = ?, confidence = MIN(1.0, frequency / 20.0)
           WHERE id = ?`,
        ).run(next, now, existing.id);
      } else {
        const id = ulid();
        db.prepare(
          `INSERT INTO memory_sequence_patterns (id, sequence_pattern, next_id, frequency, last_used, confidence, created_at)
           VALUES (?, ?, ?, 1, ?, 0.05, ?)`,
        ).run(id, seq, next, now, now);
      }
    }
  } catch {
    // Swallowed: sequence learning is best-effort. This catch is what hid
    // the missing created_at column (memory_sequence_patterns.created_at is
    // NOT NULL, no default) — see predictivePrefetch.test.ts.
  }
}

export function predictNext(
  context: ConversationContext,
  limit = MAX_PREFETCH,
): Prediction[] {
  const predictions: Prediction[] = [];

  predictions.push(...predictFromSequence(context.lastN));
  predictions.push(...predictFromProject(context.projectName));
  predictions.push(...predictFromTemporal(context.hourOfDay, context.dayOfWeek));
  predictions.push(...predictFromRelated(context.lastN));

  const ensemble = mergePredictions(predictions, limit);
  return ensemble;
}

function predictFromSequence(lastN: string[]): Prediction[] {
  if (lastN.length === 0) return [];
  try {
    const db = openDb();
    const candidates: { id: string; confidence: number; reason: string }[] = [];
    const seqPatterns = lastN.slice(-8).join("→");
    const rows = db
      .prepare<[string], SequenceRow>(
        `SELECT * FROM memory_sequence_patterns
         WHERE sequence_pattern LIKE ?
         ORDER BY confidence DESC, frequency DESC
         LIMIT 10`,
      )
      .all(`%${seqPatterns}%`);
    for (const row of rows) {
      if (row.next_id) {
        candidates.push({
          id: row.next_id,
          confidence: row.confidence,
          reason: `sequence pattern "${row.sequence_pattern}" (f=${row.frequency})`,
        });
      }
    }
    return [{ memoryIds: candidates.map((c) => c.id), confidence: avg(candidates.map((c) => c.confidence)), reason: formatReasons(candidates), category: "sequential" }];
  } catch {
    return [];
  }
}

function predictFromProject(projectName: string | null): Prediction[] {
  if (!projectName) return [];
  try {
    const db = openDb();
    const rows = db
      .prepare<[string], { id: string; confidence: number }>(
        `SELECT mp.id, mp.importance AS confidence
         FROM memory_points mp
         JOIN memory_sequence_patterns msp ON msp.next_id = mp.id
         WHERE mp.project_name = ?
           AND datetime(mp.updated_at) > datetime('now', '-7 days')
         ORDER BY mp.importance DESC, msp.frequency DESC
         LIMIT 5`,
      )
      .all(projectName);
    if (rows.length === 0) {
      const fallback = db
        .prepare<[string, number], { id: string; importance: number }>(
          `SELECT id, importance FROM memory_points
           WHERE project_name = ? AND summary_id IS NULL
           ORDER BY importance DESC, updated_at DESC
           LIMIT 5`,
        )
        .all(projectName, 5);
      return [{
        memoryIds: fallback.map((r) => r.id),
        confidence: 0.4,
        reason: `recent project "${projectName}" memories`,
        category: "project",
      }];
    }
    return [{
      memoryIds: rows.map((r) => r.id),
      confidence: avg(rows.map((r) => r.confidence)),
      reason: `project "${projectName}" context`,
      category: "project",
    }];
  } catch {
    return [];
  }
}

export function predictFromTemporal(
  hourOfDay: number,
  dayOfWeek: number,
  db: SqliteDatabase = openDb(),
): Prediction[] {
  try {
    // dayOfWeek is not honored: the schema has no day-of-week temporal
    // data (memory_temporal_dow was never created or written). Scoring
    // uses real memory_temporal_patterns data only — see test.
    const rows = db
      .prepare<[number], { id: string; score: number }>(
        `SELECT mp.id,
                mp.importance * (1.0 + mtp.access_count * 0.05) AS score
         FROM memory_temporal_patterns mtp
         JOIN memory_points mp ON mp.id = mtp.memory_id
         WHERE mtp.hour_of_day = ?
           AND datetime(mp.updated_at) > datetime('now', '-14 days')
           AND mp.importance > 0.3
         ORDER BY score DESC
         LIMIT 5`,
      )
      .all(hourOfDay);
    return [{
      memoryIds: rows.map((r) => r.id),
      confidence: rows.length > 0 ? avg(rows.map((r) => r.score)) : 0,
      reason: `temporal pattern (${hourOfDay}h, day ${dayOfWeek})`,
      category: "temporal",
    }];
  } catch {
    return [];
  }
}

function predictFromRelated(lastN: string[]): Prediction[] {
  if (lastN.length === 0) return [];
  try {
    const db = openDb();
    const recentIds = lastN.slice(-5);
    const placeholders = recentIds.map(() => "?").join(", ");
    const rows = db
      .prepare<[string[]], { id: string; relation_score: number }>(
        `SELECT mr.to_id AS id, MAX(mr.weight) AS relation_score
         FROM memory_relations mr
         JOIN memory_points mp ON mp.id = mr.to_id
         WHERE mr.from_id IN (${placeholders})
           AND mp.importance > 0.3
           AND mp.summary_id IS NULL
         GROUP BY mr.to_id
         ORDER BY relation_score DESC
         LIMIT 5`,
      )
      .all(recentIds);
    return [{
      memoryIds: rows.map((r) => r.id),
      confidence: avg(rows.map((r) => r.relation_score)),
      reason: "related to recently accessed memories",
      category: "contextual",
    }];
  } catch {
    return [];
  }
}

function mergePredictions(predictions: Prediction[], limit: number): Prediction[] {
  if (predictions.length === 0) return [];
  if (predictions.length === 1) return predictions;

  const scoreMap = new Map<string, { score: number; reasons: string[]; category: string }>();
  for (const pred of predictions) {
    const weight = pred.confidence;
    for (const id of pred.memoryIds) {
      const existing = scoreMap.get(id);
      if (existing) {
        existing.score += weight;
        existing.reasons.push(pred.reason);
      } else {
        scoreMap.set(id, { score: weight, reasons: [pred.reason], category: pred.category });
      }
    }
  }

  const sorted = [...scoreMap.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit);

  const combined: Prediction[] = [];
  const grouped = new Map<string, { ids: string[]; totalScore: number; reasons: Set<string> }>();
  for (const [id, info] of sorted) {
    const key = info.category;
    const g = grouped.get(key) ?? { ids: [], totalScore: 0, reasons: new Set() };
    g.ids.push(id);
    g.totalScore += info.score;
    for (const r of info.reasons) g.reasons.add(r);
    grouped.set(key, g);
  }

  for (const [category, g] of grouped) {
    combined.push({
      memoryIds: g.ids.slice(0, Math.ceil(limit / grouped.size)),
      confidence: g.totalScore / g.ids.length,
      reason: [...g.reasons].join("; "),
      category: category as Prediction["category"],
    });
  }

  return combined;
}

export function prefetchForQuery(query: string, limit = MAX_PREFETCH): string[] {
  try {
    const db = openDb();
    const rows = db
      .prepare<[string, number], { id: string; importance: number }>(
        `SELECT id, importance FROM memory_points
         WHERE content LIKE ?
           AND summary_id IS NULL
           AND importance > 0.3
         ORDER BY importance DESC, updated_at DESC
         LIMIT ?`,
      )
      .all(`%${query}%`, limit);
    return rows.map((r) => r.id);
  } catch {
    return [];
  }
}

export function updateTemporalPattern(
  memoryId: string,
  db: SqliteDatabase = openDb(),
): void {
  try {
    const now = new Date();
    const hour = now.getHours();
    const dow = now.getDay();
    const existing = db
      .prepare<[string, number], { c: number }>(
        `SELECT COUNT(*) AS c FROM memory_temporal_patterns
         WHERE memory_id = ? AND hour_of_day = ?`,
      )
      .get(memoryId, hour);
    if (existing && existing.c > 0) {
      db.prepare(
        `UPDATE memory_temporal_patterns
         SET access_count = access_count + 1, last_access = ?
         WHERE memory_id = ? AND hour_of_day = ?`,
      ).run(now.toISOString(), memoryId, hour);
    } else {
      const id = ulid();
      db.prepare(
        `INSERT INTO memory_temporal_patterns (id, memory_id, hour_of_day, access_count, last_access, created_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
      ).run(id, memoryId, hour, now.toISOString(), now.toISOString());
    }
  } catch {
    // Swallowed: temporal tracking is best-effort. This catch is what hid
    // the missing created_at column (memory_temporal_patterns.created_at is
    // NOT NULL, no default) — see predictivePrefetch.test.ts.
  }
}

function avg(vals: number[]): number {
  if (vals.length === 0) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function formatReasons(candidates: { id: string; confidence: number; reason: string }[]): string {
  if (candidates.length === 0) return "no candidates";
  const top = candidates.slice(0, 2);
  return top.map((c) => c.reason).join("; ");
}