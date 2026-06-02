// Permissioned command/action layer (Phase 3). Mounted under /api:
//   GET  /api/actions          → the allowlisted action specs (for the UI).
//   POST /api/actions/resolve  → NL prompt → ActionPlan (no execution).
//   POST /api/actions/execute  → run a plan (+ confirm token for confirm-tier).
//   GET  /api/actions/log      → recent audited attempts.
//
// The POST routes inherit the global X-Brain-Local header guard from index.ts.

import { Router } from "express";
import { z } from "zod";
import { listActionSpecs } from "../actions/registry.js";
import { resolveAction } from "../actions/resolver.js";
import { executeAction } from "../actions/executor.js";
import { listActionLog } from "../db/repositories/actions.js";

export const actionsRouter = Router();

actionsRouter.get("/actions", (_req, res) => {
  res.json({ actions: listActionSpecs() });
});

const resolveSchema = z.object({ prompt: z.string().min(1).max(2000) });
actionsRouter.post("/actions/resolve", async (req, res) => {
  const parsed = resolveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const result = await resolveAction(parsed.data.prompt);
  res.json(result);
});

const executeSchema = z.object({
  actionId: z.string().min(1),
  args: z.record(z.unknown()).optional(),
  confirmToken: z.string().optional(),
});
actionsRouter.post("/actions/execute", async (req, res) => {
  const parsed = executeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { actionId, args, confirmToken } = parsed.data;
  const { status, ...body } = await executeAction({ actionId, args: args ?? {}, confirmToken });
  res.status(status).json(body);
});

actionsRouter.get("/actions/log", (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  res.json({ log: listActionLog(limit) });
});
