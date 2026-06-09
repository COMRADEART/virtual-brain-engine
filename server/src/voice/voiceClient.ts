import { surfaceError } from "../util/diagnostics.js";

const BASE_URL = process.env.PERCEPTION_WORKER_URL ?? "http://127.0.0.1:8789";
const CALL_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 200;

/** Max characters accepted for synthesis (route + selfcheck share this). */
export const MAX_SPEAK_CHARS = 5000;

/**
 * PURE input validation for the speak route. Factored out so the hermetic
 * selfcheck can exercise the empty / over-length / valid paths without booting
 * Express or the worker.
 */
export function validateSpeakText(
  text: unknown,
): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, error: "text is required and must be non-empty." };
  }
  if (text.length > MAX_SPEAK_CHARS) {
    return { ok: false, error: `text must be ${MAX_SPEAK_CHARS} characters or fewer.` };
  }
  return { ok: true, text: text.trim() };
}

export interface VoiceStatus {
  voice: "ready" | "available" | "unavailable";
  model?: string;
  version?: string | null;
  error?: string;
}

export interface SpeakRequest {
  text: string;
  voice?: string;
  preset?: string;
}

export interface SpeakResult {
  audioBase64: string;
  mimeType: string;
  sampleRate: number;
  durationSec: number;
  latencyMs: number;
  model: string;
  voice: string;
}

export type SpeakWorkerResult =
  | { ok: true; data: SpeakResult }
  | { ok: false; status: number; error: string };

async function fetchJson<T>(
  path: string,
  init: RequestInit,
  timeoutMs: number,
  source: string,
): Promise<SpeakWorkerResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let detail = text;
      try {
        const parsed = JSON.parse(text) as { detail?: string };
        if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
      } catch {
        // not JSON; keep raw string
      }
      surfaceError(source, new Error(`HTTP ${res.status}: ${detail}`));
      return { ok: false, status: res.status, error: detail || `HTTP ${res.status}` };
    }
    const data = (await res.json()) as T;
    return { ok: true, data } as SpeakWorkerResult;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    surfaceError(source, err);
    return { ok: false, status: 503, error: message };
  } finally {
    clearTimeout(timer);
  }
}

export async function speak(req: SpeakRequest): Promise<SpeakWorkerResult> {
  const result = await fetchJson<SpeakResult>(
    "/voice/speak",
    { method: "POST", body: JSON.stringify(req) },
    CALL_TIMEOUT_MS,
    "voice:speak",
  );
  if (result.ok) return { ok: true, data: result.data };
  return { ok: false, status: result.status, error: result.error };
}

/**
 * CHEAP readiness probe — hits the worker's /healthz (200ms, quiet) and reads
 * the `tts` model state. This replaces the old status path that triggered a
 * full Bark model load + synthesis, which could time out on a cold worker and
 * FALSELY report "unavailable". A down worker is expected, so we never surface
 * the error to the diagnostics counter (mirrors perception's quiet probe).
 */
export async function voiceStatus(): Promise<VoiceStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/healthz`, { method: "GET", signal: controller.signal });
    if (!res.ok) {
      return { voice: "unavailable", error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as {
      version?: string;
      models?: { tts?: "ready" | "available" | "unavailable" };
    };
    const tts = data.models?.tts ?? "unavailable";
    return { voice: tts, version: data.version ?? null };
  } catch (err) {
    return { voice: "unavailable", error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export const VOICE_BASE_URL = BASE_URL;