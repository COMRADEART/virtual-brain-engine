// Phase 4 — explicit usefulness verdicts on the new surfaces. A memory verdict
// says "this surfaced memory was/ wasn't useful" (the route nudges its
// importance); an action verdict says "this resolved command was/ wasn't the
// right one" (resolver-training dataset). Both accumulate here for the Learning
// Lab's usage summary.

import { ulid } from "ulid";
import { openDb } from "../sqlite.js";

export type UsageFeedbackKind = "memory" | "action";

export function recordUsageFeedback(
  kind: UsageFeedbackKind,
  targetId: string,
  rating: 1 | -1,
): void {
  const db = openDb();
  db.prepare(
    `INSERT INTO usage_feedback (id, kind, target_id, rating, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(ulid(), kind, targetId, rating, new Date().toISOString());
}

export interface UsageFeedbackTally {
  memory: { up: number; down: number };
  action: { up: number; down: number };
}

export function usageFeedbackStats(): UsageFeedbackTally {
  const db = openDb();
  const rows = db
    .prepare<[], { kind: string; rating: number; c: number }>(
      `SELECT kind, rating, count(*) AS c FROM usage_feedback GROUP BY kind, rating`,
    )
    .all();
  const tally: UsageFeedbackTally = { memory: { up: 0, down: 0 }, action: { up: 0, down: 0 } };
  for (const row of rows) {
    const bucket = row.kind === "memory" ? tally.memory : row.kind === "action" ? tally.action : null;
    if (!bucket) continue;
    if (row.rating > 0) bucket.up += row.c;
    else bucket.down += row.c;
  }
  return tally;
}
