import { CONFIG } from "../config.js";
import {
  getConnector,
  getDefaultConnector,
  listConnectors,
  updateConnectorState,
  upsertConnector,
} from "../db/repositories/connectors.js";
import type { ConnectorDescriptor } from "../../../shared/connector.js";
import { Connector } from "./Connector.js";
import { OllamaConnector } from "./OllamaConnector.js";
import { OpenAICompatibleConnector } from "./OpenAICompatibleConnector.js";
import { AgentConnector, HuggingFaceConnector, PythonScriptConnector } from "./stubs.js";
import { discoverLocalRuntimes, type DiscoveredRuntime } from "./discovery.js";
import { isLocalUrl } from "../util/network.js";

const cache = new Map<string, Connector>();

// ── Circuit breaker ────────────────────────────────────────────────────────
// Tracks consecutive failures per connector. After FAILURE_THRESHOLD failures
// the circuit opens and the connector is skipped for COOLDOWN_MS.
const circuitState = new Map<string, { failures: number; openedAt: number }>();
const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 60_000;

export function circuitRecordFailure(connectorId: string): void {
  const prev = circuitState.get(connectorId) ?? { failures: 0, openedAt: 0 };
  prev.failures++;
  if (prev.failures >= FAILURE_THRESHOLD) prev.openedAt = Date.now();
  circuitState.set(connectorId, prev);
}

export function circuitRecordSuccess(connectorId: string): void {
  circuitState.delete(connectorId);
}

export function circuitIsOpen(connectorId: string): boolean {
  const s = circuitState.get(connectorId);
  if (!s || s.failures < FAILURE_THRESHOLD) return false;
  if (Date.now() - s.openedAt > COOLDOWN_MS) {
    // Cooldown expired — allow a probe attempt.
    circuitState.delete(connectorId);
    return false;
  }
  return true;
}

function instantiate(descriptor: ConnectorDescriptor): Connector {
  switch (descriptor.kind) {
    case "ollama":
      return new OllamaConnector(descriptor);
    case "openai-compatible":
      return new OpenAICompatibleConnector(descriptor);
    case "huggingface":
      return new HuggingFaceConnector(descriptor);
    case "python-script":
      return new PythonScriptConnector(descriptor);
    case "agent":
      return new AgentConnector(descriptor);
  }
}

export function getConnectorInstance(id: string): Connector | null {
  const cached = cache.get(id);
  if (cached) {
    return cached;
  }
  const descriptor = getConnector(id);
  if (!descriptor) {
    return null;
  }
  const instance = instantiate(descriptor);
  cache.set(id, instance);
  return instance;
}

export function refreshConnector(id: string): Connector | null {
  cache.delete(id);
  return getConnectorInstance(id);
}

export function listConnectorInstances(): Connector[] {
  return listConnectors().map((descriptor) => {
    const cached = cache.get(descriptor.id);
    if (cached) {
      return cached;
    }
    const instance = instantiate(descriptor);
    cache.set(descriptor.id, instance);
    return instance;
  });
}

export function getDefaultConnectorInstance(): Connector | null {
  const descriptor = getDefaultConnector();
  if (!descriptor) {
    return null;
  }
  return getConnectorInstance(descriptor.id);
}

// On first boot we want at least one connector row so the UI has something to
// show and the pipeline has a sensible default. Idempotent: if a row exists,
// we leave it alone.
export function ensureDefaultConnector(): ConnectorDescriptor {
  const existing = getDefaultConnector();
  if (existing) {
    return existing;
  }
  const descriptor = upsertConnector({
    id: "ollama-default",
    name: "Local Ollama",
    kind: "ollama",
    baseUrl: CONFIG.ollamaBaseUrl,
    model: CONFIG.ollamaChatModel,
    embeddingModel: CONFIG.ollamaEmbeddingModel,
    enabled: true,
    isDefault: true,
  });
  return descriptor;
}

