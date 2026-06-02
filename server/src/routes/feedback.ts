// POST /api/feedback — explicit 👍/👎 on an answer (Learning Lab — Phase A).
//
// Turns the user's verdict into training signal:
//   1. retrains the online ranker against the SAME feature vectors that
//      produced the answer's ranking (reconstructed from rank_training_log);
//   2. nudges the importance of the memories the answer cited (+/- delta);
//   3. records the verdict so the Learning Lab can show 👍/👎 stats.
//
// Every step is best-effort and independent: a missing training snapshot (e.g.
// feedback on a very old run that's been pruned) still records the verdict.

import { Router } from "express";
import { z } from "zod";
import {
  getFeedbackStats,
  insertFeedback,
  loadRankTrainingLog,
} from "../db/repositories/feedback.js";
import { loadRankerState } from "../db/repositories/ranker.js";
import { trainFromFeedback } from "../reasoning/ranker.js";
import { getMemoryPoint } from "../db/repositories/memory.js";
import { updateMemoryImportance } from "../memory/memoryLifecycle.js";
import { applyActionFeedback, applyMemoryFeedback } from "../learning/usage.js";
import { broadcast } from "../ws/brainBus.js";

export const feedbackRouter = Router();

// How much a single 👍/👎 moves a cited memory's importance. Small — feedback
// is one weak signal among many; we never want one click to dominate.
const IMPORTANCE_DELTA = 0.05;

const feedbackSchema = z.object({
  runId: z.string().min(1),
  rating: z.union([z.literal(1), z.literal(-1)]),
  comment: z.string().max(1000).optional(),
  conversationId: z.string().optional(),
});

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

feedbackRouter.post("/feedback", (req, res) => {
  const parsed = feedbackSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { runId, rating, comment, conversationId } = parsed.data;

  let trained = false;
  let citedCount = 0;
  const snapshot = loadRankTrainingLog(runId);
  if (snapshot) {
    citedCount = snapshot.citedIds.size;
    trained = trainFromFeedback(snapshot.featuresById, snapshot.citedIds, rating);
    // Reinforce (+1) or penalise (-1) the memories the answer leaned on.
    for (const id of snapshot.citedIds) {
      try {
        const mem = getMemoryPoint(id);
        if (mem) {
          updateMemoryImportance(id, clamp01(mem.importance + rating * IMPORTANCE_DELTA));
        }
      } catch (err) {
        console.warn("[feedback] importance update failed:", err);
      }
    }
  }

  insertFeedback({ runId, rating, comment, conversationId });
  const feedback = getFeedbackStats();
  const trainedCount = loadRankerState()?.trainedCount ?? 0;
  try {
    broadcast({
      type: "learning-update",
      feedback: { up: feedback.up, down: feedback.down, total: feedback.total },
      trainedCount,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.warn("[feedback] broadcast failed:", err);
  }

  res.json({ ok: true, trained, citedCount, feedback });
});

// Phase 4 — usefulness verdicts on the new surfaces. A memory verdict nudges
// that memory's importance (a live ranker feature, so it shapes future
// retrieval); an action verdict is recorded as resolver-training data. Both
// feed the Learning Lab usage summary.
const memoryFeedbackSchema = z.object({
  memoryId: z.string().min(1),
  rating: z.union([z.literal(1), z.literal(-1)]),
});
feedbackRouter.post("/feedback/memory", (req, res) => {
  const parsed = memoryFeedbackSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const result = applyMemoryFeedback(parsed.data.memoryId, parsed.data.rating);
  if (!result) {
    res.status(404).json({ error: "memory not found" });
    return;
  }
  res.json({ ok: true, importance: result.importance });
});

const actionFeedbackSchema = z.object({
  actionId: z.string().min(1),
  rating: z.union([z.literal(1), z.literal(-1)]),
});
feedbackRouter.post("/feedback/action", (req, res) => {
  const parsed = actionFeedbackSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  applyActionFeedback(parsed.data.actionId, parsed.data.rating);
  res.json({ ok: true });
});
