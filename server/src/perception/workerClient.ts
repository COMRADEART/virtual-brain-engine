// Phase 3 — typed HTTP client for the Python worker sidecar at
// http://127.0.0.1:8789. The MVP must run with the sidecar DOWN: every method
// here returns a structured error rather than throwing, and the only place that
// surfaces the error to the user is the route layer (which then emits a 503).
//
// Boundary contract:
//   - 200ms timeout on /healthz (probe). Anything slower is treated as down to
//     avoid stalling /api/perceive/status during a sidecar hang.
//   - 60s timeout on /transcribe and /caption — first call may also be doing
//     a model download. UI should surface a loading state, not a retry storm.
//   - All errors flow through util/diagnostics.surfaceError so the source
//     ("perception:worker") counts show up on /api/health alongside the
//     memory-layer counters.

import type {
  CaptionRequest,
  CaptionResult,
  TranscribeRequest,
  TranscribeResult,
  WorkerStatus,
} from "../../../shared/perception.js";
import { surfaceError } from "../util/diagnostics.js";

const BASE_URL = process.env.PERCEPTION_WORKER_URL ?? "http://127.0.0.1:8789";
const PROBE_TIMEOUT_MS = 200;
const CALL_TIMEOUT_MS = 60_000;

// Discriminated result, used by the router. Forces the caller to handle the
// "down" arm before reading the payload — there is no way to silently lose
// the error.
export type WorkerResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

async function fetchJson<T>(
  path: string,
  init: RequestInit,
  timeoutMs: number,
  source: string,
  options: { quiet?: boolean } = {},
): Promise<WorkerResult<T>> {
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
      // The worker uses FastAPI's standard {"detail": "..."} on error. Fall
      // back to the text body if the JSON shape is missing (older worker /
      // proxy / etc.).
      const text = await res.text().catch(() => "");
      let detail = text;
      try {
        const parsed = JSON.parse(text) as { detail?: string };
        if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
      } catch {
        // text wasn't JSON; keep the raw string.
      }
      if (!options.quiet) {
        surfaceError(source, new Error(`HTTP ${res.status}: ${detail}`));
      }
      return { ok: false, status: res.status, error: detail || `HTTP ${res.status}` };
    }
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // ECONNREFUSED, abort (timeout), DNS — all mean "worker down" from the
    // caller's perspective. The probe path passes quiet:true because a down
    // worker is expected (not a swallowed-error class); only real calls
    // (transcribe/caption) should bump the diagnostic counter.
    if (!options.quiet) {
      surfaceError(source, err);
    }
    return { ok: false, status: 503, error: message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe the worker. Returns a WorkerStatus that's safe to surface to the UI.
 * Cheap enough to call on every /api/perceive/status hit (200ms upper bound).
 */
export async function probeWorker(): Promise<WorkerStatus> {
  const result = await fetchJson<{
    status: string;
    role: string;
    uptimeSec: number;
    version: string;
    models: { whisper: "ready" | "available" | "unavailable"; caption: "ready" | "available" | "unavailable" };
  }>("/healthz", { method: "GET" }, PROBE_TIMEOUT_MS, "perception:probe", { quiet: true });
  if (!result.ok) {
    return {
      status: "down",
      uptimeSec: null,
      version: null,
      models: { whisper: "unavailable", caption: "unavailable" },
      error: result.error,
    };
  }
  return {
    status: "ok",
    uptimeSec: result.data.uptimeSec,
    version: result.data.version,
    models: result.data.models,
  };
}

export async function transcribe(req: TranscribeRequest): Promise<WorkerResult<TranscribeResult>> {
  return fetchJson<TranscribeResult>(
    "/transcribe",
    { method: "POST", body: JSON.stringify(req) },
    CALL_TIMEOUT_MS,
    "perception:transcribe",
  );
}

export async function caption(req: CaptionRequest): Promise<WorkerResult<CaptionResult>> {
  return fetchJson<CaptionResult>(
    "/caption",
    { method: "POST", body: JSON.stringify(req) },
    CALL_TIMEOUT_MS,
    "perception:caption",
  );
}

/** Selfcheck helper — exposes BASE_URL so the hermetic test can assert it. */
export const PERCEPTION_BASE_URL = BASE_URL;
