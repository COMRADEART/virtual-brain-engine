import { openDb } from "../db/sqlite.js";
import type {
  VisualMemory,
  VisualRegion,
  VisualWorkflowState,
  VisualSearchQuery,
  VisualSearchResult,
} from "../../../shared/vision.js";
import type { UIDetectionResult, DetectedUIRegion } from "./types.js";
import { randomUUID } from "crypto";

const VISUAL_DIR = "visual";

function getVisualDir(): string {
  const dataDir = process.env.DATA_DIR ?? "./data";
  return `${dataDir}/${VISUAL_DIR}`;
}

function ensureVisualDir(): void {
  const dir = getVisualDir();
  require("fs").mkdirSync(dir, { recursive: true });
  require("fs").mkdirSync(`${dir}/thumbnails`, { recursive: true });
}

export function saveVisualMemory(
  screenshotPath: string,
  width: number,
  height: number,
  timestamp: number,
  sourceApp: string | null,
  windowTitle: string | null,
  monitorIndex: number,
  hash: string,
  regions: DetectedUIRegion[]
): VisualMemory {
  ensureVisualDir();
  const db = openDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  const thumbnailPath = `${getVisualDir()}/thumbnails/${id}.png`;

  const tags: string[] = [];
  if (sourceApp) tags.push(sourceApp.toLowerCase());
  if (windowTitle) {
    const words = windowTitle.toLowerCase().split(/\s+/);
    tags.push(...words.filter((w) => w.length > 2).slice(0, 5));
  }

  db.prepare(
    `INSERT INTO visual_memory
     (id, screenshot_path, thumbnail_path, width, height, capture_timestamp,
      source_app, window_title, monitor_index, hash, tags, annotation, linked_memory_ids, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    screenshotPath,
    thumbnailPath,
    width,
    height,
    timestamp,
    sourceApp,
    windowTitle,
    monitorIndex,
    hash,
    JSON.stringify(tags),
    null,
    "[]",
    now
  );

  for (const region of regions) {
    const regionId = randomUUID();
    db.prepare(
      `INSERT INTO visual_regions
       (id, visual_memory_id, region_type, bounding_box_x, bounding_box_y,
        bounding_box_width, bounding_box_height, confidence, detected_text, detected_app, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      regionId,
      id,
      region.type,
      region.x,
      region.y,
      region.width,
      region.height,
      region.confidence,
      region.label || null,
      region.app || null,
      JSON.stringify({}),
      now
    );
  }

  return {
    id,
    screenshotPath,
    thumbnailPath,
    width,
    height,
    captureTimestamp: timestamp,
    sourceApp,
    windowTitle,
    monitorIndex,
    hash,
    tags,
    annotation: null,
    linkedMemoryIds: [],
    createdAt: now,
  };
}

export function getVisualMemory(id: string): VisualMemory | null {
  const db = openDb();
  const row = db
    .prepare(
      `SELECT id, screenshot_path, thumbnail_path, width, height, capture_timestamp,
              source_app, window_title, monitor_index, hash, tags, annotation, linked_memory_ids, created_at
       FROM visual_memory WHERE id = ?`
    )
    .get(id) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    id: row.id as string,
    screenshotPath: row.screenshot_path as string,
    thumbnailPath: row.thumbnail_path as string | null,
    width: row.width as number,
    height: row.height as number,
    captureTimestamp: row.capture_timestamp as number,
    sourceApp: row.source_app as string | null,
    windowTitle: row.window_title as string | null,
    monitorIndex: row.monitor_index as number,
    hash: row.hash as string,
    tags: JSON.parse((row.tags as string) || "[]"),
    annotation: row.annotation as string | null,
    linkedMemoryIds: JSON.parse((row.linked_memory_ids as string) || "[]"),
    createdAt: row.created_at as string,
  };
}

