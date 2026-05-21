import { Router } from "express";
import { captureScreen, captureRegion, getMonitors, getVisionConfig, saveVisionConfig } from "./capture.js";
import {
  saveVisualMemory,
  getVisualMemory,
  getVisualRegions,
  listVisualMemories,
  deleteVisualMemory,
  updateVisualMemoryAnnotation,
  linkMemoryToVisualMemory,
  saveWorkflowState,
  getRecentWorkflows,
  getVisualMemoryStats,
} from "./visualMemory.js";
import { detectUIRegions, detectUIStateFromRegions, inferWindowTypeFromTitle } from "./uiDetector.js";
import type { VisualSearchQuery } from "../../../shared/vision.js";
import { broadcast } from "../ws/brainBus.js";

export const visionRouter = Router();

visionRouter.post("/vision/capture", async (_req, res) => {
  try {
    const capture = await captureScreen();

    if (!capture.success) {
      return res.status(500).json({ error: capture.error || "Capture failed" });
    }

    const windowInfo = await getActiveWindowInfo();
    const uiDetection = detectUIRegions(
      capture.imageData || "",
      capture.width,
      capture.height,
      windowInfo?.title
    );

    const memory = saveVisualMemory(
      `visual/capture_${capture.timestamp}.png`,
      capture.width,
      capture.height,
      capture.timestamp,
      windowInfo?.appName ?? null,
      windowInfo?.title ?? null,
      capture.monitorIndex,
      hashCapture(capture.imageData || ""),
      uiDetection.regions
    );

    broadcast({
      type: "screen-captured",
      capture,
    });

    broadcast({
      type: "visual-memory-created",
      memory,
    });

    broadcast({
      type: "visual-regions-detected",
      regions: uiDetection.regions.map((r) => ({
        id: `region-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        visualMemoryId: memory.id,
        regionType: r.type as "window" | "panel" | "button" | "text" | "diagram" | "terminal" | "ide" | "browser" | "unknown",
        boundingBox: {
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
        },
        confidence: r.confidence,
        detectedText: r.label,
        detectedApp: r.app ?? null,
        metadata: {},
        createdAt: new Date().toISOString(),
      })),
      memoryId: memory.id,
    });

    res.json({
      capture,
      memory,
      regions: uiDetection.regions,
      uiState: detectUIStateFromRegions(uiDetection.regions, windowInfo?.title),
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    broadcast({ type: "vision-error", error });
    res.status(500).json({ error });
  }
});

visionRouter.post("/vision/capture/region", async (req, res) => {
  try {
    const { x, y, width, height } = req.body;

    if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number") {
      return res.status(400).json({ error: "Invalid region coordinates" });
    }

    const capture = await captureRegion(x, y, width, height);

    if (!capture.success) {
      return res.status(500).json({ error: capture.error || "Region capture failed" });
    }

    const windowInfo = await getActiveWindowInfo();
    const uiDetection = detectUIRegions(
      capture.imageData || "",
      capture.width,
      capture.height,
      windowInfo?.title
    );

    const memory = saveVisualMemory(
      `visual/region_${capture.timestamp}.png`,
      capture.width,
      capture.height,
      capture.timestamp,
      windowInfo?.appName ?? null,
      windowInfo?.title ?? null,
      capture.monitorIndex,
      hashCapture(capture.imageData || ""),
      uiDetection.regions
    );

    broadcast({
      type: "screen-captured",
      capture,
    });

    broadcast({
      type: "visual-memory-created",
      memory,
    });

    res.json({
      capture,
      memory,
      regions: uiDetection.regions,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  }
});

visionRouter.get("/vision/memories", (req, res) => {
  try {
    const query: VisualSearchQuery = {};

    if (req.query.text) query.text = String(req.query.text);
    if (req.query.app) query.app = String(req.query.app);
    if (req.query.regionType) query.regionType = String(req.query.regionType) as VisualSearchQuery["regionType"];
    if (req.query.limit) query.limit = parseInt(String(req.query.limit), 10);
    if (req.query.offset) query.offset = parseInt(String(req.query.offset), 10);

    if (req.query.start && req.query.end) {
      query.timeRange = {
        start: parseInt(String(req.query.start), 10),
        end: parseInt(String(req.query.end), 10),
      };
    }

    const results = listVisualMemories(query);
    res.json({ results, total: results.length });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  }
});

visionRouter.get("/vision/memories/:id", (req, res) => {
  try {
    const memory = getVisualMemory(req.params.id);

    if (!memory) {
      return res.status(404).json({ error: "Visual memory not found" });
    }

    const regions = getVisualRegions(memory.id);

    res.json({ memory, regions });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  }
});

visionRouter.delete("/vision/memories/:id", (req, res) => {
  try {
    const deleted = deleteVisualMemory(req.params.id);

    if (!deleted) {
      return res.status(404).json({ error: "Visual memory not found" });
    }

    res.json({ success: true });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  }
});

visionRouter.patch("/vision/memories/:id/annotate", (req, res) => {
  try {
    const { annotation } = req.body;

    if (typeof annotation !== "string") {
      return res.status(400).json({ error: "Annotation must be a string" });
    }

    const updated = updateVisualMemoryAnnotation(req.params.id, annotation);

    if (!updated) {
      return res.status(404).json({ error: "Visual memory not found" });
    }

    res.json({ success: true });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  }
});

visionRouter.post("/vision/memories/:id/link/:memoryId", (req, res) => {
  try {
    const linked = linkMemoryToVisualMemory(req.params.id, req.params.memoryId);

    if (!linked) {
      return res.status(404).json({ error: "Visual memory not found" });
    }

    res.json({ success: true });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  }
});

visionRouter.get("/vision/workflows", (_req, res) => {
  try {
    const workflows = getRecentWorkflows(20);
    res.json({ workflows });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  }
});

visionRouter.get("/vision/stats", (_req, res) => {
  try {
    const stats = getVisualMemoryStats();
    res.json(stats);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  }
});

visionRouter.get("/vision/monitors", async (_req, res) => {
  try {
    const monitors = await getMonitors();
    res.json({ monitors });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  }
});

visionRouter.get("/vision/config", async (_req, res) => {
  try {
    const config = await getVisionConfig();

    if (!config) {
      return res.status(404).json({ error: "Vision config not found" });
    }

    res.json(config);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  }
});

visionRouter.post("/vision/config", async (req, res) => {
  try {
    const config = req.body;
    const saved = await saveVisionConfig(config);

    if (!saved) {
      return res.status(500).json({ error: "Failed to save vision config" });
    }

    broadcast({ type: "vision-enabled", enabled: config.enabled });

    res.json({ success: true });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  }
});

visionRouter.post("/vision/workflow", (req, res) => {
  try {
    const { name, entryScreenshotId, exitScreenshotId, trigger, durationMs } = req.body;

    if (typeof name !== "string" || !name) {
      return res.status(400).json({ error: "Workflow name is required" });
    }

    const workflow = saveWorkflowState(
      name,
      entryScreenshotId ?? null,
      exitScreenshotId ?? null,
      trigger ?? null,
      durationMs ?? null
    );

    broadcast({
      type: "workflow-detected",
      workflow,
    });

    res.json({ workflow });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  }
});

async function getActiveWindowInfo(): Promise<{ title: string; appName: string } | null> {
  return null;
}

function hashCapture(imageData: string): string {
  let hash = 0;
  for (let i = 0; i < Math.min(imageData.length, 1000); i++) {
    const char = imageData.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}