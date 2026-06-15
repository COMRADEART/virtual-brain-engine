// Learning Lab routes — surface the brain's OWN learning (Phase B) and drive
// the from-scratch LLM trainer (Phase C).
//
//   GET  /api/learning/status      ranker warm-up + labelled weights + loss
//                                  curve + feedback stats + LLM trainer status
//   GET  /api/learning/llm/status  just the from-scratch trainer status
//   POST /api/learning/llm/start   assemble the memory corpus + kick training
//   POST /api/learning/llm/generate  sample from the persisted brain model

import { Router } from "express";
import { z } from "zod";
import type { LearningStatus } from "../../../shared/learning.js";
import { loadRankerLossHistory, loadRankerState } from "../db/repositories/ranker.js";
import { getFeedbackStats } from "../db/repositories/feedback.js";
import { FEATURE_LABELS, FEATURE_VERSION, zeroWeights } from "../reasoning/rankerModel.js";
import { WARM_AT } from "../reasoning/ranker.js";
import {
  ensureLlmTrainingWatcher,
  generateFromScratchLlm,
  getLlmTrainerStatus,
  startLlmTraining,
} from "../learning/llmTrainerClient.js";
import {
  getOwnModelStatus,
  serveOwnModel,
  startOwnModelTraining,
} from "../learning/ownModelClient.js";
import { generateWithAirllm, getAirllmStatus } from "../learning/airllmClient.js";
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
  const status = await startLlmTraining(parsed.data);
  if (status.state === "running") {
    // Stream progress to the UI's TrainingBar over the WS bus.
    ensureLlmTrainingWatcher();
  }
  res.json(status);
});

const generateSchema = z.object({
  prompt: z.string().max(4000).optional(),
  maxNewTokens: z.number().int().min(1).max(2000).optional(),
  temperature: z.number().gt(0).max(2).optional(),
});

learningRouter.post("/learning/llm/generate", async (req, res) => {
  const parsed = generateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  res.json(await generateFromScratchLlm(parsed.data));
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
  // Distill the corpus through a high-parameter AirLLM teacher first (slow,
  // opt-in). teacherModel overrides CONFIG.airllmTeacherModel for this run.
  distill: z.boolean().optional(),
  teacherModel: z.string().min(1).max(200).optional(),
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

// --- AirLLM: high-parameter inference on a small GPU (layer-by-layer) --------
//   GET  /api/learning/airllm/status    engine state (model / compression / device)
//   POST /api/learning/airllm/generate  run the high-parameter model (slow)
// Inference-only; the same model doubles as the mango distillation teacher via
// the ownmodel/start { distill } path above.
learningRouter.get("/learning/airllm/status", async (_req, res) => {
  res.json(await getAirllmStatus());
});

const airllmGenerateSchema = z
  .object({
    prompt: z.string().min(1).max(8000),
    model: z.string().min(1).max(200).optional(),
    maxNewTokens: z.number().int().min(1).max(2048).optional(),
    compression: z.enum(["4bit", "8bit", "off"]).optional(),
  })
  .strict();

learningRouter.post("/learning/airllm/generate", async (req, res) => {
  const parsed = airllmGenerateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  res.json(await generateWithAirllm(parsed.data));
});
