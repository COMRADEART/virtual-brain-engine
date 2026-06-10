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
import {
  getOwnModelStatus,
  serveOwnModel,
  startOwnModelTraining,
} from "../learning/ownModelClient.js";
import { getUsageSummary } from "../learning/usage.js";
import { countSftPairs, exportSftJsonl } from "../db/repositories/sft.js";

export const learningRouter = Router();

// --- SFT pair flywheel (Phase D follow-on) ----------------------------------
// Every 👍-rated answer accrues here as an {instruction, response} pair so a
// future LoRA pass can do REAL instruction SFT once enough pairs exist.

learningRouter.get("/learning/sft/status", (_req, res) => {
  res.json({ pairs: countSftPairs() });
});

learningRouter.get("/learning/sft/export", (_req, res) => {
  res.setHeader("Content-Type", "application/jsonl; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="brain-sft-pairs.jsonl"');
  res.send(exportSftJsonl());
});

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

// --- Phase D: the brain's OWN model (LoRA continued-pretraining → Ollama) ---
//   GET  /api/learning/ownmodel/status  own-model trainer status
//   POST /api/learning/ownmodel/start   assemble the corpus + kick LoRA CPT
//   POST /api/learning/ownmodel/serve   import the merged model into Ollama +
//                                        seed an opt-in connector
learningRouter.get("/learning/ownmodel/status", async (_req, res) => {
  res.json(await getOwnModelStatus());
});

const startOwnModelSchema = z.object({
  steps: z.number().int().min(1).max(100_000).optional(),
  baseModel: z.string().min(1).max(200).optional(),
  force: z.boolean().optional(),
});

learningRouter.post("/learning/ownmodel/start", async (req, res) => {
  const parsed = startOwnModelSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  res.json(await startOwnModelTraining(parsed.data));
});

learningRouter.post("/learning/ownmodel/serve", async (_req, res) => {
  res.json(await serveOwnModel());
});
