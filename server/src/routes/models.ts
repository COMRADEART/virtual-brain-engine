// Model Hub (Phase: "download a model → wire it into the brain"). Mounted /api:
//   GET  /api/models             → base + chat model + installed + suggested + pull state
//   POST /api/models/pull {name} → start a streaming `ollama pull` (single in-flight)
//   GET  /api/models/pull/status → current pull state
//   POST /api/models/select {name} → set an installed model as the CHAT model
//
// CHAT models only (embedding model is fixed — see shared/models.ts). Pull
// progress streams over the bus (THROTTLED) and flashes the `model-hub` cortex.
// On success the model is RECONCILED in (available/selectable) but NOT made
// default — the user picks it explicitly via /select.

import { Router } from "express";
import { z } from "zod";
import { broadcast } from "../ws/brainBus.js";
import { PullProgress, listOllamaModels, pullModel, resolveOllamaBaseUrl } from "../connectors/ollamaModels.js";
import { probeAllConnectors, reconcileDiscovered, refreshConnector } from "../connectors/registry.js";
import { getDefaultConnector, listConnectors, upsertConnector } from "../db/repositories/connectors.js";
import { surfaceError } from "../util/diagnostics.js";
import type { ModelPullState, ModelsView, SuggestedModel } from "../../../shared/models.js";

export const modelsRouter = Router();

const SUGGESTED: SuggestedModel[] = [
  { name: "qwen2.5:0.5b", label: "Qwen2.5 0.5B", note: "Tiny + fast — great for quick commands." },
  { name: "llama3.2:3b", label: "Llama 3.2 3B", note: "Balanced default chat model." },
  { name: "qwen2.5:3b", label: "Qwen2.5 3B", note: "Strong small all-rounder." },
  { name: "phi3.5", label: "Phi-3.5", note: "Capable reasoning at ~3.8B." },
  { name: "gemma2:2b", label: "Gemma 2 2B", note: "Compact Google model." },
  { name: "llama3.1:8b", label: "Llama 3.1 8B", note: "Bigger — needs more RAM/VRAM." },
];

function idleState(): ModelPullState {
  return { active: false, model: null, status: "", percent: null, done: false, error: null, startedAt: null, finishedAt: null };
}
let pull: ModelPullState = idleState();

function chatModelOf(): string | null {
  return getDefaultConnector()?.model ?? null;
}

modelsRouter.get("/models", async (_req, res) => {
  const base = resolveOllamaBaseUrl();
  let installed: string[] = [];
  if (base) {
    try {
      installed = await listOllamaModels(base);
    } catch (err) {
      surfaceError("models:list", err);
    }
  }
  const view: ModelsView = { base, chatModel: chatModelOf(), installed, suggested: SUGGESTED, pull };
  res.json(view);
});

modelsRouter.get("/models/pull/status", (_req, res) => {
  res.json(pull);
});

const pullSchema = z.object({ name: z.string().min(1).max(200) });
modelsRouter.post("/models/pull", (req, res) => {
  const parsed = pullSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  if (pull.active) {
    res.status(409).json({ error: "a model pull is already in progress", pull });
    return;
  }
  const base = resolveOllamaBaseUrl();
  if (!base) {
    res.status(400).json({ error: "no local Ollama daemon reachable" });
    return;
  }
  const name = parsed.data.name;
  pull = { active: true, model: name, status: "starting", percent: null, done: false, error: null, startedAt: new Date().toISOString(), finishedAt: null };

  // Throttle bus emits so a multi-GB pull can't flood the WS: only emit when
  // >=300ms have passed AND the 5% bucket changed, or on a forced (done/error)
  // tick. Mirrors the throttle discipline in util/diagnostics.ts.
  let lastEmit = 0;
  let lastBucket = -1;
  const emit = (force = false): void => {
    const now = Date.now();
    const bucket = pull.percent === null ? -1 : Math.floor(pull.percent * 20);
    if (!force && now - lastEmit < 300 && bucket === lastBucket) {
      return;
    }
    lastEmit = now;
    lastBucket = bucket;
    try {
      broadcast({ type: "model-pull", model: name, status: pull.status, percent: pull.percent, done: pull.done, timestamp: new Date().toISOString() });
    } catch {
      /* bus not attached (CLI/selfcheck) */
    }
  };

  void (async () => {
    const progress = new PullProgress();
    try {
      await pullModel(base, name, (line) => {
        progress.update(line);
        pull = { ...pull, status: progress.status || pull.status, percent: progress.percent(), error: progress.error };
        emit();
      });
      if (progress.error) {
        pull = { ...pull, active: false, done: false, error: progress.error, finishedAt: new Date().toISOString() };
      } else {
        pull = { ...pull, active: false, done: true, percent: 1, status: "success", finishedAt: new Date().toISOString() };
        // Make the model AVAILABLE/selectable — NOT default. The user opts in
        // via /models/select.
        await reconcileDiscovered()
          .then(() => probeAllConnectors())
          .catch((err) => surfaceError("models:reconcile", err));
      }
    } catch (err) {
      surfaceError("models:pull", err);
      pull = { ...pull, active: false, done: false, error: err instanceof Error ? err.message : String(err), finishedAt: new Date().toISOString() };
    }
    emit(true);
  })();

  res.json({ ok: true, pull });
});

// Select an installed model as the CHAT model (default connector's `model`).
// Embedding model is intentionally untouched.
const selectSchema = z.object({ name: z.string().min(1).max(200) });
modelsRouter.post("/models/select", (req, res) => {
  const parsed = selectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const def = getDefaultConnector();
  const target = def && def.kind === "ollama" ? def : listConnectors().find((c) => c.kind === "ollama");
  if (!target) {
    res.status(400).json({ error: "no Ollama connector to assign the model to" });
    return;
  }
  const updated = upsertConnector({
    id: target.id,
    name: target.name,
    kind: target.kind,
    baseUrl: target.baseUrl,
    model: parsed.data.name,
    embeddingModel: target.embeddingModel,
    enabled: true,
    isDefault: true,
  });
  refreshConnector(updated.id);
  res.json({ ok: true, connector: updated });
});
