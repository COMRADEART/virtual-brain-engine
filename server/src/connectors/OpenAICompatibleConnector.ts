import type {
  ConnectorDescriptor,
  ConnectorTestResult,
  SendOptions,
} from "../../../shared/connector.js";
import { Connector, ConnectorError } from "./Connector.js";

// One connector to drive every OpenAI-compatible local server: LM Studio,
// llama.cpp's llama-server, Jan, GPT4All, vLLM, TGI. baseUrl is required and
// should be the root that exposes /v1/* (e.g. "http://127.0.0.1:1234/v1" or
// "http://127.0.0.1:8080").
//
// Auth: optional. Local runtimes accept any key (LM Studio explicitly accepts
// the literal "lm-studio"), so we send `Authorization: Bearer <something>`
// only if the user configured one via OPENAI_API_KEY / LMSTUDIO_API_KEY. The
// previous default of "lm-studio" was harmless but obscured the no-key path.
//
// embed(): only exposed when descriptor.embeddingModel is set. The pipeline's
// fallback chain ([Phase F]) checks `instance.embed` for presence before
// trying — defining embed() as a no-op would break that check, so this class
// dynamically assigns the method in the constructor based on the descriptor.
export class OpenAICompatibleConnector implements Connector {
  readonly descriptor: ConnectorDescriptor;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly apiKey: string | null;
  readonly embed?: (text: string, signal?: AbortSignal) => Promise<number[]>;

  constructor(descriptor: ConnectorDescriptor) {
    this.descriptor = descriptor;
    if (!descriptor.baseUrl) {
      throw new ConnectorError(
        "unsupported",
        "OpenAI-compatible connector requires baseUrl (e.g. http://127.0.0.1:1234)",
      );
    }
    this.baseUrl = descriptor.baseUrl.replace(/\/$/, "");
    this.defaultModel = descriptor.model ?? "";
    const envKey = process.env.OPENAI_API_KEY ?? process.env.LMSTUDIO_API_KEY ?? "";
    this.apiKey = envKey.length > 0 ? envKey : null;
    if (descriptor.embeddingModel) {
      const embedModel = descriptor.embeddingModel;
      this.embed = (text: string, signal?: AbortSignal) => this.callEmbed(embedModel, text, signal);
    }
  }

  // Some servers expose /v1 at the root (vLLM, TGI in default config), others
  // at /v1 already in the baseUrl. We accept either by normalising: if baseUrl
  // already contains /v1, drop it for the prefix.
  private path(suffix: string): string {
    if (this.baseUrl.endsWith("/v1")) {
      return `${this.baseUrl}${suffix}`;
    }
    return `${this.baseUrl}/v1${suffix}`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) {
      h.authorization = `Bearer ${this.apiKey}`;
    }
    return h;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    try {
      const res = await fetch(this.path("/models"), { headers: this.headers(), signal });
      if (!res.ok) {
        return this.defaultModel ? [this.defaultModel] : [];
      }
      const data = (await res.json()) as { data?: Array<{ id?: string }> };
      const ids = (data.data ?? []).map((entry) => entry.id ?? "").filter(Boolean);
      if (ids.length > 0) {
        return ids;
      }
      return this.defaultModel ? [this.defaultModel] : [];
    } catch {
      return this.defaultModel ? [this.defaultModel] : [];
    }
  }

  async send(prompt: string, opts: SendOptions = {}): Promise<string> {
    const messages: Array<{ role: string; content: string }> = [];
    if (opts.system) {
      messages.push({ role: "system", content: opts.system });
    }
    messages.push({ role: "user", content: prompt });
    const body: Record<string, unknown> = {
      model: opts.model ?? this.defaultModel,
      messages,
      stream: false,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
    };
    if (opts.format === "json") {
      body.response_format = { type: "json_object" };
    }

    const res = await fetch(this.path("/chat/completions"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) {
      throw new ConnectorError("bad-response", `${this.descriptor.kind}: ${res.status}`, res.status);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content ?? "";
  }

  async *stream(prompt: string, opts: SendOptions = {}): AsyncIterable<string> {
    const messages: Array<{ role: string; content: string }> = [];
    if (opts.system) {
      messages.push({ role: "system", content: opts.system });
    }
    messages.push({ role: "user", content: prompt });

    const res = await fetch(this.path("/chat/completions"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: opts.model ?? this.defaultModel,
        messages,
        stream: true,
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
      }),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      throw new ConnectorError("bad-response", `${this.descriptor.kind}: ${res.status}`, res.status);
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
          const event = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const line of event.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") {
              return;
            }
            try {
              const parsed = JSON.parse(payload) as {
                choices?: Array<{ delta?: { content?: string } }>;
              };
              const token = parsed.choices?.[0]?.delta?.content;
              if (token) {
                yield token;
              }
            } catch {
              // Skip malformed event
            }
          }
          sep = buffer.indexOf("\n\n");
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async callEmbed(model: string, text: string, signal?: AbortSignal): Promise<number[]> {
    const res = await fetch(this.path("/embeddings"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model, input: text }),
      signal,
    });
    if (!res.ok) {
      throw new ConnectorError(
        "bad-response",
        `${this.descriptor.kind} embeddings: ${res.status}`,
        res.status,
      );
    }
    const data = (await res.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const vec = data.data?.[0]?.embedding;
    if (!Array.isArray(vec)) {
      throw new ConnectorError("bad-response", `${this.descriptor.kind} returned no embedding`);
    }
    return vec;
  }

  async test(signal?: AbortSignal): Promise<ConnectorTestResult> {
    try {
      const models = await this.listModels(signal);
      if (models.length === 0) {
        return { ok: false, models, message: "No models loaded" };
      }
      return { ok: true, models, message: `${models.length} models available` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
