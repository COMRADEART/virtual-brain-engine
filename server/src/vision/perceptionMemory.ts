// Phase 2 (live perception) — turns a parsed screen frame into a RETRIEVABLE
// MemoryPoint, with the governance the design requires. This is the
// "make-it-real" half of perception: visualMemory.ts already persists the
// frame's pixels + UI regions, but those rows are NOT retrievable by /api/ask.
// This module bridges that gap by writing an embedded `source_type='manual'`
// MemoryPoint tagged `metadata.kind='perception'`, so a perception caption can
// surface as a citation alongside file + conversation memories.
//
// Two governance rules keep a high-frequency frame stream from polluting
// retrieval:
//
//   1. IMPORTANCE DISCOUNT. PERCEPTION_IMPORTANCE (0.35) sits deliberately
//      BELOW the 0.5 default so a steady stream of frames can't dominate the
//      top hits on /api/ask — a single passing screen is worth less than a
//      file chunk or a conversation the user actually had.
//
//   2. PERCEPTION-SCOPED DEDUP. A near-identical frame (cosine > DEDUP_COS
//      against the last N perception memories) is SKIPPED, not stored. This is
//      scoped to perception memories only: a frame identical to the previous
//      frame must be dropped even if it's "novel" versus the file corpus.
//      Without this, idling on one window would write a duplicate every tick.
//
// Everything is wrapped defensively: a DB failure surfaces via
// surfaceError("perception:ingest", err) and returns a no-store result — it
// never throws into the route.

import { createHash } from "node:crypto";
import { openDb, isVectorAvailable, type SqliteDatabase } from "../db/sqlite.js";
import { upsertMemoryPoint } from "../db/repositories/memory.js";
import { cosineSimilarity, getStoredEmbeddings } from "../memory/embeddingSimilarity.js";
import { linkMemoryToVisualMemory } from "./visualMemory.js";
import { surfaceError } from "../util/diagnostics.js";

/** Retrieval-side importance discount for perception memories (below the 0.5
 *  default) so a frame stream can't crowd out files/conversations on /api/ask. */
export const PERCEPTION_IMPORTANCE = 0.35;

/** Cosine threshold above which a new frame counts as a near-duplicate of a
 *  recent perception memory and is skipped. */
export const DEDUP_COS = 0.92;

/** How many recent perception memories to compare a new frame against. */
const DEDUP_LOOKBACK = 20;

/** Tiny importance nudge applied to the matched memory on a duplicate hit, so a
 *  repeatedly-seen frame slowly gains salience without storing N copies. Capped
 *  at 1.0 so a long idle stream can't drift it past a sane ceiling. */
const DUP_IMPORTANCE_BUMP = 0.01;

function sha1(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

export interface PerceptionIngestInput {
  /** Retrievable text — e.g. `${windowTitle ? windowTitle+': ' : ''}${caption}`
   *  plus an OCR excerpt. This is what /api/ask matches against. */
  content: string;
  /** Precomputed by the CALLER (the route embeds via the connector). When
   *  undefined the memory is stored without a vector and the dedup gate is
   *  skipped (no geometry to compare). */
  embedding?: number[];
  /** Optional visual_memory row to link this MemoryPoint back to. */
  visualMemoryId?: string;
  sourceApp?: string | null;
  windowTitle?: string | null;
  /** Defaults to PERCEPTION_IMPORTANCE. */
  importance?: number;
}

export interface PerceptionIngestResult {
  stored: boolean;
  memoryId?: string;
  reason: "stored" | "duplicate" | "empty";
}

// Newest-first ids of existing perception MemoryPoints. Scoped via the
// source_type + metadata.kind tags so dedup only ever compares against other
// perception frames (never files/conversations).
function recentPerceptionIds(db: SqliteDatabase, limit: number): string[] {
  const rows = db
    .prepare<[number], { id: string }>(
      `SELECT id FROM memory_points
       WHERE source_type = 'manual' AND json_extract(metadata, '$.kind') = 'perception'
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(limit);
  return rows.map((r) => r.id);
}

/** Count of perception MemoryPoints. Selfcheck helper. */
export function countPerceptionMemories(db: SqliteDatabase = openDb()): number {
  const row = db
    .prepare<[], { c: number }>(
      `SELECT count(*) AS c FROM memory_points
       WHERE source_type = 'manual' AND json_extract(metadata, '$.kind') = 'perception'`,
    )
    .get();
  return row?.c ?? 0;
}

/**
 * Ingest a parsed frame as a retrievable perception memory. See module header
 * for the two governance rules. Never throws — failures surface via
 * surfaceError and return { stored:false, reason:"empty" }.
 */
export async function ingestPerceptionMemory(
  input: PerceptionIngestInput,
  db: SqliteDatabase = openDb(),
): Promise<PerceptionIngestResult> {
  const content = input.content?.trim() ?? "";
  if (content.length === 0) {
    return { stored: false, reason: "empty" };
  }

  try {
    // --- Perception-scoped dedup gate (only when we have a vector to compare) ---
    if (input.embedding && isVectorAvailable()) {
      const ids = recentPerceptionIds(db, DEDUP_LOOKBACK);
      if (ids.length > 0) {
        const stored = getStoredEmbeddings(ids, db);
        let bestId: string | null = null;
        let bestSim = -1;
        for (const id of ids) {
          const cand = stored.get(id);
          if (!cand) continue;
          const sim = cosineSimilarity(input.embedding, cand);
          if (sim > bestSim) {
            bestSim = sim;
            bestId = id;
          }
        }
        if (bestId !== null && bestSim > DEDUP_COS) {
          // Near-identical frame — DON'T store a copy. Refresh the matched
          // memory's recency and nudge its importance (clamped to 1.0) so a
          // repeatedly-seen frame is treated as a little more salient.
          db.prepare(
            `UPDATE memory_points
             SET updated_at = ?, importance = MIN(1.0, importance + ?)
             WHERE id = ?`,
          ).run(new Date().toISOString(), DUP_IMPORTANCE_BUMP, bestId);
          return { stored: false, memoryId: bestId, reason: "duplicate" };
        }
      }
    }

    // --- Store a fresh perception memory ---
    const memory = upsertMemoryPoint({
      sourceType: "manual",
      filePath: null,
      projectName: "(perception)",
      title: input.windowTitle ?? null,
      content,
      // Always-unique hash: perception content can legitimately repeat across
      // distinct moments, and we already gate true near-duplicates above by
      // embedding. The +Date.now() keeps the scanner's content-hash dedup (keyed
      // on file_path, which is null here) from ever short-circuiting a store.
      contentHash: sha1(content + Date.now()),
      embedding: input.embedding,
      importance: input.importance ?? PERCEPTION_IMPORTANCE,
      metadata: {
        kind: "perception",
        sourceApp: input.sourceApp ?? null,
        windowTitle: input.windowTitle ?? null,
        visualMemoryId: input.visualMemoryId ?? null,
      },
    });

    if (input.visualMemoryId) {
      // NOTE arg order: visualMemoryId FIRST (see visualMemory.ts).
      linkMemoryToVisualMemory(input.visualMemoryId, memory.id);
    }

    return { stored: true, memoryId: memory.id, reason: "stored" };
  } catch (err) {
    surfaceError("perception:ingest", err);
    return { stored: false, reason: "empty" };
  }
}
