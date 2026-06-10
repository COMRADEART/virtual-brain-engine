// Event segmentation — bind continuous experience into EPISODES.
//
// Brains don't store experience as independent chunks; they segment it into
// events ("the meeting", "the debugging session") with a start, an end, and
// members. The classic boundary trigger is a prediction-error / context
// shift — approximated here with the two cheap signals that need no model:
// a TIME GAP between consecutive items, or a TOKEN-SET SHIFT (low lexical
// overlap with the running episode).
//
// The builder runs on the sleep schedule (and via POST /api/brain/episodes):
//   1. gather memory points created since the watermark (newest experience,
//      excluding derived kinds — episodes of episodes would be noise);
//   2. segment them on the pure boundary detector;
//   3. store each COMPLETE episode (the trailing group is left open — it may
//      still be growing — so re-runs are idempotent via the watermark);
//   4. write each episode its own retrievable memory point ("Episode: …")
//      so vector/keyword search can answer "what was I doing on Tuesday".
//
// Pure segmentation exported for the selfcheck; everything else is bounded
// and failure-isolated.

import { ulid } from "ulid";
import { createHash } from "node:crypto";
import { openDb } from "../db/sqlite.js";
import { surfaceError } from "../util/diagnostics.js";
import { tokens } from "../attention/saliency.js";
import { upsertMemoryPoint } from "../db/repositories/memory.js";

export interface TimelineItem {
  id: string;
  /** ms epoch. */
  at: number;
  content: string;
}

export interface EpisodeRecord {
  id: string;
  startedAt: string;
  endedAt: string;
  title: string;
  itemCount: number;
  itemIds: string[];
  memoryId: string | null;
  createdAt: string;
}

export interface EpisodeBuildReport {
  scanned: number;
  segmented: number;
  stored: number;
  openTail: number;
  reason?: string;
}

// A gap this long between consecutive items always starts a new episode.
export const BOUNDARY_GAP_MS = 30 * 60_000;
// Token overlap with the running episode below this ALSO starts one
// (content shift without a time gap — e.g. switching projects mid-hour).
export const BOUNDARY_SIM_FLOOR = 0.08;
// Episodes need at least this many members to be worth storing.
export const MIN_EPISODE_ITEMS = 2;
// Bounds per build run.
export const SCAN_LIMIT = 200;
export const MAX_MEMBER_IDS = 50;

const WATERMARK_KEY = "episodes-watermark-v1";

