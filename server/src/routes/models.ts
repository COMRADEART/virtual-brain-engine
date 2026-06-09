// Model Hub (Phase: "download a model → wire it into the brain"). Mounted /api:
//   GET  /api/models             → base + chat model + installed + suggested + pull state + remote providers
//   POST /api/models/pull {name} → start a streaming `ollama pull` (single in-flight)
//   GET  /api/models/pull/status → current pull state
//   POST /api/models/select {name} → set an installed model as the CHAT model
//   POST /api/models/select-remote {connectorId, model} → set a remote model as the CHAT model
//   POST /api/models/remote/refresh → force-refresh cached remote model lists
//
// CHAT models only (embedding model is fixed — see shared/models.ts). Pull
// progress streams over the bus (THROTTLED) and flashes the `model-hub` cortex.
// On success the model is RECONCILED in (available/selectable) but NOT made
// default — the user picks it explicitly via /select.

import { Router } from "express";
import { z } from "zod";
import { broadcast } from "../ws/brainBus.js";
import { PullProgress, listOllamaModels, pullModel, resolveOllamaBaseUrl } from "../connectors/ollamaModels.js";
import { getConnectorInstance, probeAllConnectors, reconcileDiscovered, refreshConnector } from "../connectors/registry.js";
import { getDefaultConnector, getConnector, listConnectors, upsertConnector } from "../db/repositories/connectors.js";
import { setAvailableModels } from "../reasoning/modelRouting.js";
import { surfaceError } from "../util/diagnostics.js";
import { getModelUsage, getModelPerformanceStats, getRoutingInsights, getKeyStats, getConfidenceCalibration, getSearchQuality, getConnectorHealth } from "../db/repositories/modelUsage.js";
import type { ModelPullState, ModelsView, RemoteProviderModel, SuggestedModel } from "../../../shared/models.js";

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

// --- Remote model list cache (TTL: 5 min) -----------------------------------
// Avoids burning free-tier quota every time the Model Hub is opened.

const REMOTE_CACHE_TTL_MS = 5 * 60_000;
interface RemoteCacheEntry {
  models: string[];
  fetchedAt: number;
}
const remoteModelCache = new Map<string, RemoteCacheEntry>();

function getCachedRemoteModels(connectorId: string): string[] | null {
  const entry = remoteModelCache.get(connectorId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > REMOTE_CACHE_TTL_MS) {
    remoteModelCache.delete(connectorId);
    return null;
  }
  return entry.models;
}

function setCachedRemoteModels(connectorId: string, models: string[]): void {
  remoteModelCache.set(connectorId, { models, fetchedAt: Date.now() });
}

function clearRemoteModelCache(): void {
  remoteModelCache.clear();
}

// --- Remote provider listing with timeout + cache ----------------------------

const LIST_MODELS_TIMEOUT_MS = 8_000;

async function listRemoteProviders(): Promise<RemoteProviderModel[]> {
  const connectors = listConnectors().filter(
    (c) => c.enabled && !c.isLocal && c.kind === "openai-compatible",
  );
  const results = await Promise.all(
    connectors.map(async (c) => {
      const instance = getConnectorInstance(c.id);
      if (!instance) {
        return { id: c.id, name: c.name, baseUrl: c.baseUrl ?? "", models: [], currentModel: c.model ?? null, error: "connector not found" };
      }
      // Return cached models when available
      const cached = getCachedRemoteModels(c.id);
      if (cached) {
        return { id: c.id, name: c.name, baseUrl: c.baseUrl ?? "", models: cached, currentModel: c.model ?? null, error: null };
      }
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), LIST_MODELS_TIMEOUT_MS);
        const models = await instance.listModels(controller.signal);
        clearTimeout(timer);
        setCachedRemoteModels(c.id, models);
        return { id: c.id, name: c.name, baseUrl: c.baseUrl ?? "", models, currentModel: c.model ?? null, error: null };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isAbort = msg.includes("abort") || msg.includes("timeout");
        return { id: c.id, name: c.name, baseUrl: c.baseUrl ?? "", models: [], currentModel: c.model ?? null, error: isAbort ? "timeout" : msg };
      }
    }),
  );
  return results;
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
  const remoteProviders = await listRemoteProviders();

  // Wire the MoE router: merge local + remote model IDs so per-profile
  // assignments actually resolve (pickModel checks against this set).
  const allModels = [...installed];
  for (const rp of remoteProviders) {
    for (const m of rp.models) {
      if (!allModels.includes(m)) allModels.push(m);
    }
  }
  setAvailableModels(allModels);

  const view: ModelsView = { base, chatModel: chatModelOf(), installed, suggested: SUGGESTED, pull, remoteProviders };
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

