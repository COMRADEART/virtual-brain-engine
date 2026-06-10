import { Router } from "express";
import { z } from "zod";
import {
  deleteMemoryPoint,
  exportMemoryCorpus,
  getMemoryCount,
  getMemoryPoint,
  getRelationsFor,
  keywordSearch,
  listRecentMemories,
  vectorSearch,
} from "../db/repositories/memory.js";
import { getDefaultConnectorInstance } from "../connectors/registry.js";
import {
  getConsolidationStats,
  runConsolidationCycle,
} from "../memory/consolidationEngine.js";
import { listBackups, runBackup } from "../backup/index.js";
import { listTombstones, unmergePair } from "../memory/dedupAudit.js";

export const memoryRouter = Router();

const searchQuery = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  kind: z.enum(["chunk", "conversation", "manual"]).optional(),
  project: z.string().optional(),
});

memoryRouter.get("/memory/search", async (req, res) => {
  const parsed = searchQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { q, limit, kind, project } = parsed.data;

  // Try vector search first. If embeddings fail (Ollama down) fall back to LIKE.
  const connector = getDefaultConnectorInstance();
  let vectorHits: Awaited<ReturnType<typeof vectorSearch>> = [];
  let vectorError: string | undefined;
  if (connector?.embed) {
    try {
      const embedding = await connector.embed(q);
      vectorHits = vectorSearch(embedding, limit, {
        sourceType: kind,
        projectName: project,
      });
    } catch (err) {
      vectorError = err instanceof Error ? err.message : String(err);
    }
  }

  // Keyword pass always runs as a complementary signal; merge by id.
  const keywordHits = keywordSearch(q, limit);
  const merged = new Map<string, { score: number; matchType: "vector" | "keyword" | "hybrid"; memory: typeof keywordHits[number]["memory"] }>();
  for (const hit of vectorHits) {
    merged.set(hit.memory.id, { score: hit.score, matchType: "vector", memory: hit.memory });
  }
  for (const hit of keywordHits) {
    const existing = merged.get(hit.memory.id);
    if (existing) {
      existing.score = Math.max(existing.score, hit.score) + 0.05;
      existing.matchType = "hybrid";
    } else {
      merged.set(hit.memory.id, { score: hit.score, matchType: "keyword", memory: hit.memory });
    }
  }
  const out = Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  res.json({ hits: out, vectorError });
});

memoryRouter.get("/memory/recent", (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
  const offset = Math.max(0, Number(req.query.offset ?? 0));
  const kindParam = typeof req.query.kind === "string" ? req.query.kind : undefined;
  const kind =
    kindParam === "chunk" || kindParam === "conversation" || kindParam === "manual"
      ? kindParam
      : undefined;
  const memories = listRecentMemories(limit, kind, offset);
  res.json({ memories, offset, limit });
});

// Portable export of everything the brain knows — the second half of the
// disaster-recovery story (snapshots restore the DB; this gets the knowledge
// OUT of SQLite entirely). Plain text, newest first.
memoryRouter.get("/memory/export", (req, res) => {
  const maxChars = Math.min(20_000_000, Math.max(1, Number(req.query.maxChars ?? 5_000_000)));
  const corpus = exportMemoryCorpus({ maxChars });
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="brain-memory-export.txt"');
  res.send(corpus.text);
});

// Snapshot management. These MUST stay mounted before /memory/:id or the
// param route swallows them.
memoryRouter.get("/memory/backups", (_req, res) => {
  res.json({ backups: listBackups() });
});

memoryRouter.post("/memory/backup", (_req, res) => {
  const result = runBackup();
  res.status(result.ok ? 200 : 500).json(result);
});

// Dedup-merge audit trail + undo. Merges tombstone the loser memory; restoring
// re-inserts it (keyword-retrievable; the embedding is re-derivable).
memoryRouter.get("/memory/tombstones", (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100)));
  res.json({ tombstones: listTombstones(limit) });
});

memoryRouter.post("/memory/tombstones/:id/restore", (req, res) => {
  const restored = unmergePair(req.params.id);
  if (!restored) {
    res.status(404).json({ error: "no tombstone for that id (or the id is in use again)" });
    return;
  }
  res.json({ ok: true });
});

memoryRouter.get("/memory/:id", (req, res) => {
  const id = req.params.id;
  const memory = getMemoryPoint(id);
  if (!memory) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const relations = getRelationsFor(id);
  res.json({ memory, relations });
});

memoryRouter.delete("/memory/:id", (req, res) => {
  const id = req.params.id;
  const deleted = deleteMemoryPoint(id);
  if (!deleted) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ ok: true });
});

memoryRouter.post("/memory/consolidate", async (_req, res) => {
  // Guard the async body: an uncaught throw here became an unhandled rejection
  // that crashed the entire server process (Express 4 does not catch async
  // route errors). Surface it as a 500 instead.
  try {
    const result = await runConsolidationCycle();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

memoryRouter.get("/memory/lifecycle/stats", (_req, res) => {
  const stats = getConsolidationStats();
  const totalMemories = getMemoryCount();
  res.json({ ...stats, totalMemories });
});
