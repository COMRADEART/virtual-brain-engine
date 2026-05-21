import { openDb } from "../sqlite.js";
import { FEATURE_DIM, FEATURE_VERSION } from "../../reasoning/rankerModel.js";

const ROW_ID = "memory_ranker";

export interface RankerState {
  version: number;
  weights: number[];
  // Number of training queries that had >= 1 citation (negative-only queries
  // carry little signal and are not counted toward warm-up).
  trainedCount: number;
}

export function loadRankerState(): RankerState | null {
  const db = openDb();
  const row = db
    .prepare<[string], { version: number; weights: string; trained_count: number }>(
      `SELECT version, weights, trained_count FROM ranker_state WHERE id = ?`,
    )
    .get(ROW_ID);
  if (!row) {
    return null;
  }
  if (row.version !== FEATURE_VERSION) {
    // Feature layout changed under us — drop stale weights cleanly rather than
    // broadcasting them through a mismatched feature vector.
    return null;
  }
  try {
    const weights = JSON.parse(row.weights) as unknown;
    if (
      !Array.isArray(weights) ||
      weights.length !== FEATURE_DIM ||
      weights.some((w) => typeof w !== "number" || !Number.isFinite(w))
    ) {
      return null;
    }
    return {
      version: row.version,
      weights: weights as number[],
      trainedCount: row.trained_count,
    };
  } catch {
    return null;
  }
}

export function saveRankerState(state: RankerState): void {
  const db = openDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ranker_state (id, version, weights, trained_count, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       version       = excluded.version,
       weights       = excluded.weights,
       trained_count = excluded.trained_count,
       updated_at    = excluded.updated_at`,
  ).run(ROW_ID, state.version, JSON.stringify(state.weights), state.trainedCount, now);
}
