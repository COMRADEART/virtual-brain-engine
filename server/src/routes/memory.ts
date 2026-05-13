import { Router } from "express";
import { z } from "zod";
import {
  getMemoryPoint,
  getRelationsFor,
  keywordSearch,
  listRecentMemories,
  vectorSearch,
} from "../db/repositories/memory.js";
import { getDefaultConnectorInstance } from "../connectors/registry.js";

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
  const kindParam = typeof req.query.kind === "string" ? req.query.kind : undefined;
  const kind =
    kindParam === "chunk" || kindParam === "conversation" || kindParam === "manual"
      ? kindParam
      : undefined;
  const memories = listRecentMemories(limit, kind);
  res.json({ memories });
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
