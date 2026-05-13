// Parallel probe of every supported local LLM runtime. Each entry in PROBES
// is content-checked (not just status-checked) so a random web server on the
// same port can't produce a false positive.
//
// Shared with the Tauri Rust side (src-tauri/src/commands.rs) -- if you change
// the probe table here, port the change there too.

import type { ConnectorKind } from "../../../shared/connector.js";

export type DiscoveredRuntimeKind =
  | "ollama"
  | "lmstudio"
  | "llamacpp"
  | "jan"
  | "gpt4all"
  | "vllm"
  | "tgi";

export interface DiscoveredRuntime {
  kind: DiscoveredRuntimeKind;
  label: string;
  baseUrl: string;
  // "ok" — runtime is up and has at least one model loaded.
  // "ok-no-model" — runtime is up but the model list is empty (LM Studio with
  // no model loaded). UI should prompt the user to load one.
  // "unreachable" — TCP refused, timeout, or content check failed.
  state: "ok" | "ok-no-model" | "unreachable";
  models: string[];
  // True when the runtime's OpenAI-compat surface (or native API) exposes an
  // embeddings endpoint. False for GPT4All-HTTP. Drives the embeddings
  // fallback chain in the pipeline.
  embedsAvailable: boolean;
  // Which connector kind should be used to talk to this runtime. Ollama keeps
  // its native OllamaConnector; everything else uses the unified
  // openai-compatible connector.
  connectorKind: ConnectorKind;
  message?: string;
}

interface ProbeConfig {
  kind: DiscoveredRuntimeKind;
  label: string;
  port: number;
  connectorKind: ConnectorKind;
  embedsAvailable: boolean;
  probe: (baseUrl: string, signal: AbortSignal) => Promise<{ models: string[]; ok: boolean; message?: string }>;
}

const PROBE_TIMEOUT_MS = 200;

async function probeOllama(
  baseUrl: string,
  signal: AbortSignal,
): Promise<{ models: string[]; ok: boolean; message?: string }> {
  // Ollama's signature probe: GET / returns the literal "Ollama is running".
  // This is the only runtime with an unambiguous magic-string root response.
  const root = await fetch(`${baseUrl}/`, { signal });
  if (!root.ok) {
    return { models: [], ok: false, message: `Ollama root returned ${root.status}` };
  }
  const text = await root.text();
  if (!text.includes("Ollama is running")) {
    return { models: [], ok: false, message: "Ollama signature missing" };
  }
  const tags = await fetch(`${baseUrl}/api/tags`, { signal });
  if (!tags.ok) {
    return { models: [], ok: true, message: `Ollama up but /api/tags returned ${tags.status}` };
  }
  const data = (await tags.json()) as { models?: Array<{ name?: string }> };
  const models = (data.models ?? []).map((m) => m.name ?? "").filter(Boolean);
  return { models, ok: true };
}

async function probeOpenAIShape(
  baseUrl: string,
  signal: AbortSignal,
): Promise<{ models: string[]; ok: boolean; message?: string }> {
  const res = await fetch(`${baseUrl}/v1/models`, { signal });
  if (!res.ok) {
    return { models: [], ok: false, message: `Status ${res.status}` };
  }
  const data = (await res.json()) as { object?: string; data?: Array<{ id?: string }> };
  if (data.object !== "list" || !Array.isArray(data.data)) {
    return { models: [], ok: false, message: "Not an OpenAI-shape response" };
  }
  const models = data.data.map((m) => m.id ?? "").filter(Boolean);
  return { models, ok: true };
}

async function probeLlamaCpp(
  baseUrl: string,
  signal: AbortSignal,
): Promise<{ models: string[]; ok: boolean; message?: string }> {
  const health = await fetch(`${baseUrl}/health`, { signal });
  if (!health.ok) {
    return { models: [], ok: false, message: `/health returned ${health.status}` };
  }
  const body = (await health.json().catch(() => ({}))) as { status?: string };
  if (body.status !== "ok") {
    return { models: [], ok: false, message: `/health status=${body.status ?? "missing"}` };
  }
  return probeOpenAIShape(baseUrl, signal);
}

async function probeTgi(
  baseUrl: string,
  signal: AbortSignal,
): Promise<{ models: string[]; ok: boolean; message?: string }> {
  const info = await fetch(`${baseUrl}/info`, { signal });
  if (!info.ok) {
    return { models: [], ok: false, message: `/info returned ${info.status}` };
  }
  return probeOpenAIShape(baseUrl, signal);
}

async function probeVllm(
  baseUrl: string,
  signal: AbortSignal,
): Promise<{ models: string[]; ok: boolean; message?: string }> {
  const health = await fetch(`${baseUrl}/health`, { signal });
  if (!health.ok) {
    return { models: [], ok: false, message: `/health returned ${health.status}` };
  }
  return probeOpenAIShape(baseUrl, signal);
}

const PROBES: ProbeConfig[] = [
  { kind: "ollama", label: "Ollama", port: 11434, connectorKind: "ollama", embedsAvailable: true, probe: probeOllama },
  { kind: "lmstudio", label: "LM Studio", port: 1234, connectorKind: "openai-compatible", embedsAvailable: true, probe: probeOpenAIShape },
  { kind: "llamacpp", label: "llama.cpp", port: 8080, connectorKind: "openai-compatible", embedsAvailable: true, probe: probeLlamaCpp },
  { kind: "jan", label: "Jan", port: 1337, connectorKind: "openai-compatible", embedsAvailable: true, probe: probeOpenAIShape },
  { kind: "gpt4all", label: "GPT4All", port: 4891, connectorKind: "openai-compatible", embedsAvailable: false, probe: probeOpenAIShape },
  { kind: "vllm", label: "vLLM", port: 8000, connectorKind: "openai-compatible", embedsAvailable: true, probe: probeVllm },
  { kind: "tgi", label: "TGI", port: 3000, connectorKind: "openai-compatible", embedsAvailable: false, probe: probeTgi },
];

export async function discoverLocalRuntimes(): Promise<DiscoveredRuntime[]> {
  const settled = await Promise.allSettled(
    PROBES.map(async (config): Promise<DiscoveredRuntime> => {
      const baseUrl = `http://127.0.0.1:${config.port}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      try {
        const result = await config.probe(baseUrl, controller.signal);
        if (!result.ok) {
          return {
            kind: config.kind,
            label: config.label,
            baseUrl,
            state: "unreachable",
            models: [],
            embedsAvailable: false,
            connectorKind: config.connectorKind,
            message: result.message,
          };
        }
        return {
          kind: config.kind,
          label: config.label,
          baseUrl,
          state: result.models.length > 0 ? "ok" : "ok-no-model",
          models: result.models,
          embedsAvailable: config.embedsAvailable,
          connectorKind: config.connectorKind,
        };
      } catch (err) {
        const aborted = err instanceof Error && err.name === "AbortError";
        return {
          kind: config.kind,
          label: config.label,
          baseUrl,
          state: "unreachable",
          models: [],
          embedsAvailable: false,
          connectorKind: config.connectorKind,
          message: aborted ? "timeout" : err instanceof Error ? err.message : String(err),
        };
      } finally {
        clearTimeout(timeout);
      }
    }),
  );

  return settled.map((entry, index) => {
    if (entry.status === "fulfilled") {
      return entry.value;
    }
    const config = PROBES[index];
    return {
      kind: config.kind,
      label: config.label,
      baseUrl: `http://127.0.0.1:${config.port}`,
      state: "unreachable" as const,
      models: [],
      embedsAvailable: false,
      connectorKind: config.connectorKind,
      message: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
    };
  });
}