export function getVisualRegions(memoryId: string): VisualRegion[] {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT id, visual_memory_id, region_type, bounding_box_x, bounding_box_y,
              bounding_box_width, bounding_box_height, confidence, detected_text, detected_app, metadata, created_at
       FROM visual_regions WHERE visual_memory_id = ?`
    )
    .all(memoryId) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row.id as string,
    visualMemoryId: row.visual_memory_id as string,
    regionType: row.region_type as VisualRegion["regionType"],
    boundingBox: {
      x: row.bounding_box_x as number,
      y: row.bounding_box_y as number,
      width: row.bounding_box_width as number,
      height: row.bounding_box_height as number,
    },
    confidence: row.confidence as number,
    detectedText: row.detected_text as string | null,
    detectedApp: row.detected_app as string | null,
    metadata: JSON.parse((row.metadata as string) || "{}"),
    createdAt: row.created_at as string,
  }));
}

export function listVisualMemories(
  query: VisualSearchQuery = {}
): VisualSearchResult[] {
  const db = openDb();
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;

  let sql = `SELECT * FROM visual_memory WHERE 1=1`;
  const params: unknown[] = [];

  if (query.app) {
    sql += ` AND source_app LIKE ?`;
    params.push(`%${query.app}%`);
  }

  if (query.timeRange) {
    sql += ` AND capture_timestamp >= ? AND capture_timestamp <= ?`;
    params.push(query.timeRange.start, query.timeRange.end);
  }

  sql += ` ORDER BY capture_timestamp DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];

  return rows.map((row) => {
    const memory: VisualMemory = {
      id: row.id as string,
      screenshotPath: row.screenshot_path as string,
      thumbnailPath: row.thumbnail_path as string | null,
      width: row.width as number,
      height: row.height as number,
      captureTimestamp: row.capture_timestamp as number,
      sourceApp: row.source_app as string | null,
      windowTitle: row.window_title as string | null,
      monitorIndex: row.monitor_index as number,
      hash: row.hash as string,
      tags: JSON.parse((row.tags as string) || "[]"),
      annotation: row.annotation as string | null,
      linkedMemoryIds: JSON.parse((row.linked_memory_ids as string) || "[]"),
      createdAt: row.created_at as string,
    };

    const regions = getVisualRegions(memory.id);

    let relevanceScore = 0.5;
    if (query.text) {
      const searchLower = query.text.toLowerCase();
      if (
        memory.windowTitle?.toLowerCase().includes(searchLower) ||
        memory.sourceApp?.toLowerCase().includes(searchLower) ||
        regions.some(
          (r) =>
            r.detectedText?.toLowerCase().includes(searchLower) ||
            r.detectedApp?.toLowerCase().includes(searchLower)
        )
      ) {
        relevanceScore = 0.9;
      }
    }

    if (query.regionType) {
      if (regions.some((r) => r.regionType === query.regionType)) {
        relevanceScore = Math.max(relevanceScore, 0.8);
      }
    }

    return {
      memory,
      regions,
      relevanceScore,
    };
  });
}

export function deleteVisualMemory(id: string): boolean {
  const db = openDb();

  const memory = getVisualMemory(id);
  if (!memory) return false;

  try {
    const fs = require("fs");
    if (fs.existsSync(memory.screenshotPath)) {
      fs.unlinkSync(memory.screenshotPath);
    }
    if (memory.thumbnailPath && fs.existsSync(memory.thumbnailPath)) {
      fs.unlinkSync(memory.thumbnailPath);
    }
  } catch {
  }

  db.prepare(`DELETE FROM visual_regions WHERE visual_memory_id = ?`).run(id);
  db.prepare(`DELETE FROM visual_memory WHERE id = ?`).run(id);

  return true;
}

export function updateVisualMemoryAnnotation(
  id: string,
  annotation: string
): boolean {
  const db = openDb();
  const result = db
    .prepare(`UPDATE visual_memory SET annotation = ? WHERE id = ?`)
    .run(annotation, id);
  return result.changes > 0;
}

export function linkMemoryToVisualMemory(
  visualMemoryId: string,
  memoryId: string
): boolean {
  const db = openDb();
  const row = db
    .prepare(`SELECT linked_memory_ids FROM visual_memory WHERE id = ?`)
    .get(visualMemoryId) as { linked_memory_ids: string } | undefined;

  if (!row) return false;

  const linked = JSON.parse(row.linked_memory_ids || "[]") as string[];
  if (!linked.includes(memoryId)) {
    linked.push(memoryId);
    db.prepare(`UPDATE visual_memory SET linked_memory_ids = ? WHERE id = ?`).run(
      JSON.stringify(linked),
      visualMemoryId
    );
  }

  return true;
}

