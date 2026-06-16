// Creativity engine — distant-concept recombination.
//
// The master vision asks for creativity to "emerge from memory interaction":
// combine distant concepts into ideas / hypotheses. Today creativity is only a
// DNA trait that biases answer temperature — there is no first-class engine that
// actually recombines memories. This module is that engine:
//
//   sampleCandidates() — a random handful of memories.
//   mostDistantPair()  — the two that are LEAST lexically similar (the most
//                        unexpected juxtaposition). PURE.
//   runCreativeCycle() — bridge that pair with ONE cheap LLM call, store the
//                        idea as a retrievable memory + a `creative_ideas` row,
//                        and emit a cognition event so the inner-life stream
//                        shows it. The Creativity cortex (core/workspace.ts)
//                        bids from pendingIdeasForWorkspace().
//
// Discipline (the workspace.ts / beliefs.ts contract): the distance math is pure
// + exported (selfcheck-driven, no DB); the connector is injectable; every DB
// touch is failure-isolated; runs only on the workspace cadence behind
// CONFIG.creativityEnabled (default OFF — it spends an LLM call per cycle).

import { createHash } from "node:crypto";
import { ulid } from "ulid";
import { openDb } from "../db/sqlite.js";
import { surfaceError } from "../util/diagnostics.js";
import { tokens } from "../attention/saliency.js";
import { getEventBus, nowIso, type BrainBus } from "./eventBus.js";
import { clampMagnitude, regionsFor } from "../../../shared/cognition.js";
import { getDefaultConnectorInstance } from "../connectors/registry.js";
import type { Connector } from "../connectors/Connector.js";
import { upsertMemoryPoint } from "../db/repositories/memory.js";
import type { CreativeIdea, CreativeIdeaStatus, CreativityStats } from "../../../shared/creativity.js";

export const CANDIDATE_SAMPLE = 10; // memories drawn per cycle
export const MIN_DISTANCE = 0.6; // a pair must be at least this distant to bother
export const CREATIVE_IMPORTANCE = 0.5;
export const MAX_SEED_CHARS = 600; // truncate each seed in the prompt

const CREATIVE_SYSTEM = `You are the creative-recombination process of a personal knowledge brain. You are given TWO unrelated notes from memory. Find ONE genuinely novel idea, hypothesis, analogy, or connection that bridges them — something neither note states on its own. 2-3 sentences. Output plain text only — no preamble, no JSON.`;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// -----------------------------------------------------------------------------
// PURE distance math — the selfcheck drives these directly (no DB).
// -----------------------------------------------------------------------------

export interface SeedItem {
  id: string;
  content: string;
}

/** Jaccard similarity over token sets, [0,1]. */
export function jaccard(a: ReadonlyArray<string>, b: ReadonlyArray<string>): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Lexical distance between two memory contents, [0,1] (1 = nothing in common). */
export function lexicalDistance(a: string, b: string): number {
  return clamp01(1 - jaccard(tokens(a), tokens(b)));
}

/** Novelty of a recombination is its seed distance. */
export function noveltyOf(distance: number): number {
  return clamp01(distance);
}

/** The two items with the LOWEST lexical similarity. Pure. O(n²), n small. */
export function mostDistantPair(items: ReadonlyArray<SeedItem>): { a: SeedItem; b: SeedItem; distance: number } | null {
  if (items.length < 2) return null;
  let best: { a: SeedItem; b: SeedItem; distance: number } | null = null;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const distance = lexicalDistance(items[i].content, items[j].content);
      // Canonical tie-break: compare (a.id, b.id) as a tuple so ties resolve
      // deterministically AND consistently regardless of iteration order.
      let tieBreaks = false;
      if (best && distance === best.distance) {
        tieBreaks = items[i].id !== best.a.id ? items[i].id < best.a.id : items[j].id < best.b.id;
      }
      if (!best || distance > best.distance || tieBreaks) {
        best = { a: items[i], b: items[j], distance };
      }
    }
  }
  return best;
}

// -----------------------------------------------------------------------------
// Persistence (creative_ideas table).
// -----------------------------------------------------------------------------

