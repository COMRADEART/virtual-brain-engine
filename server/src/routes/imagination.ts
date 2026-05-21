import { Router } from "express";
import { z } from "zod";
import { getImaginationEngine } from "../core/imagination.js";

export const imaginationRouter = Router();

const simulateSchema = z.object({
  goal: z.string().min(1).max(1000),
  action: z.string().min(1).max(1000).optional(),
  mode: z.enum(["future-prediction", "workflow-rehearsal", "mental-sandbox", "dream-consolidation"]).optional(),
  branchCount: z.number().int().min(3).max(5).optional(),
  context: z.record(z.unknown()).optional(),
});

const reflectionSchema = z.object({
  sessionId: z.string().min(1),
  futureId: z.string().min(1),
  actualSummary: z.string().min(1).max(2000),
  ok: z.boolean(),
  actualDurationMs: z.number().min(0).optional(),
  actualRisk: z.number().min(0).max(1).optional(),
  sideEffects: z
    .object({
      gitChanges: z.number().min(0).optional(),
      diskWrites: z.number().min(0).optional(),
      memoryWrites: z.number().min(0).optional(),
      dependencyChanges: z.number().min(0).optional(),
      rollbackComplexity: z.number().min(0).max(1).optional(),
    })
    .optional(),
});

imaginationRouter.get("/imagination", (_req, res) => {
  res.json(getImaginationEngine().snapshot());
});

imaginationRouter.post("/imagination/simulate", (req, res) => {
  const parsed = simulateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const session = getImaginationEngine().imagine(parsed.data);
    res.json({ session, snapshot: getImaginationEngine().snapshot() });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

imaginationRouter.post("/imagination/reflect", (req, res) => {
  const parsed = reflectionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const reflection = getImaginationEngine().reflect(parsed.data);
    res.json({ reflection, snapshot: getImaginationEngine().snapshot() });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

imaginationRouter.post("/imagination/dream", (_req, res) => {
  const abstractions = getImaginationEngine().dream();
  res.json({ abstractions, snapshot: getImaginationEngine().snapshot() });
});
