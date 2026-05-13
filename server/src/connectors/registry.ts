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

export async function probeAllConnectors(): Promise<void> {
  const instances = listConnectorInstances();
  await Promise.all(
    instances.map(async (instance) => {
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
    const firstModel = runtime.models[0];
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
      model: existing?.model ?? firstModel,
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