// Select a model on a remote provider connector (e.g. NVIDIA NIM).
// This sets the connector's model AND makes it the default (active) connector.
// Validates the model exists on the provider before accepting.
const selectRemoteSchema = z.object({ connectorId: z.string().min(1), model: z.string().min(1).max(200) });
modelsRouter.post("/models/select-remote", (req, res) => {
  const parsed = selectRemoteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const existing = getConnector(parsed.data.connectorId);
  if (!existing) {
    res.status(404).json({ error: "connector not found" });
    return;
  }
  // Validate model exists in the cached remote list
  const cached = getCachedRemoteModels(parsed.data.connectorId);
  if (cached && cached.length > 0 && !cached.includes(parsed.data.model)) {
    res.status(400).json({
      error: "model not found on this provider",
      available: cached,
    });
    return;
  }
  const updated = upsertConnector({
    id: existing.id,
    name: existing.name,
    kind: existing.kind,
    baseUrl: existing.baseUrl,
    model: parsed.data.model,
    embeddingModel: existing.embeddingModel,
    enabled: true,
    isDefault: true,
  });
  refreshConnector(updated.id);
  clearRemoteModelCache();
  res.json({ ok: true, connector: updated });
});

// Force-refresh cached remote model lists (for the Model Hub refresh button).
modelsRouter.post("/models/remote/refresh", async (_req, res) => {
  clearRemoteModelCache();
  const remoteProviders = await listRemoteProviders();
  res.json({ ok: true, remoteProviders });
});

// Model usage telemetry: recent runs with model, provider, latency, fallback.
modelsRouter.get("/models/usage", (_req, res) => {
  const usage = getModelUsage(20);
  res.json(usage);
});

// Model performance stats: per-model aggregation for the dashboard.
modelsRouter.get("/models/stats", (req, res) => {
  const days = req.query.days ? Number(req.query.days) : undefined;
  const stats = getModelPerformanceStats(days && days > 0 ? days : undefined);
  res.json(stats);
});

// Routing insights: per-profile quality scores and reassignment suggestions.
modelsRouter.get("/models/routing-insights", (_req, res) => {
  const insights = getRoutingInsights();
  res.json(insights);
});

// Per-key latency and error stats for rotation visibility.
modelsRouter.get("/models/key-stats", (_req, res) => {
  const stats = getKeyStats();
  res.json(stats);
});

// Confidence calibration: self-assessed confidence vs actual citation usage.
modelsRouter.get("/models/calibration", (_req, res) => {
  const calibration = getConfidenceCalibration();
  res.json(calibration);
});

// Search quality: retrieved vs cited counts and citation rate.
modelsRouter.get("/models/search-quality", (_req, res) => {
  const quality = getSearchQuality();
  res.json(quality);
});

// Connector health: error rates and latency per connector from usage_log.
modelsRouter.get("/models/connector-health", (_req, res) => {
  const health = getConnectorHealth();
  res.json(health);
});

// Compare specific models by their usage stats.
modelsRouter.get("/models/compare", (req, res) => {
  const modelsParam = req.query.models as string | undefined;
  if (!modelsParam) { res.status(400).json({ error: "models query param required" }); return; }
  const modelNames = modelsParam.split(",").map((s) => s.trim()).filter(Boolean);
  if (modelNames.length === 0) { res.status(400).json({ error: "at least one model name required" }); return; }
  const allStats = getModelPerformanceStats();
  const comparison = modelNames.map((name) => {
    const stat = allStats.models.find((s) => s.model === name);
    return stat ?? { model: name, runs: 0, avgLatencyMs: 0, minLatencyMs: 0, maxLatencyMs: 0, errors: 0, errorRate: 0, fallbackRate: 0, avgStepTimings: {} };
  });
  res.json(comparison);
});
