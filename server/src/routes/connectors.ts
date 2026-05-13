import { Router } from "express";
import { z } from "zod";
import {
  deleteConnector,
  getConnector,
  listConnectors,
  updateConnectorState,
  upsertConnector,
} from "../db/repositories/connectors.js";
import {
  getConnectorInstance,
  refreshConnector,
  reconcileDiscovered,
} from "../connectors/registry.js";
import { discoverLocalRuntimes } from "../connectors/discovery.js";
import { CONFIG } from "../config.js";
import { isLocalUrl } from "../util/network.js";

export const connectorsRouter = Router();

connectorsRouter.get("/connectors", (_req, res) => {
  res.json({ connectors: listConnectors() });
});

const upsertSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  kind: z.enum(["ollama", "openai-compatible", "huggingface", "python-script", "agent"]),
  baseUrl: z.string().url().optional(),
  model: z.string().optional(),
  embeddingModel: z.string().optional(),
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

connectorsRouter.post("/connectors", (req, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  if (CONFIG.localOnly && parsed.data.baseUrl && !isLocalUrl(parsed.data.baseUrl)) {
    res.status(400).json({
      error: "non-local URL rejected",
      detail:
        `baseUrl ${parsed.data.baseUrl} is not loopback or RFC1918. Set LOCAL_ONLY=false to allow remote connectors.`,
    });
    return;
  }
  const descriptor = upsertConnector(parsed.data);
  refreshConnector(descriptor.id);
  res.json({ connector: descriptor });
});

connectorsRouter.delete("/connectors/:id", (req, res) => {
  deleteConnector(req.params.id);
  refreshConnector(req.params.id);
  res.json({ ok: true });
});

connectorsRouter.post("/connectors/:id/test", async (req, res) => {
  const instance = getConnectorInstance(req.params.id);
  if (!instance) {
    res.status(404).json({ error: "Connector not found" });
    return;
  }
  const result = await instance.test();
  updateConnectorState(
    instance.descriptor.id,
    result.ok ? "ok" : "unreachable",
    result.ok ? null : result.message,
  );
  res.json(result);
});

// One-shot probe of every supported local runtime. Does NOT mutate DB state --
// it's safe to call from the picker UI on every refresh.
connectorsRouter.get("/connectors/discover", async (_req, res) => {
  const runtimes = await discoverLocalRuntimes();
  res.json({ runtimes });
});

// Reconciles discovered runtimes into the connector table. Called by the
// picker UI when the user wants to ensure detected runtimes have rows.
connectorsRouter.post("/connectors/reconcile", async (_req, res) => {
  const runtimes = await reconcileDiscovered();
  res.json({ runtimes, connectors: listConnectors() });
});

const selectSchema = z.object({
  // Either an existing connector id, or a discovered runtime kind (e.g. "ollama",
  // "lmstudio") in which case we upsert an auto-* row.
  connectorId: z.string().optional(),
  runtimeKind: z.string().optional(),
  baseUrl: z.string().url().optional(),
  kind: z.enum(["ollama", "openai-compatible", "huggingface", "python-script", "agent"]).optional(),
  model: z.string().min(1).optional(),
  embeddingModel: z.string().optional(),
});

connectorsRouter.post("/connectors/select", async (req, res) => {
  const parsed = selectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const input = parsed.data;
  let targetId = input.connectorId;
  // Path 1: caller knows the connectorId — flip is_default on that row.
  if (targetId) {
    const existing = getConnector(targetId);
    if (!existing) {
      res.status(404).json({ error: "Connector not found" });
      return;
    }
    if (CONFIG.localOnly && existing.baseUrl && !isLocalUrl(existing.baseUrl)) {
      res.status(400).json({ error: "non-local connector cannot be selected while LOCAL_ONLY=true" });
      return;
    }
    const updated = upsertConnector({
      id: existing.id,
      name: existing.name,
      kind: existing.kind,
      baseUrl: existing.baseUrl,
      model: input.model ?? existing.model,
      embeddingModel: input.embeddingModel ?? existing.embeddingModel,
      enabled: true,
      isDefault: true,
    });
    refreshConnector(updated.id);
    res.json({ connector: updated });
    return;
  }
  // Path 2: caller supplies a runtime kind + baseUrl — create/refresh the
  // auto-<kind> row and set it default.
  if (!input.runtimeKind || !input.baseUrl || !input.kind) {
    res.status(400).json({ error: "connectorId or (runtimeKind + baseUrl + kind) required" });
    return;
  }
  if (CONFIG.localOnly && !isLocalUrl(input.baseUrl)) {
    res.status(400).json({ error: "non-local URL rejected" });
    return;
  }
  const id = `auto-${input.runtimeKind}`;
  const existing = getConnector(id);
  const descriptor = upsertConnector({
    id,
    name: existing?.name ?? `Local ${input.runtimeKind}`,
    kind: input.kind,
    baseUrl: input.baseUrl,
    model: input.model ?? existing?.model,
    embeddingModel: input.embeddingModel ?? existing?.embeddingModel,
    enabled: true,
    isDefault: true,
  });
  refreshConnector(descriptor.id);
  res.json({ connector: descriptor });
});