interface IdeaRow {
  id: string;
  seed_a: string;
  seed_b: string;
  idea: string;
  novelty: number;
  status: string;
  memory_id: string | null;
  created_at: string;
}

function rowToIdea(row: IdeaRow): CreativeIdea {
  const status = (["pending", "surfaced", "kept"] as const).includes(row.status as CreativeIdeaStatus)
    ? (row.status as CreativeIdeaStatus)
    : "pending";
  return {
    id: row.id,
    seedMemoryIds: [row.seed_a, row.seed_b],
    idea: row.idea,
    novelty: row.novelty,
    status,
    memoryId: row.memory_id,
    createdAt: row.created_at,
  };
}

function sampleCandidates(limit: number): SeedItem[] {
  const rows = openDb()
    .prepare(
      `SELECT id, content FROM memory_points
       WHERE content IS NOT NULL AND length(content) > 20
         AND (metadata IS NULL OR metadata NOT LIKE '%"kind":"creative-idea"%')
       ORDER BY RANDOM() LIMIT ?`,
    )
    .all(Math.min(50, Math.max(2, limit))) as Array<{ id: string; content: string }>;
  return rows.map((r) => ({ id: r.id, content: r.content }));
}

// -----------------------------------------------------------------------------
// The cycle.
// -----------------------------------------------------------------------------

export interface CreativeOptions {
  /** Injectable for the hermetic selfcheck. Defaults to the registry default. */
  connector?: Connector | null;
  /** Injectable bus for the selfcheck; defaults to the global event bus. */
  bus?: BrainBus;
}

export interface CreativeReport {
  sampled: number;
  pair: { aId: string; bId: string; distance: number } | null;
  ideaId: string | null;
  memoryId: string | null;
  idea: string | null;
  reason?: string;
}

function emitCreativeCognition(bus: BrainBus, idea: string, novelty: number): void {
  try {
    const now = nowIso();
    bus.emit({
      kind: "cognition",
      event: {
        kind: "thought",
        label: `Creative connection: ${idea.slice(0, 140)}`,
        detail: `recombined two distant memories (novelty ${novelty.toFixed(2)})`,
        magnitude: clampMagnitude(0.4 + 0.5 * novelty),
        logicalRegions: regionsFor("thought"),
        reason: "creativity:recombination",
        at: now,
      },
      at: now,
    });
  } catch (err) {
    surfaceError("creativity.emit", err);
  }
}

