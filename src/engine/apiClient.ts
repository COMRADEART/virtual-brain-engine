// Thin typed wrapper around the local /api surface. Same goal as ollamaClient.ts
// but pointed at our Express server (default http://127.0.0.1:8787).

import type { ConnectorDescriptor } from "../../shared/connector";
import type {
  Conversation,
  ConversationMessage,
  MemoryPoint,
  MemoryRelation,
  MemorySourceType,
} from "../../shared/memory";
import type { PipelineEvent } from "../../shared/pipeline";

export interface DiscoveredRuntime {
  kind: "ollama" | "lmstudio" | "llamacpp" | "jan" | "gpt4all" | "vllm" | "tgi";
  label: string;
  baseUrl: string;
  state: "ok" | "ok-no-model" | "unreachable";
  models: string[];
  embedsAvailable: boolean;
  connectorKind: ConnectorDescriptor["kind"];
  message?: string;
}

// Tauri v2 dropped window.__TAURI__; the canonical detection is the
// __TAURI_INTERNALS__ injection. We also accept the public isTauri() helper
// when it loads. Module-level cache so we don't re-probe on every API call.
function inTauri(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const w = window as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  return Boolean(w.__TAURI_INTERNALS__ ?? w.__TAURI__);
}

async function invokeTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  // Lazy import so the @tauri-apps/api dependency only loads when actually
  // running under Tauri.
  const mod = (await import("@tauri-apps/api/core")) as {
    invoke: <R>(cmd: string, a?: Record<string, unknown>) => Promise<R>;
  };
  return mod.invoke<T>(command, args);
}

function getBaseUrl(): string {
  const fromEnv = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_BRAIN_API_URL;
  if (fromEnv) {
    return fromEnv.replace(/\/$/, "");
  }
  return "http://127.0.0.1:8787";
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "content-type": "application/json", "X-Brain-Local": "1", ...(init?.headers ?? {}) },
      ...init,
    });
  } catch (err) {
    throw new ApiError(0, err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(res.status, text || res.statusText);
  }
  return (await res.json()) as T;
}

export interface HealthResponse {
  db: "ok" | "error";
  vector: "ok" | "unavailable";
  memoryCount: number;
  connectors: Array<{
    id: string;
    kind: ConnectorDescriptor["kind"];
    state: ConnectorDescriptor["state"];
    enabled: boolean;
    isDefault?: boolean;
    isLocal: boolean;
    baseUrl?: string;
  }>;
  // "local" when every enabled connector has a loopback/RFC1918 baseUrl (or no
  // baseUrl). "remote" when at least one enabled connector points off-machine.
  locality: "local" | "remote";
}

export const apiClient = {
  health(): Promise<HealthResponse> {
    return json<HealthResponse>("/api/health");
  },

  listConnectors(): Promise<{ connectors: ConnectorDescriptor[] }> {
    return json<{ connectors: ConnectorDescriptor[] }>("/api/connectors");
  },

  testConnector(id: string): Promise<{ ok: boolean; message?: string; models?: string[] }> {
    return json(`/api/connectors/${encodeURIComponent(id)}/test`, { method: "POST" });
  },

  searchMemory(query: string, opts: { limit?: number; kind?: MemorySourceType; project?: string } = {}): Promise<{
    hits: Array<{ score: number; matchType: "vector" | "keyword" | "hybrid"; memory: MemoryPoint }>;
    vectorError?: string;
  }> {
    const params = new URLSearchParams({ q: query });
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.kind) params.set("kind", opts.kind);
    if (opts.project) params.set("project", opts.project);
    return json(`/api/memory/search?${params.toString()}`);
  },

  recentMemories(limit = 20, kind?: MemorySourceType): Promise<{ memories: MemoryPoint[] }> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (kind) params.set("kind", kind);
    return json(`/api/memory/recent?${params.toString()}`);
  },

  getMemory(id: string): Promise<{ memory: MemoryPoint; relations: MemoryRelation[] }> {
    return json(`/api/memory/${encodeURIComponent(id)}`);
  },

  triggerScan(): Promise<{ ok: boolean }> {
    return json(`/api/scan/run`, { method: "POST" });
  },

  discoverRuntimes(): Promise<{ runtimes: DiscoveredRuntime[] }> {
    // In Tauri, prefer the Rust-side probe -- it bypasses browser CORS, which
    // would otherwise block fetches to non-:8787 ports from a normal renderer.
    // The Node fallback is used in pure-web (Vite dev) mode.
    if (inTauri()) {
      return invokeTauri<{ runtimes: DiscoveredRuntime[] }>("probe_local_llms");
    }
    return json<{ runtimes: DiscoveredRuntime[] }>(`/api/connectors/discover`);
  },

  reconcileConnectors(): Promise<{ runtimes: DiscoveredRuntime[]; connectors: ConnectorDescriptor[] }> {
    return json(`/api/connectors/reconcile`, { method: "POST" });
  },

  selectConnector(input: {
    connectorId?: string;
    runtimeKind?: string;
    baseUrl?: string;
    kind?: ConnectorDescriptor["kind"];
    model?: string;
    embeddingModel?: string;
  }): Promise<{ connector: ConnectorDescriptor }> {
    return json(`/api/connectors/select`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  scanState(): Promise<{
    state: {
      running: boolean;
      processed: number;
      total: number;
      skipped: number;
      current: string | null;
      startedAt: string | null;
      finishedAt: string | null;
      lastError: string | null;
    };
  }> {
    return json(`/api/scan/state`);
  },

  listConversations(): Promise<{ conversations: Conversation[] }> {
    return json(`/api/conversations`);
  },

  getConversation(id: string): Promise<{ conversationId: string; messages: ConversationMessage[] }> {
    return json(`/api/conversations/${encodeURIComponent(id)}`);
  },

  // POST /api/ask returns SSE. We parse "event:" + "data:" blocks and yield
  // each pipeline event as it arrives.
  async *ask(input: { prompt: string; conversationId?: string }, signal?: AbortSignal): AsyncGenerator<PipelineEvent> {
    const res = await fetch(`${getBaseUrl()}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", "X-Brain-Local": "1" },
      body: JSON.stringify(input),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new ApiError(res.status, await res.text().catch(() => res.statusText));
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let sep = buffer.indexOf("\n\n");
        while (sep >= 0) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const eventLine = block.split("\n").find((l) => l.startsWith("event:"));
          const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) {
            sep = buffer.indexOf("\n\n");
            continue;
          }
          if (eventLine?.includes("done")) {
            return;
          }
          try {
            const payload = JSON.parse(dataLine.slice(5).trim()) as PipelineEvent;
            yield payload;
          } catch {
            // skip malformed
          }
          sep = buffer.indexOf("\n\n");
        }
      }
    } finally {
      reader.releaseLock();
    }
  },
};

export function brainApiBaseUrl(): string {
  return getBaseUrl();
}
