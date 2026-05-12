// Thin client for a local Ollama daemon (default http://localhost:11434).
//
// Ollama is plain HTTP, so this is just fetch with NDJSON streaming. We expose
// three calls used by the AI Companion panel:
//   - listModels()          → GET /api/tags
//   - chatStream(...)       → POST /api/chat (NDJSON stream, on-token callback)
//   - chatJson(...)         → POST /api/chat with format:"json" (single shot,
//                              returns the parsed JSON content)
//
// Errors are normalised into OllamaError with a category so the UI can show a
// helpful hint instead of "Failed to fetch".

export type OllamaErrorKind =
  | "unreachable" // network refused / TypeError from fetch
  | "cors" // 403 forbidden — most often OLLAMA_ORIGINS missing the dev URL
  | "not-found" // 404 — model not pulled, or wrong base URL
  | "bad-response" // 5xx or malformed stream
  | "aborted"; // caller aborted the request

export class OllamaError extends Error {
  readonly kind: OllamaErrorKind;
  readonly status?: number;

  constructor(kind: OllamaErrorKind, message: string, status?: number) {
    super(message);
    this.name = "OllamaError";
    this.kind = kind;
    this.status = status;
  }
}

export interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OllamaModelInfo {
  name: string;
  size: number;
  modifiedAt: string;
}

const DEFAULT_BASE = "http://localhost:11434";

function getBaseUrl(): string {
  // Vite exposes import.meta.env.VITE_* at build time. Keeping this opt-in so
  // most users get the default localhost behavior with no config.
  const fromEnv = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_OLLAMA_BASE_URL;
  return fromEnv && fromEnv.length > 0 ? fromEnv.replace(/\/$/, "") : DEFAULT_BASE;
}

function wrapFetchError(error: unknown, status?: number): OllamaError {
  if (error instanceof OllamaError) {
    return error;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new OllamaError("aborted", "Request cancelled");
  }
  if (status === 403) {
    return new OllamaError(
      "cors",
      "Ollama rejected the request origin. Set OLLAMA_ORIGINS to include http://127.0.0.1:5173 then restart `ollama serve`.",
      status,
    );
  }
  if (status === 404) {
    return new OllamaError(
      "not-found",
      "Endpoint or model not found. Have you pulled this model with `ollama pull`?",
      status,
    );
  }
  if (status && status >= 500) {
    return new OllamaError("bad-response", `Ollama returned ${status}.`, status);
  }
  // TypeError("Failed to fetch") happens for both "connection refused" AND
  // CORS-preflight rejection — the browser surfaces both as the same failure.
  // The hint covers both because we can't tell them apart from here.
  return new OllamaError(
    "unreachable",
    "Could not reach Ollama. Either `ollama serve` isn't running, or its CORS rules don't include this origin. Try `OLLAMA_ORIGINS='*' ollama serve` and refresh.",
  );
}

export async function listModels(signal?: AbortSignal): Promise<OllamaModelInfo[]> {
  let response: Response;
  try {
    response = await fetch(`${getBaseUrl()}/api/tags`, { signal });
  } catch (error) {
    throw wrapFetchError(error);
  }
  if (!response.ok) {
    throw wrapFetchError(undefined, response.status);
  }
  const data = (await response.json()) as { models?: Array<{ name?: string; model?: string; size?: number; modified_at?: string }> };
  return (data.models ?? [])
    .map((entry) => ({
      name: entry.name ?? entry.model ?? "",
      size: entry.size ?? 0,
      modifiedAt: entry.modified_at ?? "",
    }))
    .filter((entry) => entry.name.length > 0);
}

interface ChatStreamChunk {
  message?: { role?: string; content?: string };
  done?: boolean;
  error?: string;
}

export interface ChatStreamOptions {
  model: string;
  messages: OllamaMessage[];
  signal?: AbortSignal;
  onToken?: (token: string) => void;
  // Pass options through to Ollama (temperature, top_p, num_predict, etc.).
  options?: Record<string, number | string | boolean>;
}

// Stream a chat completion. Resolves with the full assistant text once the
// stream is `done`. Calls `onToken` for each delta as it arrives.
export async function chatStream({
  model,
  messages,
  signal,
  onToken,
  options,
}: ChatStreamOptions): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${getBaseUrl()}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages, stream: true, options }),
      signal,
    });
  } catch (error) {
    throw wrapFetchError(error);
  }
  if (!response.ok || !response.body) {
    throw wrapFetchError(undefined, response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        let parsed: ChatStreamChunk;
        try {
          parsed = JSON.parse(trimmed) as ChatStreamChunk;
        } catch {
          continue;
        }
        if (parsed.error) {
          throw new OllamaError("bad-response", parsed.error);
        }
        const token = parsed.message?.content;
        if (token) {
          full += token;
          onToken?.(token);
        }
        if (parsed.done) {
          return full;
        }
      }
    }
  } catch (error) {
    throw wrapFetchError(error);
  } finally {
    reader.releaseLock();
  }

  return full;
}

export interface ChatJsonOptions {
  model: string;
  messages: OllamaMessage[];
  signal?: AbortSignal;
  options?: Record<string, number | string | boolean>;
}

// Single-shot completion using Ollama's `format: "json"` to get a parsable
// response. Returns the parsed object (caller validates the shape).
export async function chatJson<T>({ model, messages, signal, options }: ChatJsonOptions): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${getBaseUrl()}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages, stream: false, format: "json", options }),
      signal,
    });
  } catch (error) {
    throw wrapFetchError(error);
  }
  if (!response.ok) {
    throw wrapFetchError(undefined, response.status);
  }
  const data = (await response.json()) as { message?: { content?: string }; error?: string };
  if (data.error) {
    throw new OllamaError("bad-response", data.error);
  }
  const content = data.message?.content ?? "";
  try {
    return JSON.parse(content) as T;
  } catch {
    throw new OllamaError(
      "bad-response",
      `Model returned non-JSON output: ${content.slice(0, 120)}`,
    );
  }
}

export function getOllamaBaseUrl(): string {
  return getBaseUrl();
}

// Probe whether the Ollama daemon is reachable, ignoring CORS. A normal
// cross-origin fetch can't tell "server refused" from "CORS preflight
// rejected" — they both surface as TypeError. With mode:"no-cors" the browser
// skips the preflight: any fulfilled response means the daemon answered
// (CORS was the blocker), and only TypeError means the daemon is truly down.
export async function probeReachable(signal?: AbortSignal): Promise<"online" | "offline"> {
  try {
    await fetch(`${getBaseUrl()}/api/tags`, {
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
      signal,
    });
    return "online";
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    return "offline";
  }
}
