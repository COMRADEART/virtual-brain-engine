// Phase 3 — /api/perceive/* router. Forwards to the Python worker sidecar at
// http://127.0.0.1:8789 with two design rules:
//
//   1. The router is mounted unconditionally — even when the worker is down.
//      /api/perceive/status always responds; /api/perceive/transcribe and
//      /api/perceive/caption return a structured 503 with detail="worker
//      offline" instead of throwing.
//
//   2. Audio + image payloads can be large. The default express.json limit on
//      the server is 1mb (server/src/index.ts); this router installs its own
//      bodyParser with a 20mb cap so a ~10-minute audio clip (base64-inflated)
//      still fits. Bumping just this router keeps the global 1mb safety floor
//      everywhere else.
//
// The router is purely a forwarding shim — model loading, decoding, and
// inference all happen in the Python sidecar. That keeps the Node side cheap
// (no torch in V8) and makes the worker independently swappable.

import { Router, json } from "express";
import { broadcast } from "../ws/brainBus.js";
import { caption, probeWorker, transcribe } from "./workerClient.js";
import type {
  CaptionRequest,
  CaptionResult,
  TranscribeRequest,
  TranscribeResult,
} from "../../../shared/perception.js";

const PERCEPTION_BODY_LIMIT = "20mb";

export const perceptionRouter = Router();

// Larger body cap, scoped to this router. We don't change the global
// express.json() that the rest of /api uses.
perceptionRouter.use("/perceive", json({ limit: PERCEPTION_BODY_LIMIT }));

perceptionRouter.get("/perceive/status", async (_req, res) => {
  const status = await probeWorker();
  res.json(status);
});

perceptionRouter.post("/perceive/transcribe", async (req, res) => {
  const body = req.body as Partial<TranscribeRequest> | undefined;
  if (!body || typeof body.audioBase64 !== "string" || body.audioBase64.length === 0) {
    return res.status(400).json({ error: "audioBase64 (non-empty string) is required" });
  }
  const result = await transcribe({
    audioBase64: body.audioBase64,
    mimeType: typeof body.mimeType === "string" ? body.mimeType : undefined,
    language: typeof body.language === "string" ? body.language : undefined,
  });
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }
  broadcastPerception("transcribe", result.data);
  res.json(result.data);
});

perceptionRouter.post("/perceive/caption", async (req, res) => {
  const body = req.body as Partial<CaptionRequest> | undefined;
  if (!body || typeof body.imageBase64 !== "string" || body.imageBase64.length === 0) {
    return res.status(400).json({ error: "imageBase64 (non-empty string) is required" });
  }
  const result = await caption({
    imageBase64: body.imageBase64,
    prompt: typeof body.prompt === "string" ? body.prompt : undefined,
  });
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }
  broadcastPerception("caption", result.data);
  res.json(result.data);
});

function broadcastPerception(
  kind: "transcribe" | "caption",
  data: TranscribeResult | CaptionResult,
): void {
  // Truncated preview — raw audio/image bytes never enter the bus.
  const previewSource = kind === "transcribe" ? (data as TranscribeResult).text : (data as CaptionResult).caption;
  const preview = previewSource.length > 200 ? `${previewSource.slice(0, 197)}...` : previewSource;
  broadcast({
    type: "perception",
    kind,
    preview,
    model: data.model,
    latencyMs: data.latencyMs,
    timestamp: new Date().toISOString(),
  });
}
