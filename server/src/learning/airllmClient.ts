// Typed HTTP client for the AirLLM high-parameter engine on the Python worker
// sidecar. Same boundary contract as the perception / own-model clients: the
// server MUST run with the worker down. Every method returns a structured result
// rather than throwing; an absent/old worker degrades to state:"unavailable" /
// { ok:false }.
//
// AirLLM runs a LARGE model (7B…70B) on a small GPU via layer-by-layer
// offloading — inference-only and slow. Two roles: direct high-parameter
// generation (/api/learning/airllm/generate) and the distillation teacher for
// the mango own-model trainer (threaded through ownModelClient's start path).

import type { AirllmGenerateResult, AirllmStatus } from "../../../shared/learning.js";
import { CONFIG } from "../config.js";
import { surfaceError } from "../util/diagnostics.js";

const BASE_URL = process.env.PERCEPTION_WORKER_URL ?? "http://127.0.0.1:8789";
const STATUS_TIMEOUT_MS = 500;
// Layer-by-layer inference is SLOW — a single high-parameter generation on a 6GB
// GPU can take minutes. Give it a long ceiling (same order as `ollama create`).
const GENERATE_TIMEOUT_MS = 600_000;
const MAX_NEW_TOKENS_CAP = 2048;
const MAX_PROMPT_CHARS = 8000;

function downStatus(message: string): AirllmStatus {
  return {
    state: "unavailable",
    model: null,
    compression: null,
    device: null,
    message,
    updatedAt: null,
  };
}

function normalizeStatus(raw: Partial<AirllmStatus> & Record<string, unknown>): AirllmStatus {
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const validStates: AirllmStatus["state"][] = [
    "idle",
    "loading",
    "ready",
    "generating",
    "error",
    "unavailable",
  ];
  const state = validStates.includes(raw.state as AirllmStatus["state"])
    ? (raw.state as AirllmStatus["state"])
    : "idle";
  return {
    state,
    model: str(raw.model),
    compression: str(raw.compression),
    device: str(raw.device),
    message: str(raw.message),
    updatedAt: str(raw.updatedAt),
  };
}

async function fetchJson<T>(
  path: string,
  init: RequestInit,
  timeoutMs: number,
  source: string,
  quiet = false,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let detail = text;
      try {
        const parsed = JSON.parse(text) as { detail?: string };
        if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
      } catch {
        // not JSON — keep raw text
      }
      if (!quiet) surfaceError(source, new Error(`HTTP ${res.status}: ${detail}`));
      return { ok: false, error: detail || `HTTP ${res.status}` };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (err) {
    if (!quiet) surfaceError(source, err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Poll the AirLLM engine. Cheap (500ms cap) — safe while a panel is open. */
export async function getAirllmStatus(): Promise<AirllmStatus> {
  const r = await fetchJson<Record<string, unknown>>(
    "/airllm/status",
    { method: "GET" },
    STATUS_TIMEOUT_MS,
    "learning:airllm-status",
    true, // a down worker is expected, not a swallowed error
  );
  if (!r.ok) {
    return downStatus(
      "AirLLM engine offline. Start the worker (worker/main.py) with ML deps (airllm) installed.",
    );
  }
  return normalizeStatus(r.data);
}

export interface AirllmGenerateOptions {
  prompt: string;
  model?: string;
  maxNewTokens?: number;
  compression?: string;
}

/**
 * Clamp/normalise generate options to the worker's accepted bounds. Pure (no
 * I/O) so the selfcheck can cover the guard rails without a worker. Defaults the
 * model + compression from CONFIG when the caller omits them.
 */
export function clampGenerateOptions(opts: AirllmGenerateOptions): {
  prompt: string;
  model: string;
  maxNewTokens: number;
  compression: string;
} {
  const prompt = String(opts.prompt ?? "").slice(0, MAX_PROMPT_CHARS);
  const rawTokens = Number(opts.maxNewTokens);
  const maxNewTokens = Number.isFinite(rawTokens)
    ? Math.max(1, Math.min(MAX_NEW_TOKENS_CAP, Math.floor(rawTokens)))
    : 256;
  const model = opts.model && opts.model.trim().length > 0 ? opts.model.trim() : CONFIG.airllmTeacherModel;
  const compression =
    opts.compression && opts.compression.trim().length > 0
      ? opts.compression.trim()
      : CONFIG.airllmCompression;
  return { prompt, model, maxNewTokens, compression };
}

/**
 * Generate from the high-parameter model. Returns a structured result; a down
 * worker / missing airllm degrades to { ok:false, error } rather than throwing.
 */
export async function generateWithAirllm(
  opts: AirllmGenerateOptions,
): Promise<AirllmGenerateResult> {
  const body = clampGenerateOptions(opts);
  if (body.prompt.trim().length === 0) {
    return { ok: false, text: null, model: null, device: null, latencyMs: null, truncated: false, error: "empty prompt" };
  }
  const r = await fetchJson<Record<string, unknown>>(
    "/airllm/generate",
    { method: "POST", body: JSON.stringify(body) },
    GENERATE_TIMEOUT_MS,
    "learning:airllm-generate",
  );
  if (!r.ok) {
    return { ok: false, text: null, model: null, device: null, latencyMs: null, truncated: false, error: r.error };
  }
  const d = r.data;
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    ok: d.ok === true,
    // Preserve "" — an empty generation is a degenerate SUCCESS, distinct from a
    // failure (ok:false). Coercing it to null would mask "produced no tokens".
    text: typeof d.text === "string" ? d.text : null,
    model: str(d.model),
    device: str(d.device),
    latencyMs: num(d.latencyMs),
    truncated: d.truncated === true,
    error: null,
  };
}

/** Selfcheck helper. */
export const AIRLLM_BASE_URL = BASE_URL;
