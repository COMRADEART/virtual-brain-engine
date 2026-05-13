import { Router } from "express";
import { z } from "zod";
import type { PipelineEvent } from "../../../shared/pipeline.js";
import { runPipeline } from "../reasoning/pipeline.js";

export const askRouter = Router();

const askSchema = z.object({
  prompt: z.string().min(1).max(4000),
  conversationId: z.string().optional(),
});

askRouter.post("/ask", async (req, res) => {
  const parsed = askSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const writeEvent = (event: PipelineEvent): void => {
    try {
      res.write(`event: ${event.step}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      // Client disconnected; pipeline will keep running but events are dropped.
    }
  };

  try {
    await runPipeline(
      { prompt: parsed.data.prompt, conversationId: parsed.data.conversationId },
      writeEvent,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeEvent({
      conversationId: parsed.data.conversationId ?? "",
      runId: "",
      step: "input",
      status: "error",
      logicalRegions: [],
      detail: message,
      timestamp: new Date().toISOString(),
    });
  } finally {
    res.write("event: done\ndata: {}\n\n");
    res.end();
  }
});
