// Routes for the daemon registry.
//
//   GET    /api/daemon                list all daemons + counts
//   POST   /api/daemon/confirm        mint a plan-bound confirm token
//   POST   /api/daemon/create         register a new daemon
//   POST   /api/daemon/delete         idempotent remove
//   POST   /api/daemon/pause          flip status → paused
//   POST   /api/daemon/resume         flip status → running
//
// All CRUD ops are the same surface exposed by the permissioned action layer
// (`daemon-list` / `daemon-create` / `daemon-delete` / `daemon-pause` /
// `daemon-resume`). The route is a thin pass-through that returns a shape
// tailored for the Mind panel — the action layer is the trust boundary the
// agent loop + Tauri shell speak to. Ponytail: ONE handler file, no
// duplication of validation. `POST /api/daemon/confirm` mints the
// plan-bound token the UI hands the user with the "create this daemon?"
// prompt — same `mintConfirmToken` the agent loop's resolver uses.

import { Router } from "express";
import { z } from "zod";
import { executeAction } from "../actions/executor.js";
import { mintConfirmToken } from "../actions/confirmTokens.js";
import { listDaemons, daemonCounts } from "../daemon/registry.js";

export const daemonRouter = Router();

const triggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("watch"), path: z.string().min(1).max(1024), pattern: z.enum(["any", "created", "modified", "deleted"]) }),
  z.object({ kind: z.literal("schedule"), everyMinutes: z.number().int().min(1).max(60 * 24 * 7).optional(), runAt: z.string().datetime().optional() }),
  z.object({ kind: z.literal("event"), event: z.string().min(1).max(128) }),
]);

const createSchema = z
  .object({
    title: z.string().min(1).max(200),
    trigger: triggerSchema,
    action: z.object({ id: z.string().min(1), args: z.record(z.unknown()).optional() }),
    autonomy: z.enum(["ask", "scope", "safe-only"]).optional(),
    cooldownMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional(),
    confirmToken: z.string().optional(),
  })
  .strict();

const idSchema = z.object({ id: z.string().min(1), confirmToken: z.string().optional() }).strict();

daemonRouter.get("/daemon", async (_req, res) => {
  res.json({ daemons: listDaemons(), counts: daemonCounts() });
});

// Mint a plan-bound confirm token for the daemon CRUD surface. The UI
// presents "you about to create this daemon" → on accept, re-POSTs
// `/api/daemon/{create,delete,pause,resume}` with the token. The token is
// bound to (actionId, args) so a leaked token is useless for a different
// plan — same `mintConfirmToken` the resolver uses.
daemonRouter.post("/daemon/confirm", (req, res) => {
  const body = (req.body ?? {}) as { actionId?: string; args?: Record<string, unknown> };
  const actionId = body.actionId;
  if (actionId !== "daemon-create" && actionId !== "daemon-delete" && actionId !== "daemon-pause" && actionId !== "daemon-resume") {
    res.status(400).json({ error: `unsupported actionId: ${String(actionId)}` });
    return;
  }
  const token = mintConfirmToken(actionId, body.args ?? {});
  res.json({ confirmToken: token });
});

daemonRouter.post("/daemon/create", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { confirmToken, ...rest } = parsed.data;
  const result = await executeAction({
    actionId: "daemon-create",
    args: rest,
    confirmToken,
  });
  res.status(result.status).json(result);
});

daemonRouter.post("/daemon/delete", async (req, res) => {
  const parsed = idSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { confirmToken, id } = parsed.data;
  const result = await executeAction({
    actionId: "daemon-delete",
    args: { id },
    confirmToken,
  });
  res.status(result.status).json(result);
});

daemonRouter.post("/daemon/pause", async (req, res) => {
  const parsed = idSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { confirmToken, id } = parsed.data;
  const result = await executeAction({
    actionId: "daemon-pause",
    args: { id },
    confirmToken,
  });
  res.status(result.status).json(result);
});

daemonRouter.post("/daemon/resume", async (req, res) => {
  const parsed = idSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { confirmToken, id } = parsed.data;
  const result = await executeAction({
    actionId: "daemon-resume",
    args: { id },
    confirmToken,
  });
  res.status(result.status).json(result);
});