export async function runCreativeCycle(opts: CreativeOptions = {}): Promise<CreativeReport> {
  let candidates: SeedItem[] = [];
  try {
    candidates = sampleCandidates(CANDIDATE_SAMPLE);
  } catch (err) {
    surfaceError("creativity.sample", err);
  }
  if (candidates.length < 2) {
    return { sampled: candidates.length, pair: null, ideaId: null, memoryId: null, idea: null, reason: "too few memories" };
  }
  const pair = mostDistantPair(candidates);
  const pairInfo = pair ? { aId: pair.a.id, bId: pair.b.id, distance: pair.distance } : null;
  if (!pair || pair.distance < MIN_DISTANCE) {
    return { sampled: candidates.length, pair: pairInfo, ideaId: null, memoryId: null, idea: null, reason: "no distant pair" };
  }
  const connector = opts.connector !== undefined ? opts.connector : getDefaultConnectorInstance();
  if (!connector) {
    return { sampled: candidates.length, pair: pairInfo, ideaId: null, memoryId: null, idea: null, reason: "no connector" };
  }

  try {
    const prompt = `Note A:\n${pair.a.content.slice(0, MAX_SEED_CHARS)}\n\nNote B:\n${pair.b.content.slice(0, MAX_SEED_CHARS)}`;
    const idea = (await connector.send(prompt, { system: CREATIVE_SYSTEM, temperature: 0.85, maxTokens: 220 })).trim();
    if (idea.length === 0) {
      return { sampled: candidates.length, pair: pairInfo, ideaId: null, memoryId: null, idea: null, reason: "empty idea" };
    }
    const novelty = noveltyOf(pair.distance);
    const content = `Creative idea (recombination): ${idea}`;
    const memory = upsertMemoryPoint({
      sourceType: "manual",
      title: idea.slice(0, 80),
      content,
      contentHash: createHash("sha1").update(content).digest("hex"),
      importance: CREATIVE_IMPORTANCE,
      metadata: { kind: "creative-idea", seedMemoryIds: [pair.a.id, pair.b.id], novelty, source: "creativity" },
    });
    const ideaId = `idea-${ulid()}`;
    const now = nowIso();
    let ideaPersisted = false;
    try {
      openDb()
        .prepare(
          `INSERT INTO creative_ideas (id, seed_a, seed_b, idea, novelty, status, memory_id, created_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(ideaId, pair.a.id, pair.b.id, idea, novelty, memory.id, now);
      ideaPersisted = true;
    } catch (err) {
      surfaceError("creativity.persist", err);
    }
    emitCreativeCognition(opts.bus ?? getEventBus(), idea, novelty);
    // The memory is written regardless; only report an ideaId the table actually
    // holds, so the caller can't act on a row that was never created.
    return {
      sampled: candidates.length,
      pair: pairInfo,
      ideaId: ideaPersisted ? ideaId : null,
      memoryId: memory.id,
      idea,
      reason: ideaPersisted ? undefined : "idea row not persisted",
    };
  } catch (err) {
    surfaceError("creativity.cycle", err);
    return { sampled: candidates.length, pair: pairInfo, ideaId: null, memoryId: null, idea: null, reason: "synthesis failed" };
  }
}

// -----------------------------------------------------------------------------
// Reads — the workspace bidder + the route surface.
// -----------------------------------------------------------------------------

/** The freshest pending ideas — the Creativity cortex's bid source. */
export function pendingIdeasForWorkspace(limit = 3): CreativeIdea[] {
  try {
    const rows = openDb()
      .prepare(`SELECT * FROM creative_ideas WHERE status = 'pending' ORDER BY created_at DESC LIMIT ?`)
      .all(Math.min(20, Math.max(1, limit))) as IdeaRow[];
    return rows.map(rowToIdea);
  } catch (err) {
    surfaceError("creativity.pending", err);
    return [];
  }
}

export function listIdeas(limit = 50): CreativeIdea[] {
  try {
    const rows = openDb()
      .prepare(`SELECT * FROM creative_ideas ORDER BY created_at DESC LIMIT ?`)
      .all(Math.min(200, Math.max(1, limit))) as IdeaRow[];
    return rows.map(rowToIdea);
  } catch (err) {
    surfaceError("creativity.list", err);
    return [];
  }
}

/** Mark an idea as surfaced (e.g. when the workspace picks it up). */
export function markSurfaced(id: string): void {
  try {
    openDb().prepare(`UPDATE creative_ideas SET status = 'surfaced' WHERE id = ? AND status = 'pending'`).run(id);
  } catch (err) {
    surfaceError("creativity.markSurfaced", err);
  }
}

export function creativityStats(): CreativityStats {
  try {
    const rows = openDb()
      .prepare(`SELECT status, COUNT(*) AS n, AVG(novelty) AS avg_nov FROM creative_ideas GROUP BY status`)
      .all() as Array<{ status: string; n: number; avg_nov: number }>;
    const stats: CreativityStats = { total: 0, pending: 0, surfaced: 0, kept: 0, avgNovelty: 0 };
    let novSum = 0;
    for (const r of rows) {
      stats.total += r.n;
      novSum += (r.avg_nov ?? 0) * r.n;
      if (r.status === "pending") stats.pending = r.n;
      else if (r.status === "surfaced") stats.surfaced = r.n;
      else if (r.status === "kept") stats.kept = r.n;
    }
    stats.avgNovelty = stats.total > 0 ? novSum / stats.total : 0;
    return stats;
  } catch (err) {
    surfaceError("creativity.stats", err);
    return { total: 0, pending: 0, surfaced: 0, kept: 0, avgNovelty: 0 };
  }
}
