// Explicit answer-feedback persistence + the per-run ranker training snapshot
// that lets a later /api/feedback call retrain against the user's verdict.
//
// The pipeline trains the ranker IMPLICITLY at answer time (which retrieved
// memories the answer cited). To learn from EXPLICIT 👍/👎 we need the exact
// feature vectors that produced that ranking — but those are in-memory per
// request and gone once the response streams. recordRankTrainingLog() persists
// them keyed by runId so the feedback route can reconstruct the labelled set.

import { randomUUID } from "node:crypto";
import { openDb } from "../sqlite.js";

export interface FeedbackInput {
  runId: string;
  conversationId?: string | null;
  rating: 1 | -1;
  comment?: string | null;
}

export function insertFeedback(input: FeedbackInput): { id: string } {
  const db = openDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO answer_feedback (id, run_id, conversation_id, rating, comment, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.runId,
    input.conversationId ?? null,
    input.rating,
    input.comment ?? null,
    new Date().toISOString(),
  );
  return { id };
}

export interface FeedbackStats {
  up: number;
  down: number;
  total: number;
  lastAt: string | null;
}

export function getFeedbackStats(): FeedbackStats {
  const db = openDb();
  const row = db
    .prepare<[], { up: number; down: number; total: number; lastAt: string | null }>(
      `SELECT
         COALESCE(SUM(CASE WHEN rating > 0 THEN 1 ELSE 0 END), 0) AS up,
         COALESCE(SUM(CASE WHEN rating < 0 THEN 1 ELSE 0 END), 0) AS down,
         COUNT(*) AS total,
         MAX(created_at) AS lastAt
       FROM answer_feedback`,
    )
    .get();
  return {
    up: row?.up ?? 0,
    down: row?.down ?? 0,
    total: row?.total ?? 0,
    lastAt: row?.lastAt ?? null,
  };
}

const TRAIN_LOG_KEEP = 200;

export function recordRankTrainingLog(
  runId: string,
  featuresById: Map<string, number[]>,
  citedIds: Set<string>,
): void {
  if (featuresById.size === 0) {
    return;
  }
  const db = openDb();
  const features: Record<string, number[]> = {};
  for (const [id, x] of featuresById) {
    features[id] = x;
  }
  db.prepare(
    `INSERT INTO rank_training_log (run_id, features, cited, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET
       features   = excluded.features,
       cited      = excluded.cited,
       created_at = excluded.created_at`,
  ).run(runId, JSON.stringify(features), JSON.stringify(Array.from(citedIds)), new Date().toISOString());
  // Keep bounded — drop everything past the most recent N runs.
  db.prepare(
    `DELETE FROM rank_training_log WHERE run_id NOT IN (
       SELECT run_id FROM rank_training_log ORDER BY created_at DESC LIMIT ?
     )`,
  ).run(TRAIN_LOG_KEEP);
}

export interface RankTrainingSnapshot {
  featuresById: Map<string, number[]>;
  citedIds: Set<string>;
}

// Parse one persisted `rank_training_log` row's JSON into a snapshot, applying
// the same defensive validation everywhere (numeric finite feature vectors,
// string cited ids). Shared by the single-run and all-rows readers below.
function parseTrainingRow(row: { features: string; cited: string }): RankTrainingSnapshot | null {
  try {
    const featuresObj = JSON.parse(row.features) as Record<string, unknown>;
    const featuresById = new Map<string, number[]>();
    for (const [id, x] of Object.entries(featuresObj)) {
      if (Array.isArray(x) && x.every((v) => typeof v === "number" && Number.isFinite(v))) {
        featuresById.set(id, x as number[]);
      }
    }
    const citedArr = JSON.parse(row.cited) as unknown;
    const citedIds = new Set<string>(
      Array.isArray(citedArr) ? (citedArr.filter((v) => typeof v === "string") as string[]) : [],
    );
    return { featuresById, citedIds };
  } catch {
    return null;
  }
}

export function loadRankTrainingLog(runId: string): RankTrainingSnapshot | null {
  const db = openDb();
  const row = db
    .prepare<[string], { features: string; cited: string }>(
      `SELECT features, cited FROM rank_training_log WHERE run_id = ?`,
    )
    .get(runId);
  if (!row) {
    return null;
  }
  return parseTrainingRow(row);
}

// All persisted training snapshots, oldest-first. The evolution optimizer
// flattens these into a single labelled corpus to search ranker weights against.
// Malformed rows are skipped, not fatal. The `run_id ASC` tiebreaker makes the
// order a TOTAL order (run_id is unique) — without it, rows written within the
// same millisecond tie on created_at and SQLite returns them in an unstable
// order, which would make the seeded optimizer non-reproducible across runs.
export function listRankTrainingLogs(db = openDb()): RankTrainingSnapshot[] {
  const rows = db
    .prepare<[], { features: string; cited: string }>(
      `SELECT features, cited FROM rank_training_log ORDER BY created_at ASC, run_id ASC`,
    )
    .all();
  const out: RankTrainingSnapshot[] = [];
  for (const row of rows) {
    const snap = parseTrainingRow(row);
    if (snap) {
      out.push(snap);
    }
  }
  return out;
}
