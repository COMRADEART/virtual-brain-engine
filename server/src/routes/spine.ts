// The spinal cord — the brain↔body conduit (descending intents + afferent
// feedback), with reflex / motor-program / deliberate tracts and the Hermes
// task queue.
//
//   GET  /api/spine/state           the full status surface (queue, recent
//                                    commands, reflexes, personas, tract counts).
//   GET  /api/spine/personas         the motor pools (OpenClaw personas).
//   GET  /api/spine/reflexes         built-in + custom reflex arcs.
//   POST /api/spine/reflexes         register a custom reflex ({name, triggers,
//                                    actionId, argParam?}). REFUSES any non-safe
//                                    target (a reflex fires without confirmation).
//   DELETE /api/spine/reflexes/:id   remove a custom reflex.
//   GET  /api/spine/tasks            the queue (pending) + recent commands.
//   POST /api/spine/dispatch         SSE — send ONE descending intent down the
//                                    cord; streams spine/agent/pipeline frames.
//   POST /api/spine/enqueue          queue a descending drive (priority/policy).
//   POST /api/spine/tick             work the queue now (the runtime check).
//
// The deliberate tract reuses the agent loop's confirm flow: if it pauses for a
// confirm-tier action (ask mode) it emits a `confirm-request` frame and the
// client resumes via the EXISTING POST /api/agent/confirm (the run is parked in
// the agent loop's own store by id). The spine adds no new privilege — every
// effector call still goes through the permissioned executor.

import { Router } from "express";
import { z } from "zod";
import { CONFIG } from "../config.js";
import { getSpine, type SpineFrame } from "../spine/cord.js";
import { listReflexes, registerReflex, removeReflex } from "../spine/reflexes.js";
import { listPersonas } from "../spine/personas.js";
import type { AgentConfirmMode } from "../../../shared/agent.js";
import type { ActionRiskTier } from "../../../shared/actions.js";

export const spineRouter = Router();

const riskTier = z.enum(["safe", "confirm"]);

const dispatchSchema = z.object({
  intent: z.string().min(1).max(4000),
  personaId: z.enum(["courier", "scribe", "mechanic", "scholar", "connector", "reflex"]).optional(),
  confirmMode: z.enum(["ask", "scope", "safe-only"]).optional(),
  scope: z.object({ allow: z.array(riskTier) }).optional(),
  priority: z.number().optional(),
  origin: z.string().max(40).optional(),
});

const reflexSchema = z.object({
  name: z.string().max(80).optional(),
  triggers: z.array(z.string().min(1).max(120)).min(1).max(20),
  actionId: z.string().min(1).max(60),
  argParam: z.string().min(1).max(40).optional(),
  description: z.string().max(240).optional(),
});

function openSse(res: import("express").Response): (frame: SpineFrame) => void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  return (frame: SpineFrame): void => {
    try {
      const name = "type" in frame ? frame.type : frame.step;
      res.write(`event: ${name}\n`);
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
    } catch {
      // Client disconnected; the cord keeps running but frames are dropped.
    }
  };
}

spineRouter.get("/spine/state", (_req, res) => {
  res.json(getSpine().snapshot());
});

spineRouter.get("/spine/personas", (_req, res) => {
  res.json({ personas: listPersonas() });
});

spineRouter.get("/spine/reflexes", (_req, res) => {
  res.json({ reflexes: listReflexes() });
});

spineRouter.post("/spine/reflexes", (req, res) => {
  const parsed = reflexSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const result = registerReflex(parsed.data);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ reflex: result.arc });
});

spineRouter.delete("/spine/reflexes/:id", (req, res) => {
  const removed = removeReflex(req.params.id);
  if (!removed) {
    res.status(404).json({ error: "no such custom reflex (built-ins cannot be removed)" });
    return;
  }
  res.json({ removed: true });
});

spineRouter.get("/spine/tasks", (_req, res) => {
  const snap = getSpine().snapshot();
  res.json({ pending: snap.pending, recent: snap.recent, queueDepth: snap.queueDepth });
});

spineRouter.post("/spine/dispatch", async (req, res) => {
  const parsed = dispatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const mode: AgentConfirmMode = parsed.data.confirmMode ?? CONFIG.agentConfirmMode;
  const scope: ActionRiskTier[] = parsed.data.scope?.allow ?? [];
  const emit = openSse(res);
  try {
    await getSpine().dispatch(
      {
        intent: parsed.data.intent,
        personaId: parsed.data.personaId,
        mode,
        scope,
        priority: parsed.data.priority,
        origin: parsed.data.origin ?? "route",
      },
      emit,
    );
  } catch (err) {
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n\n`);
    } catch {
      /* client gone */
    }
  } finally {
    res.write("event: done\ndata: {}\n\n");
    res.end();
  }
});

spineRouter.post("/spine/enqueue", (req, res) => {
  const parsed = dispatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const mode: AgentConfirmMode = parsed.data.confirmMode ?? "safe-only";
  const cmd = getSpine().enqueue({
    intent: parsed.data.intent,
    personaId: parsed.data.personaId,
    mode,
    scope: parsed.data.scope?.allow ?? [],
    priority: parsed.data.priority,
    origin: parsed.data.origin ?? "queue",
  });
  res.json({ command: cmd });
});

spineRouter.post("/spine/tick", async (_req, res) => {
  const ran = await getSpine().tick();
  res.json({ ran, snapshot: getSpine().snapshot() });
});
