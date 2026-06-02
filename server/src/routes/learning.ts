// Learning Lab routes — surface the brain's OWN learning (Phase B) and drive
// the from-scratch LLM trainer (Phase C).
//
//   GET  /api/learning/status      ranker warm-up + labelled weights + loss
//                                  curve + feedback stats + LLM trainer status
//   GET  /api/learning/llm/status  just the from-scratch trainer status
//   POST /api/learning/llm/start   assemble the memory corpus + kick training

import { Router } from "express";
import { z } from "zod";
import type { LearningStatus } from "../../../shared/learning.js";
import { loadRankerLossHistory, loadRankerState } from "../db/repositories/ranker.js";
import { getFeedbackStats } from "../db/repositories/feedback.js";
import { FEATURE_LABELS, FEATURE_VERSION, zeroWeights } from "../reasoning/rankerModel.js";
import { WARM_AT } from "../reasoning/ranker.js";
import { getLlmTrainerStatus, startLlmTraining } from "../learning/llmTrainerClient.js";
import { getUsageSummary } from "../learning/usage.js";

export const learningRouter = Router();

learningRouter.get("/learning/status", async (_req, res) => {
  const s = loadRankerState();
  const weights = s?.weights ?? zeroWeights();
  const trainedCount = s?.trainedCount ?? 0;
  const status: LearningStatus = {
    ranker: {
      version: s?.version ?? FEATURE_VERSION,
      trainedCount,
      warmAt: WARM_AT,
      alpha: Math.min(1, trainedCount / WARM_AT),
      warm: trainedCount >= WARM_AT,
      weights: weights.map((w, i) => ({ label: FEATURE_LABELS[i] ?? `w${i}`, weight: w })),
    },
    loss: loadRankerLossHistory(100),
    feedback: getFeedbackStats(),
    llm: await getLlmTrainerStatus(),
    usage: getUsageSummary(),
  };
  res.json(status);
});

learningRouter.get("/learning/llm/status", async (_req, res) => {
  res.json(await getLlmTrainerStatus());
});

const startSchema = z.object({
  steps: z.number().int().min(1).max(100_000).optional(),
  force: z.boolean().optional(),
});

learningRouter.post("/learning/llm/start", async (req, res) => {
  const parsed = startSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  res.json(await startLlmTraining(parsed.data));
});
