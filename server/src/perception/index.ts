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
import { caption, parseFrame, probeWorker, transcribe } from "./workerClient.js";
import { getVisionConfig } from "../vision/capture.js";
import { ingestPerceptionMemory } from "../vision/perceptionMemory.js";
import { getDefaultConnectorInstance, listConnectorInstances } from "../connectors/registry.js";
import type { Connector } from "../connectors/Connector.js";
import { CONFIG } from "../config.js";
import type {
  CaptionRequest,
  CaptionResult,
  FrameRequest,
  FrameResult,
  TranscribeRequest,
  TranscribeResult,
} from "../../../shared/perception.js";

const PERCEPTION_BODY_LIMIT = "20mb";

/** OCR excerpt cap kept on the retrievable content so one busy frame can't
 *  balloon the memory body. */
const FRAME_CONTENT_MAX = 500;

// Same embedder resolution as the pipeline / summaryAgent: prefer the default
// connector, else any healthy local Ollama that can embed. Frame ingestion
// degrades to a string-only (no-vector) store when none can embed.
function getEmbedder(): Connector | null {
  const active = getDefaultConnectorInstance();
  if (active?.embed) return active;
  return (
    listConnectorInstances().find(
      (c) =>
        c.descriptor.kind === "ollama" &&
        c.descriptor.enabled &&
        c.descriptor.state === "ok" &&
        Boolean(c.embed),
    ) ?? null
  );
}

// Build the retrievable text from the strongest element caption(s) + an OCR
// excerpt, prefixed with the window title when present. Capped at
// FRAME_CONTENT_MAX so the memory body stays small.
function buildFrameContent(frame: FrameResult, windowTitle: string | null): string {
  const captions = frame.elements
    .map((e) => e.caption.trim())
    .filter((c) => c.length > 0)
    .slice(0, 3)
    .join("; ");
  const ocr = frame.ocrText.trim();
  const body = [captions, ocr].filter((s) => s.length > 0).join(" — ");
  const prefixed = windowTitle ? `${windowTitle}: ${body}` : body;
  return prefixed.length > FRAME_CONTENT_MAX
    ? `${prefixed.slice(0, FRAME_CONTENT_MAX - 1)}…`
    : prefixed;
}

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

perceptionRouter.post("/perceive/frame", async (req, res) => {
  // FrameRequest carries imageBase64+ocr; the optional ingestion hints
  // (windowTitle/sourceApp/visualMemoryId) ride alongside on the same body.
  const body = req.body as
    | (Partial<FrameRequest> & {
        windowTitle?: unknown;
        sourceApp?: unknown;
        visualMemoryId?: unknown;
      })
    | undefined;
  if (!body || typeof body.imageBase64 !== "string" || body.imageBase64.length === 0) {
    return res.status(400).json({ error: "imageBase64 (non-empty string) is required" });
  }

  // SERVER-ENFORCED PRIVACY: frame capture is opt-in. A direct API POST must
  // not bypass the user's vision-config toggle — reject BEFORE the worker runs.
  const cfg = await getVisionConfig();
  if (cfg?.enabled !== true) {
    return res.status(403).json({ error: "perception capture is disabled (opt-in required)" });
  }

  const frameReq: FrameRequest = {
    imageBase64: body.imageBase64,
    ocr: typeof body.ocr === "boolean" ? body.ocr : undefined,
  };
  const result = await parseFrame(frameReq);
  if (!result.ok) {
    // Worker down / OmniParser deps missing -> propagate the status (503-ish).
    return res.status(result.status).json({ error: result.error });
  }

  const frame = result.data;
  const windowTitle = typeof body.windowTitle === "string" ? body.windowTitle : null;
  const sourceApp = typeof body.sourceApp === "string" ? body.sourceApp : null;
  const content = buildFrameContent(frame, windowTitle);

  // Embed the retrievable text best-effort. A missing/mismatched embedding
  // degrades to a string-only store (still retrievable by keyword) rather than
  // failing the request.
  let embedding: number[] | undefined;
  const embedder = getEmbedder();
  if (embedder?.embed && content.length > 0) {
    try {
      const vec = await embedder.embed(content);
      if (Array.isArray(vec) && vec.length === CONFIG.embeddingDim) {
        embedding = vec;
      }
    } catch {
      // Embedding is optional — fall through to a string-only store.
    }
  }

  const ingest = await ingestPerceptionMemory({
    content,
    embedding,
    visualMemoryId:
      typeof body.visualMemoryId === "string" ? body.visualMemoryId : undefined,
    sourceApp,
    windowTitle,
  });

  broadcastPerception("frame", frame);
  res.json({ ...frame, memory: ingest });
});

function broadcastPerception(
  kind: "transcribe" | "caption" | "frame",
  data: TranscribeResult | CaptionResult | FrameResult,
): void {
  // Truncated preview — raw audio/image bytes never enter the bus.
  let previewSource: string;
  if (kind === "transcribe") {
    previewSource = (data as TranscribeResult).text;
  } else if (kind === "caption") {
    previewSource = (data as CaptionResult).caption;
  } else {
    // frame: FrameResult has no single caption — preview the strongest element
    // captions, falling back to the OCR text.
    const frame = data as FrameResult;
    const captions = frame.elements
      .map((e) => e.caption.trim())
      .filter((c) => c.length > 0)
      .slice(0, 3)
      .join("; ");
    previewSource = captions || frame.ocrText;
  }
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