export function saveWorkflowState(
  name: string,
  entryScreenshotId: string | null,
  exitScreenshotId: string | null,
  trigger: string | null,
  durationMs: number | null
): VisualWorkflowState {
  const db = openDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  const existing = db
    .prepare(`SELECT * FROM visual_workflow_states WHERE name = ? ORDER BY created_at DESC LIMIT 1`)
    .get(name) as Record<string, unknown> | undefined;

  if (existing) {
    const newFrequency = (existing.frequency as number) + 1;
    const totalDuration =
      ((existing.avg_duration_ms as number) || 0) * (existing.frequency as number) + (durationMs || 0);
    const avgDuration = Math.round(totalDuration / newFrequency);

    db.prepare(
      `UPDATE visual_workflow_states SET
       exit_screenshot_id = ?, transition_trigger = ?, frequency = ?, avg_duration_ms = ?, created_at = ?
       WHERE id = ?`
    ).run(exitScreenshotId, trigger, newFrequency, avgDuration, now, existing.id);

    return {
      id: existing.id as string,
      name: existing.name as string,
      entryScreenshotId: existing.entry_screenshot_id as string | null,
      exitScreenshotId,
      transitionTrigger: trigger,
      frequency: newFrequency,
      avgDurationMs: avgDuration,
      tags: JSON.parse((existing.tags as string) || "[]"),
      createdAt: now,
    };
  }

  db.prepare(
    `INSERT INTO visual_workflow_states
     (id, name, entry_screenshot_id, exit_screenshot_id, transition_trigger, frequency, avg_duration_ms, tags, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, entryScreenshotId, exitScreenshotId, trigger, 1, durationMs, "[]", now);

  return {
    id,
    name,
    entryScreenshotId,
    exitScreenshotId,
    transitionTrigger: trigger,
    frequency: 1,
    avgDurationMs: durationMs,
    tags: [],
    createdAt: now,
  };
}

export function getRecentWorkflows(limit = 20): VisualWorkflowState[] {
  const db = openDb();
  const rows = db
    .prepare(`SELECT * FROM visual_workflow_states ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    entryScreenshotId: row.entry_screenshot_id as string | null,
    exitScreenshotId: row.exit_screenshot_id as string | null,
    transitionTrigger: row.transition_trigger as string | null,
    frequency: row.frequency as number,
    avgDurationMs: row.avg_duration_ms as number | null,
    tags: JSON.parse((row.tags as string) || "[]"),
    createdAt: row.created_at as string,
  }));
}

export function getVisualMemoryStats(): {
  total: number;
  byApp: Record<string, number>;
  recentCount: number;
  oldestTimestamp: number | null;
} {
  const db = openDb();

  const total = (db.prepare(`SELECT COUNT(*) as count FROM visual_memory`).get() as { count: number })
    .count;

  const byAppRows = db
    .prepare(
      `SELECT source_app, COUNT(*) as count FROM visual_memory
       WHERE source_app IS NOT NULL GROUP BY source_app`
    )
    .all() as { source_app: string; count: number }[];

  const byApp: Record<string, number> = {};
  for (const row of byAppRows) {
    byApp[row.source_app] = row.count;
  }

  const recent = db
    .prepare(`SELECT capture_timestamp FROM visual_memory ORDER BY capture_timestamp DESC LIMIT 1`)
    .get() as { capture_timestamp: number } | undefined;

  const oldest = db
    .prepare(`SELECT capture_timestamp FROM visual_memory ORDER BY capture_timestamp ASC LIMIT 1`)
    .get() as { capture_timestamp: number } | undefined;

  return {
    total,
    byApp,
    recentCount: recent ? 1 : 0,
    oldestTimestamp: oldest?.capture_timestamp ?? null,
  };
}