import { Router } from "express";
import { z } from "zod";
import { getCognitiveEvolutionEngine } from "../core/evolution.js";
import { optimizeRankerFromLog } from "../core/evolutionOptimizer.js";

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

// GENUINE measured evolution: evolve the learned ranker weights against the
// brain's own labelled citation data and promote a challenger ONLY on a strict
// held-out win behind the safety gate. Body is optional; optimizeRankerFromLog
// never throws (returns reason:"error" on any internal failure).
const optimizeRankerSchema = z.object({
  seed: z.number().int().optional(),
  generations: z.number().int().min(1).max(5000).optional(),
  lambda: z.number().int().min(1).max(512).optional(),
  sigma: z.number().positive().max(8).optional(),
  minSamples: z.number().int().min(1).max(100000).optional(),
});

evolutionRouter.post("/evolution/optimize-ranker", (req, res) => {
  const parsed = optimizeRankerSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    res.json(optimizeRankerFromLog(parsed.data));
  } catch (err) {
    // Defensive: optimizeRankerFromLog already swallows its own errors, but the
    // route stays robust regardless.
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
