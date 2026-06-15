import type {
  ConnectorDescriptor,
  ConnectorTestResult,
  SendOptions,
} from "../../../shared/connector.js";
import { Connector, ConnectorError } from "./Connector.js";

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// Split a "a, b ,c" env value into ["a","b","c"], dropping blanks. A single
// value with no comma yields a one-element pool, so the plural and singular
// env vars are handled uniformly.
function splitKeys(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Resolve the bearer-key POOL by host. Local OpenAI-compatible runtimes need no
// key (or any string), so the pool is empty for them. The free remote providers
// each read their own env vars — BOTH a plural comma-separated list (rotation:
// hold 4-5 free keys to ~Nx the rate limit and fail over around a throttled one)
// AND the legacy singular var (backward compatible). Plural is listed first so a
// dedicated rotation pool takes precedence in ordering. Keys are read from
// process.env only — never persisted to the DB. Returns [] when none configured
// (the local path). Order-preserving dedup so the same key isn't tried twice.
function resolveApiKeys(baseUrl: string): string[] {
  const host = hostnameOf(baseUrl);
  let raw: string[];
  if (host === "integrate.api.nvidia.com") {
    raw = [...splitKeys(process.env.NVIDIA_API_KEYS), ...splitKeys(process.env.NVIDIA_API_KEY)];
  } else if (host === "generativelanguage.googleapis.com") {
    raw = [
      ...splitKeys(process.env.GEMINI_API_KEYS),
      ...splitKeys(process.env.GOOGLE_AI_API_KEYS),
      ...splitKeys(process.env.GEMINI_API_KEY),
      ...splitKeys(process.env.GOOGLE_AI_API_KEY),
    ];
  } else {
    raw = [
      ...splitKeys(process.env.OPENAI_API_KEYS),
      ...splitKeys(process.env.LMSTUDIO_API_KEYS),
      ...splitKeys(process.env.OPENAI_API_KEY),
      ...splitKeys(process.env.LMSTUDIO_API_KEY),
    ];
  }
  return [...new Set(raw)];
}

// Cooldown windows after a key is rejected. A 429 (rate/quota) is transient, so
// a short window; a 401/403 (bad/exhausted key) is sticky, so a long one. Both
// are heuristic — an exhausted-pool sweep ignores cooldowns rather than failing
// outright (see candidateOrder).
const COOLDOWN_RATE_MS = 30_000;
const COOLDOWN_AUTH_MS = 5 * 60_000;
const COOLDOWN_MAX_MS = 10 * 60_000;

export interface ConnectorRuntimeOptions {
  // Injected for hermetic selfchecks (no real network). Defaults to global fetch.
  fetchImpl?: typeof fetch;
}

// One connector to drive every OpenAI-compatible server (local: LM Studio,
// llama.cpp's llama-server, Jan, GPT4All, vLLM, TGI; remote: NVIDIA NIM, Gemini's
// OpenAI endpoint). baseUrl is required and should be the root that exposes /v1/*
// (e.g. "http://127.0.0.1:1234/v1" or "http://127.0.0.1:8080").
//
// Auth + key rotation: the API key(s) come from a host-scoped pool (see
// resolveApiKeys). With 0 keys we send no Authorization header (local runtimes
// accept that). With 1+ keys, every request round-robins across the pool to
// spread load, and on a 429/401/403 it transparently FAILS OVER to the next key
// (the throttled/exhausted one enters a cooldown so subsequent requests skip it).
// A non-key error (4xx≠auth, 5xx) is surfaced as-is — failing over keys can't fix
// a malformed request or a provider outage, and would just burn the pool.
//
// embed(): only exposed when descriptor.embeddingModel is set. The pipeline's
// fallback chain ([Phase F]) checks `instance.embed` for presence before trying —
// defining embed() as a no-op would break that check, so this class dynamically
// assigns the method in the constructor based on the descriptor.
export class OpenAICompatibleConnector implements Connector {
  readonly descriptor: ConnectorDescriptor;
  private readonly baseUrl: string;
  private readonly apiRoot: string;
  private readonly defaultModel: string;
  private readonly apiKeys: string[];
  private readonly fetchImpl: typeof fetch;
  // key → epoch-ms until which the key is skipped on the fresh sweep.
  private readonly cooldownUntil = new Map<string, number>();
  // round-robin cursor; advanced past the last key that succeeded.
  private rrIndex = 0;
  readonly embed?: (text: string, signal?: AbortSignal) => Promise<number[]>;

  constructor(descriptor: ConnectorDescriptor, opts: ConnectorRuntimeOptions = {}) {
    this.descriptor = descriptor;
    if (!descriptor.baseUrl) {
      throw new ConnectorError(
        "unsupported",
        "OpenAI-compatible connector requires baseUrl (e.g. http://127.0.0.1:1234)",
      );
    }
    this.baseUrl = descriptor.baseUrl.replace(/\/$/, "");
    // Resolve the API root. A host-only base (e.g. http://127.0.0.1:8080, vLLM/TGI
    // default) gets /v1 appended. A base that already carries a path is taken as
    // the API root verbatim — that covers both "…/v1" (LM Studio, NVIDIA NIM) and
    // non-/v1 roots like Gemini's "…/v1beta/openai". Appending /v1 to those would
    // produce a broken URL, which the old endsWith("/v1") check did for Gemini.
    this.apiRoot = /^https?:\/\/[^/]+$/.test(this.baseUrl) ? `${this.baseUrl}/v1` : this.baseUrl;
    this.defaultModel = descriptor.model ?? "";
    this.apiKeys = resolveApiKeys(this.baseUrl);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    if (descriptor.embeddingModel) {
      const embedModel = descriptor.embeddingModel;
      this.embed = (text: string, signal?: AbortSignal) => this.callEmbed(embedModel, text, signal);
    }
  }

  // Visible for selfchecks: the size of the rotation pool.
  get keyCount(): number {
    return this.apiKeys.length;
  }

  // Visible for telemetry: which key was last used (round-robin index).
  get currentKeyIndex(): number {
    return this.rrIndex > 0 ? this.rrIndex - 1 : 0;
  }

  // Token usage from the last completed stream (prompt_tokens, completion_tokens).
  lastUsage: { promptTokens: number; completionTokens: number } | null = null;

  private path(suffix: string): string {
    return `${this.apiRoot}${suffix}`;
  }

  private baseHeaders(): Record<string, string> {
    return { "content-type": "application/json" };
  }

  // Split the pool for this attempt: rotate to the round-robin cursor, then
  // separate not-cooled keys from cooled ones (cooled sorted soonest-to-recover
  // first). The caller tries every fresh key, then gives at most ONE cooled key
  // a chance — so a fully-throttled pool fails after a single round-trip instead
  // of sweeping all N cooled keys serially (which multiplied latency by pool
  // size). A still-loud ConnectorError(429) is still raised when nothing works.
  private candidateKeys(now: number): { fresh: string[]; cooled: string[] } {
    const keys = this.apiKeys;
    const start = keys.length > 0 ? this.rrIndex % keys.length : 0;
    const rotated = [...keys.slice(start), ...keys.slice(0, start)];
    const fresh = rotated.filter((k) => (this.cooldownUntil.get(k) ?? 0) <= now);
    const cooled = rotated
      .filter((k) => (this.cooldownUntil.get(k) ?? 0) > now)
      .sort((a, b) => (this.cooldownUntil.get(a) ?? 0) - (this.cooldownUntil.get(b) ?? 0));
    return { fresh, cooled };
  }

  private onKeySuccess(key: string): void {
    this.cooldownUntil.delete(key);
    const idx = this.apiKeys.indexOf(key);
    if (idx >= 0) {
      this.rrIndex = (idx + 1) % this.apiKeys.length;
    }
  }

  private markCooldown(key: string, res: Response): void {
    let ms = res.status === 429 ? COOLDOWN_RATE_MS : COOLDOWN_AUTH_MS;
    const ra = res.headers.get("retry-after");
    if (ra) {
      const secs = Number(ra);
      if (Number.isFinite(secs) && secs > 0) {
        ms = Math.min(secs * 1000, COOLDOWN_MAX_MS);
      }
    }
    this.cooldownUntil.set(key, Date.now() + ms);
  }

  // Issue `init` against `url`, rotating + failing over across the key pool.
  // Returns the first ok Response; on an all-keys-rejected sweep returns the last
  // (non-ok) Response so the caller throws with the real upstream status. A
  // non-auth, non-429 error short-circuits (failover can't help it).
  private async requestWithFailover(url: string, init: RequestInit): Promise<Response> {
    if (this.apiKeys.length === 0) {
      return this.fetchImpl(url, { ...init, headers: this.baseHeaders() });
    }
    // Try every fresh key; then give ONLY the single soonest-to-recover cooled
    // key one chance. This caps a fully-throttled pool at one round-trip rather
    // than re-probing every cooled key serially.
    const { fresh, cooled } = this.candidateKeys(Date.now());
    const order = [...fresh, ...cooled.slice(0, 1)];
    let lastRes: Response | null = null;
    for (const key of order) {
      const res = await this.fetchImpl(url, {
        ...init,
        headers: { ...this.baseHeaders(), authorization: `Bearer ${key}` },
      });
      if (res.ok) {
        this.onKeySuccess(key);
        return res;
      }
      if (res.status === 429 || res.status === 401 || res.status === 403) {
        this.markCooldown(key, res);
        lastRes = res;
        continue; // throttled/exhausted/invalid key → try the next one
      }
      return res; // request- or server-side error: surface it, don't burn the pool
    }
    // Every key was rejected. Return the last response so send()/stream() throw a
    // ConnectorError carrying the real status (e.g. 429) — the loud, honest signal
    // that the whole pool is throttled, rather than a silent empty answer.
    return lastRes ?? this.fetchImpl(url, { ...init, headers: this.baseHeaders() });
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    try {
      const res = await this.requestWithFailover(this.path("/models"), { method: "GET", signal });
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

    const res = await this.requestWithFailover(this.path("/chat/completions"), {
      method: "POST",
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

    // Failover happens on the initial response status, BEFORE the body is read —
    // a 429 surfaces as a non-ok Response and rotates to the next key, so by the
    // time we start consuming the stream we're on a key that returned 200.
    const res = await this.requestWithFailover(this.path("/chat/completions"), {
      method: "POST",
      body: JSON.stringify({
        model: opts.model ?? this.defaultModel,
        messages,
        stream: true,
        stream_options: { include_usage: true },
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
                usage?: { prompt_tokens?: number; completion_tokens?: number };
              };
              const token = parsed.choices?.[0]?.delta?.content;
              if (token) {
                yield token;
              }
              if (parsed.usage) {
                this.lastUsage = {
                  promptTokens: parsed.usage.prompt_tokens ?? 0,
                  completionTokens: parsed.usage.completion_tokens ?? 0,
                };
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
    const res = await this.requestWithFailover(this.path("/embeddings"), {
      method: "POST",
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
      const keyNote = this.apiKeys.length > 1 ? ` (${this.apiKeys.length}-key rotation pool)` : "";
      return { ok: true, models, message: `${models.length} models available${keyNote}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
