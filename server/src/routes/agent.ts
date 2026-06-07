// The brain's "main thinking" entrypoint.
//
//   POST /api/agent          SSE — triage a request, then stream either the
//                            7-step pipeline (plain question) or the agentic
//                            ReAct loop (multi-step / tool / "do X"). Frames are
//                            AgentEvent (type=...) OR PipelineEvent (step=...);
//                            a client discriminates on shape.
//   POST /api/agent/confirm  SSE — approve/deny a paused confirm-tier action and
//                            resume the loop (continues streaming).
//
// Every tool the loop runs goes through the permissioned executor; egress stays
// LOCAL_ONLY-gated. See server/src/reasoning/agentLoop.ts.

import { Router } from "express";
import { z } from "zod";
import { ulid } from "ulid";
import { CONFIG } from "../config.js";
import { runPipeline } from "../reasoning/pipeline.js";
import { getBrainState } from "../core/brainState.js";
import { triage } from "../reasoning/triage.js";
import { runAgentLoop, startAgentRun, resumeAgentRun, type AgentEmit } from "../reasoning/agentLoop.js";
import type { AgentConfirmMode, AgentEvent } from "../../../shared/agent.js";
import type { ActionRiskTier } from "../../../shared/actions.js";
import type { PipelineEvent } from "../../../shared/pipeline.js";

export const agentRouter = Router();

const riskTier = z.enum(["safe", "confirm"]);

const agentSchema = z.object({
  prompt: z.string().min(1).max(4000),
  conversationId: z.string().optional(),
  confirmMode: z.enum(["ask", "scope", "safe-only"]).optional(),
  scope: z.object({ allow: z.array(riskTier) }).optional(),
  forceLoop: z.boolean().optional(),
});

const confirmSchema = z.object({
  runId: z.string().min(1).max(120),
  approve: z.boolean(),
  grantScope: z.object({ allow: z.array(riskTier) }).optional(),
});

function openSse(res: import("express").Response): AgentEmit {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  return (frame: AgentEvent | PipelineEvent): void => {
    try {
      const name = "type" in frame ? frame.type : frame.step;
      res.write(`event: ${name}\n`);
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
    } catch {
      // Client disconnected; the loop keeps running but frames are dropped.
    }
  };
}

agentRouter.post("/agent", async (req, res) => {
  const parsed = agentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { prompt, conversationId, scope, forceLoop } = parsed.data;
  const mode: AgentConfirmMode = parsed.data.confirmMode ?? CONFIG.agentConfirmMode;
  const allow: ActionRiskTier[] = scope?.allow ?? [];

  const emit = openSse(res);
  const route = forceLoop || !CONFIG.agentTriage ? "loop" : triage(prompt);

  try {
    if (route === "pipeline") {
      await runPipelineAsAgent(prompt, conversationId, emit);
    } else {
      // COGNITIVE LOOP — perceive on the loop path too (the pipeline path
      // perceives inside runPipeline). A deep-reason tool call later closes the
      // cycle via the pipeline; a tool-only run at least holds the request.
      getBrainState().perceive(prompt);
      const run = startAgentRun({ prompt, conversationId, mode, scope: allow });
      await runAgentLoop(run, emit);
    }
  } catch (err) {
    emit({
      type: "error",
      runId: "",
      conversationId: conversationId ?? "",
      detail: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
    });
  } finally {
    res.write("event: done\ndata: {}\n\n");
    res.end();
  }
});

agentRouter.post("/agent/confirm", async (req, res) => {
  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const emit = openSse(res);
  try {
    const resumed = await resumeAgentRun(parsed.data, emit);
    if (!resumed) {
      emit({
        type: "error",
        runId: parsed.data.runId,
        conversationId: "",
        detail: "run not found or not awaiting confirmation (it may have expired)",
        timestamp: new Date().toISOString(),
      });
    }
  } catch (err) {
    emit({
      type: "error",
      runId: parsed.data.runId,
      conversationId: "",
      detail: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
    });
  } finally {
    res.write("event: done\ndata: {}\n\n");
    res.end();
  }
});

// Run the 7-step pipeline but wrap its answer as AgentEvents too, so a single
// client handler (the pet's agent stream reader) renders both routes uniformly:
// forward every PipelineEvent (region flashes; runPipeline broadcasts to the WS
// bus itself) AND surface streamed text + the final answer as AgentEvents.
async function runPipelineAsAgent(
  prompt: string,
  conversationId: string | undefined,
  emit: AgentEmit,
): Promise<void> {
  const runId = `agent-pipe-${ulid()}`;
  const convId = conversationId && conversationId.length > 0 ? conversationId : ulid();
  const stamp = (): string => new Date().toISOString();
  emit({ type: "agent-start", runId, conversationId: convId, text: prompt, timestamp: stamp() });
  let answer = "";
  await runPipeline({ prompt, conversationId }, (ev: PipelineEvent) => {
    emit(ev);
    if (ev.step === "response" && ev.status === "progress" && ev.tokensDelta) {
      emit({ type: "delta", runId, conversationId: convId, text: ev.tokensDelta, timestamp: stamp() });
    }
    if (ev.step === "learning" && ev.status === "complete" && ev.finalAnswer) {
      answer = ev.finalAnswer;
    }
  });
  emit({ type: "final", runId, conversationId: convId, text: answer || "(no answer)", timestamp: stamp() });
  emit({
    type: "metrics",
    runId,
    conversationId: convId,
    metrics: { rounds: 1, toolCalls: 0, status: "done", durationMs: 0 },
    timestamp: stamp(),
  });
}
