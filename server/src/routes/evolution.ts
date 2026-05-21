import { Router } from "express";
import { z } from "zod";
import { getCognitiveEvolutionEngine } from "../core/evolution.js";

export const evolutionRouter = Router();

const componentKindSchema = z.enum([
  "workflow",
  "skill",
  "reasoning-strategy",
  "memory-model",
  "planner",
  "tool-router",
  "execution-graph",
  "architecture",
  "identity-trait",
  "cognitive-region",
]);

const mutateWorkflowSchema = z.object({
  workflowId: z.string().min(1).optional(),
  name: z.string().min(1).max(160).optional(),
  goal: z.string().min(1).max(1000),
  steps: z.array(z.string().min(1).max(160)).min(1).max(8).optional(),
});

const evolveSkillSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  goal: z.string().min(1).max(1000).optional(),
  sourceSkills: z.array(z.string().min(1).max(120)).min(1).max(6).optional(),
});

const benchmarkStrategiesSchema = z.object({
  goal: z.string().min(1).max(1000).optional(),
});

const experimentSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  targetKind: componentKindSchema.optional(),
  hypothesis: z.string().min(1).max(1000).optional(),
});

evolutionRouter.get("/evolution", (_req, res) => {
  res.json(getCognitiveEvolutionEngine().snapshot());
});

evolutionRouter.post("/evolution/evaluate", (_req, res) => {
  res.json({ snapshot: getCognitiveEvolutionEngine().evaluate() });
});

evolutionRouter.post("/evolution/mutate-workflow", (req, res) => {
  const parsed = mutateWorkflowSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    res.json(getCognitiveEvolutionEngine().mutateWorkflow(parsed.data));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

evolutionRouter.post("/evolution/evolve-skill", (req, res) => {
  const parsed = evolveSkillSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    res.json(getCognitiveEvolutionEngine().evolveSkill(parsed.data));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

evolutionRouter.post("/evolution/benchmark-strategies", (req, res) => {
  const parsed = benchmarkStrategiesSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  res.json(getCognitiveEvolutionEngine().benchmarkStrategies(parsed.data));
});

evolutionRouter.post("/evolution/experiment", (req, res) => {
  const parsed = experimentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  res.json(getCognitiveEvolutionEngine().runExperiment(parsed.data));
});

evolutionRouter.post("/evolution/identity", (_req, res) => {
  res.json(getCognitiveEvolutionEngine().evolveIdentity());
});
