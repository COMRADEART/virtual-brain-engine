// Hybrid web surface (FRIDAY online). Mounted under /api:
//   POST /api/web/search   → live web search results (no persistence).
//   POST /api/web/research → search + read the top pages INTO memory (learn).
//
// Both egress, and BOTH inherit the LOCAL_ONLY gate from the layer below
// (web/search.ts + ingest/webFetch.ts): under the default LOCAL_ONLY=true they
// return { ok:false, reason:"blocked…" } without a byte leaving the machine.
// This is the same direct-route precedent as POST /api/ingest/web. POST routes
// inherit the global X-Brain-Local header guard from index.ts.

import { Router } from "express";
import { z } from "zod";
import { webSearch } from "../web/search.js";
import { webResearch } from "../web/research.js";
import { getDefaultConnectorInstance } from "../connectors/registry.js";

export const webRouter = Router();

const searchSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(10).optional(),
});
webRouter.post("/web/search", async (req, res) => {
  const parsed = searchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const result = await webSearch(parsed.data.query, { limit: parsed.data.limit });
  res.json(result);
});

const researchSchema = z.object({
  query: z.string().min(1).max(500),
  maxPages: z.number().int().min(1).max(10).optional(),
});
webRouter.post("/web/research", async (req, res) => {
  const parsed = researchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  // Pass the default connector's embedder (if any) so learned pages join the
  // vector index. The full hit bodies stay server-side; the client gets the
  // search results + learn counts.
  const conn = getDefaultConnectorInstance();
  const embed = conn?.embed ? conn.embed.bind(conn) : undefined;
  const r = await webResearch(parsed.data.query, { limit: parsed.data.maxPages, embed });
  res.json({
    ok: r.ok,
    provider: r.provider,
    query: r.query,
    results: r.results,
    ingested: r.ingested,
    deduped: r.deduped,
    reason: r.reason,
  });
});
