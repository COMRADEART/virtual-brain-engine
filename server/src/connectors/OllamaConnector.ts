import type {
  ConnectorDescriptor,
  ConnectorTestResult,
  SendOptions,
} from "../../../shared/connector.js";
import { CONFIG } from "../config.js";
import { Connector, ConnectorError } from "./Connector.js";

interface ChatChunk {
  message?: { content?: string };
  done?: boolean;
  error?: string;
}

function wrapFetchError(err: unknown, status?: number): ConnectorError {
  if (err instanceof ConnectorError) {
    return err;
  }
  if (err instanceof Error && err.name === "AbortError") {
    return new ConnectorError("aborted", "Request aborted");
  }
  if (status === 404) {
    return new ConnectorError("not-found", "Ollama endpoint or model not found", status);
  }
  if (status && status >= 500) {
    return new ConnectorError("bad-response", `Ollama returned ${status}`, status);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new ConnectorError("unreachable", `Could not reach Ollama: ${message}`);
}

export class OllamaConnector implements Connector {
  readonly descriptor: ConnectorDescriptor;
  private readonly baseUrl: string;
  private readonly chatModel: string;
  private readonly embedModel: string;

  constructor(descriptor: ConnectorDescriptor) {
    this.descriptor = descriptor;
    this.baseUrl = (descriptor.baseUrl ?? CONFIG.ollamaBaseUrl).replace(/\/$/, "");
    this.chatModel = descriptor.model ?? CONFIG.ollamaChatModel;
    this.embedModel = descriptor.embeddingModel ?? CONFIG.ollamaEmbeddingModel;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/tags`, { signal });
    } catch (err) {
      throw wrapFetchError(err);
    }
    if (!response.ok) {
      throw wrapFetchError(undefined, response.status);
    }
    const data = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
    return (data.models ?? [])
      .map((entry) => entry.name ?? entry.model ?? "")
      .filter((name) => name.length > 0);
  }

  async send(prompt: string, opts: SendOptions = {}): Promise<string> {
    const messages: Array<{ role: string; content: string }> = [];
    if (opts.system) {
      messages.push({ role: "system", content: opts.system });
    }
    messages.push({ role: "user", content: prompt });
    const body: Record<string, unknown> = {
      model: opts.model ?? this.chatModel,
      messages,
      stream: false,
      options: opts.temperature !== undefined ? { temperature: opts.temperature } : undefined,
    };
    if (opts.format === "json") {
      body.format = "json";
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (err) {
      throw wrapFetchError(err);
    }
    if (!response.ok) {
      throw wrapFetchError(undefined, response.status);
    }
    const data = (await response.json()) as { message?: { content?: string }; error?: string };
    if (data.error) {
      throw new ConnectorError("bad-response", data.error);
    }
    return data.message?.content ?? "";
  }

  async *stream(prompt: string, opts: SendOptions = {}): AsyncIterable<string> {
    const messages: Array<{ role: string; content: string }> = [];
    if (opts.system) {
      messages.push({ role: "system", content: opts.system });
    }
    messages.push({ role: "user", content: prompt });

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: opts.model ?? this.chatModel,
          messages,
          stream: true,
          options: opts.temperature !== undefined ? { temperature: opts.temperature } : undefined,
        }),
        signal: opts.signal,
      });
    } catch (err) {
      throw wrapFetchError(err);
    }
    if (!response.ok || !response.body) {
      throw wrapFetchError(undefined, response.status);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) {
            try {
              const parsed = JSON.parse(line) as ChatChunk;
              if (parsed.error) {
                throw new ConnectorError("bad-response", parsed.error);
              }
              if (parsed.message?.content) {
                yield parsed.message.content;
              }
              if (parsed.done) {
                return;
              }
            } catch (err) {
              if (err instanceof ConnectorError) {
                throw err;
              }
              // Skip malformed line
            }
          }
          nl = buffer.indexOf("\n");
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.embedModel, prompt: text }),
        signal,
      });
    } catch (err) {
      throw wrapFetchError(err);
    }
    if (!response.ok) {
      throw wrapFetchError(undefined, response.status);
    }
    const data = (await response.json()) as { embedding?: number[]; error?: string };
    if (data.error) {
      throw new ConnectorError("bad-response", data.error);
    }
    if (!Array.isArray(data.embedding)) {
      throw new ConnectorError("bad-response", "Ollama returned no embedding array");
    }
    return data.embedding;
  }

  async test(signal?: AbortSignal): Promise<ConnectorTestResult> {
    try {
      const models = await this.listModels(signal);
      return { ok: true, models, message: `${models.length} models available` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message };
    }
  }
}
