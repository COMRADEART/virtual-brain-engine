// Phase 3 — Perception layer contract between the Node server and the Python
// worker sidecar (worker/). These types deliberately have ZERO runtime deps so
// both sides (and any hermetic selfcheck) can import them without dragging in
// model/runtime code.
//
// Boundary rules (mirrored in server/src/perception/workerClient.ts):
//   - The server MUST run with the worker process down. Every worker call is
//     wrapped + degrades to status="down" via surfaceError().
//   - Image / audio payloads cross the HTTP boundary as base64 strings; the
//     express.json limit on the /api/perceive router is raised to handle that.
//   - Capability hints live in WorkerStatus.models — each model is reported as
//     "ready" (loaded), "available" (importable, lazy-loadable on first call),
//     or "unavailable" (missing dep). Callers gate UI on this, not on the bare
//     up/down probe.

/** What the worker reports on /healthz. Drives /api/perceive/status and the UI. */
export interface WorkerStatus {
  status: "ok" | "down";
  /** Worker uptime in seconds, or null if the process is unreachable. */
  uptimeSec: number | null;
  /** Worker semver string from FastAPI; null when down. */
  version: string | null;
  /**
   * Per-feature model availability. "ready" = loaded + warm in worker memory,
   * "available" = installed and lazy-loadable on first call, "unavailable" =
   * dep missing. The MVP server tolerates "unavailable" — only the route that
   * needs the missing model 503s; everything else keeps working.
   */
  models: {
    whisper: "ready" | "available" | "unavailable";
    caption: "ready" | "available" | "unavailable";
  };
  /** Set when the probe itself failed (timeout, ECONNREFUSED, bad JSON, ...). */
  error?: string;
}

/**
 * POST /api/perceive/transcribe — audio -> text. The server forwards to the
 * worker's /transcribe endpoint. base64 keeps the contract HTTP-shaped (no
 * multipart) at the cost of 33% inflation; raise express.json on the route to
 * accommodate ~10MB clips.
 */
export interface TranscribeRequest {
  /** Base64-encoded audio bytes (wav/mp3/m4a/ogg/webm — whatever ffmpeg reads). */
  audioBase64: string;
  /** Optional content-type hint for the worker; defaults are inferred. */
  mimeType?: string;
  /** BCP-47 hint (e.g. "en"). Whisper auto-detects when omitted. */
  language?: string;
}

export interface TranscribeSegment {
  start: number; // seconds
  end: number;   // seconds
  text: string;
}

export interface TranscribeResult {
  text: string;
  language: string | null;
  segments: TranscribeSegment[];
  /** Worker wall-clock for the transcribe call, milliseconds. */
  latencyMs: number;
  model: string; // e.g. "faster-whisper:tiny.en"
}

/**
 * POST /api/perceive/caption — image -> caption. Worker uses BLIP-style image
 * captioning when transformers is installed; absent that, returns a 503 from
 * /api/perceive/caption.
 */
export interface CaptionRequest {
  /** Base64-encoded image bytes (png/jpg/webp). */
  imageBase64: string;
  /** Optional prompt for conditional captioning (BLIP supports this). */
  prompt?: string;
}

export interface CaptionResult {
  caption: string;
  /** Probability-like confidence, 0..1. May be null if model doesn't expose one. */
  confidence: number | null;
  latencyMs: number;
  model: string; // e.g. "Salesforce/blip-image-captioning-base"
}

/**
 * Brain-bus broadcast for perception events. Mirrors the surface in
 * shared/pipeline.ts (BrainBusMessage) so any subscribed tab can see Whisper /
 * caption activity even if it didn't initiate the request. Kept narrow on
 * purpose — we don't broadcast the raw payload.
 */
export type PerceptionEventKind = "transcribe" | "caption";

export interface PerceptionEvent {
  type: "perception";
  kind: PerceptionEventKind;
  /** Truncated preview of the result (text or caption), <=200 chars. */
  preview: string;
  model: string;
  latencyMs: number;
  at: string; // ISO timestamp
}