function clampTitle(s: string): string {
  return s.trim().slice(0, 80) || "(untitled episode)";
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// -----------------------------------------------------------------------------
// PURE segmentation.
// -----------------------------------------------------------------------------

/**
 * Split a time-ordered item list into episodes. A boundary opens before item i
 * when the gap since item i-1 exceeds `gapMs`, OR the item's token overlap
 * with the RUNNING episode's accumulated token set falls below `simFloor`
 * (both sides non-empty). Deterministic; input order is normalised by time.
 */
export function segmentTimeline(
  items: ReadonlyArray<TimelineItem>,
  opts: { gapMs?: number; simFloor?: number } = {},
): TimelineItem[][] {
  const gapMs = opts.gapMs ?? BOUNDARY_GAP_MS;
  const simFloor = opts.simFloor ?? BOUNDARY_SIM_FLOOR;
  const sorted = [...items].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  const groups: TimelineItem[][] = [];
  let current: TimelineItem[] = [];
  let currentTokens = new Set<string>();

  for (const item of sorted) {
    const itemTokens = new Set(tokens(item.content));
    if (current.length === 0) {
      current = [item];
      currentTokens = itemTokens;
      continue;
    }
    const prev = current[current.length - 1];
    const timeBoundary = item.at - prev.at > gapMs;
    const contentBoundary =
      currentTokens.size > 0 && itemTokens.size > 0 && jaccard(currentTokens, itemTokens) < simFloor;
    if (timeBoundary || contentBoundary) {
      groups.push(current);
      current = [item];
      currentTokens = itemTokens;
    } else {
      current.push(item);
      for (const t of itemTokens) currentTokens.add(t);
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** Title = the episode's most frequent salient tokens. Pure, deterministic. */
export function titleForEpisode(items: ReadonlyArray<TimelineItem>): string {
  const freq = new Map<string, number>();
  for (const item of items) {
    for (const t of new Set(tokens(item.content))) {
      freq.set(t, (freq.get(t) ?? 0) + 1);
    }
  }
  const top = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 4)
    .map(([t]) => t);
  return clampTitle(top.length > 0 ? top.join(" · ") : "activity");
}

// -----------------------------------------------------------------------------
// Builder + queries.
// -----------------------------------------------------------------------------

function readWatermark(): string | null {
  try {
    const row = openDb()
      .prepare("SELECT value FROM brain_metadata WHERE key = ?")
      .get(WATERMARK_KEY) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function writeWatermark(iso: string): void {
  try {
    openDb()
      .prepare(
        "INSERT INTO brain_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(WATERMARK_KEY, iso);
  } catch (err) {
    surfaceError("episodes.writeWatermark", err);
  }
}

/** Raw experience since the watermark — excludes derived/meta memory kinds. */
function gatherTimeline(sinceIso: string | null): TimelineItem[] {
  try {
    const rows = openDb()
      .prepare<unknown[], { id: string; content: string; created_at: string }>(
        `SELECT id, content, created_at FROM memory_points
         WHERE (? IS NULL OR created_at > ?)
           AND (
             json_extract(metadata, '$.kind') IS NULL
             OR json_extract(metadata, '$.kind') NOT IN ('episode', 'workspace-thought', 'semantic')
           )
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(sinceIso, sinceIso, SCAN_LIMIT);
    return rows
      .map((r) => ({ id: r.id, at: Date.parse(r.created_at), content: r.content }))
      .filter((r) => Number.isFinite(r.at));
  } catch (err) {
    surfaceError("episodes.gatherTimeline", err);
    return [];
  }
}

/**
 * Segment new experience into episodes and store the complete ones. The
 * trailing group is treated as still-open (the next run revisits it via the
 * watermark), which is what makes repeated runs idempotent.
 */
export function buildEpisodes(): EpisodeBuildReport {
  const items = gatherTimeline(readWatermark());
  const report: EpisodeBuildReport = { scanned: items.length, segmented: 0, stored: 0, openTail: 0 };
  if (items.length === 0) {
    report.reason = "no new experience since the watermark";
    return report;
  }
  const groups = segmentTimeline(items);
  report.segmented = groups.length;
  // Leave the trailing group open: it may still be accumulating items.
  const complete = groups.slice(0, -1);
  report.openTail = groups[groups.length - 1]?.length ?? 0;
  if (complete.length === 0) {
    report.reason = "only an open trailing episode — nothing to store yet";
    return report;
  }

  try {
    const db = openDb();
    const insert = db.prepare(
      `INSERT INTO episodes (id, started_at, ended_at, title, item_count, item_ids, memory_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let lastEnd: string | null = null;
    for (const group of complete) {
      if (group.length < MIN_EPISODE_ITEMS) {
        lastEnd = new Date(group[group.length - 1].at).toISOString();
        continue;
      }
      const startedAt = new Date(group[0].at).toISOString();
      const endedAt = new Date(group[group.length - 1].at).toISOString();
      const title = titleForEpisode(group);
      // The episode's own retrievable memory: a compact narrative the vector
      // index can hit for "what was I doing …" questions. Content-hash dedup
      // in upsert makes re-storing the same episode a no-op.
      const summaryLines = group.slice(0, 8).map((g) => `- ${g.content.trim().slice(0, 100)}`);
      const content = `Episode: ${title}\nFrom ${startedAt} to ${endedAt} (${group.length} moments)\n${summaryLines.join("\n")}`;
      let memoryId: string | null = null;
      try {
        const mem = upsertMemoryPoint({
          sourceType: "manual",
          title: `Episode: ${title}`,
          content,
          contentHash: createHash("sha1").update(content).digest("hex"),
          importance: 0.55,
          metadata: { kind: "episode", startedAt, endedAt, itemCount: group.length },
        });
        memoryId = mem.id;
      } catch (err) {
        surfaceError("episodes.episodeMemory", err);
      }
      insert.run(
        `ep-${ulid()}`,
        startedAt,
        endedAt,
        title,
        group.length,
        JSON.stringify(group.slice(0, MAX_MEMBER_IDS).map((g) => g.id)),
        memoryId,
        new Date().toISOString(),
      );
      report.stored += 1;
      lastEnd = endedAt;
    }
    if (lastEnd) writeWatermark(lastEnd);
  } catch (err) {
    surfaceError("episodes.buildEpisodes", err);
  }
  return report;
}

/** Most recent episodes, optionally only those overlapping a given ISO day. */
export function listEpisodes(limit = 20, day?: string): EpisodeRecord[] {
  try {
    const db = openDb();
    type Row = {
      id: string;
      started_at: string;
      ended_at: string;
      title: string;
      item_count: number;
      item_ids: string;
      memory_id: string | null;
      created_at: string;
    };
    const rows = day
      ? db
          .prepare<[string, number], Row>(
            `SELECT * FROM episodes WHERE date(started_at) = date(?) ORDER BY started_at DESC LIMIT ?`,
          )
          .all(day, limit)
      : db.prepare<[number], Row>(`SELECT * FROM episodes ORDER BY started_at DESC LIMIT ?`).all(limit);
    return rows.map((r) => ({
      id: r.id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      title: r.title,
      itemCount: r.item_count,
      itemIds: safeIds(r.item_ids),
      memoryId: r.memory_id,
      createdAt: r.created_at,
    }));
  } catch (err) {
    surfaceError("episodes.listEpisodes", err);
    return [];
  }
}

function safeIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
