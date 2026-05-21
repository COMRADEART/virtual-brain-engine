import { Router } from "express";
import { z } from "zod";
import { getPersistentOrganism } from "../core/organism.js";

export const organismRouter = Router();

const goalSchema = z.object({
  title: z.string().min(1).max(240),
  priority: z.number().min(0).max(100).optional(),
  dependencies: z.array(z.string().min(1).max(160)).max(12).optional(),
  subgoals: z.array(z.string().min(1).max(160)).max(18).optional(),
  blockers: z.array(z.string().min(1).max(160)).max(12).optional(),
  confidence: z.number().min(0).max(1).optional(),
  estimatedCompletionAt: z.string().optional(),
});

const goalUpdateSchema = z.object({
  goalId: z.string().min(1),
  status: z.enum(["active", "blocked", "paused", "completed", "abandoned"]).optional(),
  progress: z.number().min(0).max(1).optional(),
  blockers: z.array(z.string().min(1).max(160)).max(12).optional(),
  confidence: z.number().min(0).max(1).optional(),
  attempt: z
    .object({
      summary: z.string().min(1).max(1000),
      outcome: z.enum(["unknown", "success", "failed", "partial"]),
    })
    .optional(),
});

const researchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  hypothesis: z.string().min(1).max(1000).optional(),
});

const subBrainSchema = z.object({
  name: z.string().min(1).max(160),
  specialization: z.string().min(1).max(400),
  inheritedMemoryScopes: z.array(z.string().min(1).max(120)).max(8).optional(),
  inheritedSkills: z.array(z.string().min(1).max(120)).max(8).optional(),
});

organismRouter.get("/organism", (_req, res) => {
  res.json(getPersistentOrganism().snapshot());
});

organismRouter.post("/organism/wake", (_req, res) => {
  res.json({ snapshot: getPersistentOrganism().wake() });
});

organismRouter.post("/organism/goals", (req, res) => {
  const parsed = goalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    res.json(getPersistentOrganism().createGoal(parsed.data));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

organismRouter.post("/organism/goals/update", (req, res) => {
  const parsed = goalUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    res.json(getPersistentOrganism().updateGoal(parsed.data));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

organismRouter.post("/organism/maintenance", (_req, res) => {
  res.json(getPersistentOrganism().runMaintenance());
});

organismRouter.post("/organism/dream", (_req, res) => {
  res.json(getPersistentOrganism().dream());
});

organismRouter.post("/organism/research", (req, res) => {
  const parsed = researchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  res.json(getPersistentOrganism().runResearch(parsed.data));
});

organismRouter.post("/organism/subbrains", (req, res) => {
  const parsed = subBrainSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    res.json(getPersistentOrganism().reproduce(parsed.data));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