// Free-tier remote providers. Seeded only when the matching API key env var is
// present, and always *disabled + non-default* so local Ollama stays the working
// default and the boot/60s auto-probe never reaches out to them (no quota burn,
// no locality-badge flip). The user opts in explicitly via the picker. Their
// hosts are the only non-local URLs allowed past the LOCAL_ONLY gate
// (see isAllowedRemoteHost). Chat-only — no embeddingModel — so retrieval keeps
// using the local 768-dim Ollama embedder and the vector index stays intact.
const REMOTE_PROVIDERS: Array<{
  id: string;
  name: string;
  baseUrl: string;
  hasKey: () => boolean;
  model: () => string;
}> = [
  {
    id: "nvidia",
    name: "NVIDIA NIM (remote)",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    // Seed when EITHER the singular key or the plural rotation pool is set.
    hasKey: () =>
      (process.env.NVIDIA_API_KEY ?? "").length > 0 ||
      (process.env.NVIDIA_API_KEYS ?? "").length > 0,
    model: () => CONFIG.nvidiaChatModel,
  },
  {
    id: "google-gemini",
    name: "Google Gemini (remote)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    hasKey: () =>
      (process.env.GEMINI_API_KEY ?? "").length > 0 ||
      (process.env.GOOGLE_AI_API_KEY ?? "").length > 0 ||
      (process.env.GEMINI_API_KEYS ?? "").length > 0 ||
      (process.env.GOOGLE_AI_API_KEYS ?? "").length > 0,
    model: () => CONFIG.geminiChatModel,
  },
];

// Idempotent. For each provider whose key is configured, ensure a connector row
// exists. Preserves a user's prior enabled/default/model choice on re-run; on
// first seed it's disabled + non-default. When no key is set we skip seeding
// entirely (and leave any pre-existing row alone rather than deleting it, so a
// transiently-missing key never drops a chosen default).
export function ensureRemoteProviderConnectors(): void {
  for (const provider of REMOTE_PROVIDERS) {
    if (!provider.hasKey()) {
      continue;
    }
    const existing = getConnector(provider.id);
    upsertConnector({
      id: provider.id,
      name: existing?.name ?? provider.name,
      kind: "openai-compatible",
      baseUrl: provider.baseUrl,
      model: existing?.model ?? provider.model(),
      embeddingModel: undefined,
      enabled: existing?.enabled ?? false,
      isDefault: existing?.isDefault ?? false,
    });
    cache.delete(provider.id);
  }
}

// The brain's OWN model (Learning Lab — Phase D). After `ollama create` imports
// the merged model, seed it as a local Ollama connector — ALWAYS *disabled +
// non-default* on first seed, so a small-corpus voice adaptation never silently
// becomes the model /api/ask uses. The user opts in via the picker. Idempotent:
// re-running preserves a prior enabled/default choice and just refreshes the
// model name. No embeddingModel → retrieval keeps using the local 768-dim
// Ollama embedder (the OllamaConnector falls back to CONFIG.ollamaEmbeddingModel),
// so the vector index stays intact.
export function ensureOwnModelConnector(modelName: string): ConnectorDescriptor {
  const id = "own-model";
  const existing = getConnector(id);
  const descriptor = upsertConnector({
    id,
    name: existing?.name ?? "Brain's own model (local)",
    kind: "ollama",
    baseUrl: CONFIG.ollamaBaseUrl,
    model: modelName,
    embeddingModel: undefined,
    enabled: existing?.enabled ?? false,
    isDefault: existing?.isDefault ?? false,
  });
  cache.delete(id);
  return descriptor;
}

export async function probeAllConnectors(): Promise<void> {
  const instances = listConnectorInstances();
  await Promise.all(
    instances.map(async (instance) => {
      // Never auto-probe non-local connectors: it would egress to remote
      // providers on every boot + 60s tick and burn free-tier quota. The user
      // tests them explicitly via POST /connectors/:id/test instead.
      if (!instance.descriptor.isLocal) {
        return;
      }
      const result = await instance.test();
      updateConnectorState(
        instance.descriptor.id,
        result.ok ? "ok" : "unreachable",
        result.ok ? null : result.message,
      );
    }),
  );
}

// Map a discovered runtime to a stable connector ID. We use one row per kind
// so reconciliation is idempotent — re-probing only updates the existing row.
function idForRuntime(runtime: DiscoveredRuntime): string {
  return `auto-${runtime.kind}`;
}

