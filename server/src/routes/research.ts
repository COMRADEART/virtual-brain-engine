// Deep Research route — POST /api/research/deep (SSE).
//
// Drives the deep-research engine and streams DeepResearchEvent frames to the
// caller while ALSO broadcasting bare PipelineEvent frames onto the WS bus, so
// the 3D brain flashes its cortices live exactly like /api/ask and /api/agent.
// The engine is hermetic (injected deps); this route is where the real connector,
// embedder, vector search, egress-gated webResearch, reranker state, and memory
// upsert are wired in. Egress stays LOCAL_ONLY-gated inside webResearch — on a
// local-only box the engine degrades to a local-memory-only report.

import { Router } from "express";
import { z } from "zod";
import { ulid } from "ulid";
import { CONFIG } from "../config.js";
import { runDeepResearch, clampResearchOpts, type DeepResearchDeps, type DeepResearchEmit } from "../reasoning/deepResearch.js";
import { getDefaultConnectorInstance, resolveEmbedFn } from "../connectors/registry.js";
import { vectorSearch, upsertMemoryPoint } from "../db/repositories/memory.js";
import { webResearch } from "../web/research.js";
import { loadRerankerState } from "../db/repositories/adaptive.js";
import { broadcast } from "../ws/brainBus.js";
import { surfaceError } from "../util/diagnostics.js";
import type { GenerateFn } from "../reasoning/queryExpansion.js";
import type { DeepResearchEvent } from "../../../shared/research.js";
import type { LogicalRegionId, PipelineStatus, PipelineStepId } from "../../../shared/pipeline.js";

export const researchRouter = Router();

const deepSchema = z.object({
  question: z.string().min(1).max(4000),
  conversationId: z.string().max(120).optional(),
  maxRounds: z.number().int().min(1).max(5).optional(),
  breadth: z.number().int().min(1).max(8).optional(),
  maxPages: z.number().int().min(1).max(10).optional(),
});

function openSse(res: import("express").Response): (frame: DeepResearchEvent) => void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  return (frame: DeepResearchEvent): void => {
    try {
      res.write(`event: ${frame.type}\n`);
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
    } catch {
      // client disconnected; the run keeps going but frames are dropped
    }
  };
}

// Map a research stage onto the 3D brain's logical cortices (the SAME frames
// BrainScene already flashes for /api/ask). report-delta is intentionally not
// broadcast (too frequent — it streams the report token by token).
function flashFor(
  ev: DeepResearchEvent,
): { step: PipelineStepId; status: PipelineStatus; regions: LogicalRegionId[]; detail?: string } | null {
  switch (ev.type) {
    case "research-start":
      return { step: "input", status: "start", regions: ["reasoning-cortex"], detail: "deep research" };
    case "plan":
      return {
        step: "reasoning",
        status: "progress",
        regions: ["reasoning-cortex"],
        detail: `round ${ev.round}: ${ev.subQuestions.length} sub-questions`,
      };
    case "gather":
      return {
        step: "memory",
        status: "progress",
        regions: ["memory-core", "file-memory"],
        detail: `${ev.localHits} local · ${ev.webHits} web${ev.provider ? ` (${ev.provider})` : ""}`,
      };
    case "synthesize":
      return { step: "reasoning", status: "progress", regions: ["reasoning-cortex", "response-center"] };
    case "reflect":
      return {
        step: "error",
        status: "progress",
        regions: ["error-detection-center"],
        detail: ev.converged ? "converged" : `${ev.gaps.length} gaps`,
      };
    case "report":
      return {
        step: "learning",
        status: "complete",
        regions: ["response-center", "learning-feedback-center"],
        detail: `${ev.report.sources.length} sources · ${ev.report.rounds} rounds`,
      };
    case "error":
      return { step: "response", status: "error", regions: ["error-detection-center"], detail: ev.detail };
    default:
      return null;
  }
}

// Trust model: this is a DELIBERATE user-initiated route (like POST /api/web/research
// and /api/ingest/web), gated by the global X-Brain-Local header middleware (index.ts)
// and — for the web half — by LOCAL_ONLY inside webResearch. It is NOT confirm-token
// gated; the confirm-tier gate lives on the `deep-research` ACTION path (registry +
// executeAction), which is the door the autonomous agent loop must use. A direct call
// here is the human asking for research, so it needs no per-plan confirm token.
researchRouter.post("/research/deep", async (req, res) => {
  const parsed = deepSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  if (!CONFIG.deepResearchEnabled) {
    res.status(403).json({ error: "deep research is disabled (set DEEP_RESEARCH_ENABLED=true)" });
    return;
  }

  const { question, conversationId } = parsed.data;
  const cid = conversationId ?? "";
  // Resolve the (already zod-range-validated) options against the operator
  // CONFIG ceilings — a user value above the configured ceiling pulls down to
  // it; an omitted value defaults to the ceiling. The engine re-clamps to its
  // own hard absolute safety net.
  const { maxRounds, breadth, maxPages } = clampResearchOpts(parsed.data, {
    maxRounds: CONFIG.deepResearchMaxRounds,
    breadth: CONFIG.deepResearchBreadth,
    maxPages: CONFIG.deepResearchMaxPages,
  });
  const runId = ulid();
  const sse = openSse(res);

  // SSE to the caller + a cortex flash on the WS bus for every meaningful stage.
  const emit: DeepResearchEmit = (ev) => {
    sse(ev);
    const f = flashFor(ev);
    if (!f) return;
    try {
      broadcast({
        type: "pipeline",
        conversationId: cid,
        runId,
        step: f.step,
        status: f.status,
        logicalRegions: f.regions,
        detail: f.detail,
        timestamp: ev.timestamp,
      });
    } catch (err) {
      surfaceError("research.broadcast", err);
    }
  };

  try {
    const connector = getDefaultConnectorInstance();
    if (!connector) {
      emit({ type: "error", detail: "no chat model is configured", timestamp: new Date().toISOString() });
      return;
    }
    const embed = resolveEmbedFn();
    if (!embed) {
      emit({ type: "error", detail: "no embedder available — deep research needs vector retrieval", timestamp: new Date().toISOString() });
      return;
    }

    const generate: GenerateFn = (system, user) => connector.send(user, { system, temperature: 0.3 });
    const stream = (system: string, user: string): AsyncIterable<string> =>
      connector.stream(user, { system, temperature: 0.4 });

    const deps: DeepResearchDeps = {
      generate,
      stream,
      embed,
      vectorSearch: (e, l) => vectorSearch(e, l),
      webResearch: (q, o) => webResearch(q, o),
      rerankerState: loadRerankerState(),
      localOnly: CONFIG.localOnly,
      upsert: upsertMemoryPoint,
    };

    await runDeepResearch(question, deps, { maxRounds, breadth, maxPages, conversationId: cid }, emit);
  } catch (err) {
    // runDeepResearch never throws, but guard the wiring (connector/embed lookups).
    emit({ type: "error", detail: err instanceof Error ? err.message : String(err), timestamp: new Date().toISOString() });
  } finally {
    res.write("event: done\ndata: {}\n\n");
    res.end();
  }
});
