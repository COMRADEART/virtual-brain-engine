import { Router } from "express";
import { z } from "zod";
import { getCognitiveSwarm } from "../core/swarm.js";

export const swarmRouter = Router();

const taskSchema = z.object({
  goal: z.string().min(1).max(800),
  requiredCapabilities: z.array(z.string().min(1)).min(1).max(12),
  priority: z.number().min(0).max(100).optional(),
  privacyMode: z.enum(["local-first", "offline-only", "hybrid-allowed", "cloud-allowed"]).optional(),
  payload: z.record(z.unknown()).optional(),
});

const workflowSchema = z.object({
  goal: z.string().min(1).max(800),
  includeExecution: z.boolean().optional(),
  privacyMode: z.enum(["local-first", "offline-only", "hybrid-allowed", "cloud-allowed"]).optional(),
  priority: z.number().min(0).max(100).optional(),
  payload: z.record(z.unknown()).optional(),
});

const consensusSchema = z.object({
  question: z.string().min(1).max(800),
  taskId: z.string().optional(),
});

const capabilitySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  category: z.enum(["memory", "execution", "reasoning", "tool", "observer", "simulation", "ui", "context", "reflection", "evolution", "organism"]),
  cost: z.number().min(0).max(1).optional().default(0.35),
  requiresNetwork: z.boolean().optional().default(false),
  permissions: z.array(z.string()).optional().default([]),
  modelProfile: z.string().optional(),
});

const nodeSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(160),
  organ: z.string().min(1).max(160),
  type: z.enum(["memory", "execution", "reasoning", "tool", "observer", "simulation", "ui", "context", "reflection", "evolution", "organism"]),
  location: z.enum(["local", "remote", "cloud", "worker"]),
  mode: z.enum(["offline", "hybrid", "isolated-secure", "cloud-assisted"]),
  trust: z.enum(["system", "trusted", "sandboxed", "untrusted"]),
  capabilities: z.array(capabilitySchema).min(1).max(32),
  permissions: z.array(z.string()).optional().default([]),
  modelProfile: z.string().optional(),
  endpoint: z.string().optional(),
  health: z.enum(["healthy", "degraded", "offline"]).optional(),
});

swarmRouter.get("/swarm", (_req, res) => {
  res.json(getCognitiveSwarm().snapshot());
});

swarmRouter.post("/swarm/nodes", (req, res) => {
  const parsed = nodeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const node = getCognitiveSwarm().registerNode(parsed.data);
  res.json({ node, snapshot: getCognitiveSwarm().snapshot() });
});

swarmRouter.post("/swarm/tasks", (req, res) => {
  const parsed = taskSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const task = getCognitiveSwarm().enqueueTask(parsed.data);
  res.json({ task, snapshot: getCognitiveSwarm().snapshot() });
});

swarmRouter.post("/swarm/workflows", (req, res) => {
  const parsed = workflowSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const swarm = getCognitiveSwarm();
  const tasks = swarm.routeCognitiveWorkflow(parsed.data.goal, parsed.data.payload, {
    includeExecution: parsed.data.includeExecution,
    privacyMode: parsed.data.privacyMode,
    priority: parsed.data.priority,
  });
  res.json({ tasks, snapshot: swarm.snapshot() });
});

swarmRouter.post("/swarm/consensus", (req, res) => {
  const parsed = consensusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const round = getCognitiveSwarm().runConsensus(parsed.data.question, parsed.data.taskId);
  res.json({ round, snapshot: getCognitiveSwarm().snapshot() });
});