// Ollama lists embedding models (e.g. nomic-embed-text) alongside chat models,
// and `/api/tags` order is arbitrary — so `models[0]` is unsafe as the chat model
// (it may be an embed model or a multi-GB model that never finishes cold-loading).
// Pick a real chat model: honor a still-valid prior/explicit choice, then the
// configured default if it's actually installed, then a preferred small chat
// family, then any non-embed model. This is the "auto-detect the model" half of
// auto-detecting the runtime, and it auto-corrects a stale/invalid persisted model.
const CHAT_MODEL_PREFERENCE = [
  "llama3.2", "llama3.1", "llama3", "qwen2.5", "qwen3", "mistral", "phi", "gemma",
];

const isEmbedModel = (m: string): boolean => /embed/i.test(m);

function pickChatModel(models: string[], existing: string | undefined): string | undefined {
  if (models.length === 0) {
    return existing;
  }
  if (existing && models.includes(existing) && !isEmbedModel(existing)) {
    return existing;
  }
  if (models.includes(CONFIG.ollamaChatModel) && !isEmbedModel(CONFIG.ollamaChatModel)) {
    return CONFIG.ollamaChatModel;
  }
  const chat = models.filter((m) => !isEmbedModel(m));
  for (const pref of CHAT_MODEL_PREFERENCE) {
    const hit = chat.find((m) => m.toLowerCase().startsWith(pref));
    if (hit) {
      return hit;
    }
  }
  return chat[0] ?? models[0];
}

function labelForRuntime(runtime: DiscoveredRuntime): string {
  return `Local ${runtime.label}`;
}

// Walk the discovery output and bring the connector table in line:
// - newly-detected runtime → upsert a row (enabled, not default unless none exists).
// - previously-seen-but-now-gone → mark its row "unreachable" without deleting it,
//   so the user's chosen default doesn't silently disappear during a transient outage.
// Never picks a non-local connector as default.
export async function reconcileDiscovered(): Promise<DiscoveredRuntime[]> {
  const runtimes = await discoverLocalRuntimes();
  for (const runtime of runtimes) {
    if (!isLocalUrl(runtime.baseUrl)) {
      // Defense in depth: the probe table only emits 127.0.0.1, but if that
      // ever changes we still won't auto-create a remote row.
      continue;
    }
    if (runtime.state === "unreachable") {
      const existing = getConnector(idForRuntime(runtime));
      if (existing) {
        updateConnectorState(existing.id, "unreachable", runtime.message ?? null);
      }
      continue;
    }
    const id = idForRuntime(runtime);
    const existing = getConnector(id);
    const chatModel = pickChatModel(runtime.models, existing?.model);
    // Ollama: include the embedding model from CONFIG if it's in the list.
    const embeddingModel =
      runtime.kind === "ollama"
        ? runtime.models.find((m) => m === CONFIG.ollamaEmbeddingModel) ?? CONFIG.ollamaEmbeddingModel
        : undefined;
    upsertConnector({
      id,
      name: labelForRuntime(runtime),
      kind: runtime.connectorKind,
      baseUrl: runtime.baseUrl,
      model: chatModel,
      embeddingModel: existing?.embeddingModel ?? embeddingModel,
      enabled: existing?.enabled ?? true,
      isDefault: existing?.isDefault ?? false,
    });
    cache.delete(id);
    updateConnectorState(id, "ok", null);
  }
  // If nothing is marked as default yet, promote the first detected runtime.
  // Prefer Ollama when present (native embeddings + faster streaming).
  const allConnectors = listConnectors();
  const anyDefault = allConnectors.some((c) => c.isDefault && c.enabled);
  if (!anyDefault) {
    const okRuntimes = runtimes.filter((r) => r.state === "ok" && isLocalUrl(r.baseUrl));
    const preferred = okRuntimes.find((r) => r.kind === "ollama") ?? okRuntimes[0];
    if (preferred) {
      const id = idForRuntime(preferred);
      const existing = getConnector(id);
      if (existing) {
        upsertConnector({
          id,
          name: existing.name,
          kind: existing.kind,
          baseUrl: existing.baseUrl,
          model: existing.model,
          embeddingModel: existing.embeddingModel,
          enabled: true,
          isDefault: true,
        });
        cache.delete(id);
      }
    }
  }
  return runtimes;
}
