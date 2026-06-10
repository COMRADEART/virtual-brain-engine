// GitHub project discovery surface ("learn from popular repos"). Mounted under
// /api:
//   POST /api/github/discover → top >1k-star repos for a topic (no persistence).
//   POST /api/github/learn    → discover + read each README INTO memory (learn).
//
// Both egress, and BOTH inherit the LOCAL_ONLY gate + host pin from the layer
// below (github/discovery.ts): under the default LOCAL_ONLY=true they return
// { ok:false, reason:"blocked…" } without a byte leaving the machine — the same
// precedent as POST /api/web/research. POST routes inherit the global
// X-Brain-Local header guard from index.ts.

import { Router } from "express";
import { z } from "zod";
import { githubSearch } from "../github/discovery.js";
import { discoverAndLearn } from "../github/index.js";
import { getDefaultConnectorInstance } from "../connectors/registry.js";

export const githubRouter = Router();

const discoverSchema = z
  .object({
    query: z.string().min(1).max(200),
    minStars: z.number().int().min(1).max(1_000_000).optional(),
    language: z.string().max(30).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

githubRouter.post("/github/discover", async (req, res) => {
  const parsed = discoverSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { query, minStars, language, limit } = parsed.data;
  const r = await githubSearch(query, { minStars, language, limit });
  res.json(r);
});

githubRouter.post("/github/learn", async (req, res) => {
  const parsed = discoverSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { query, minStars, language, limit } = parsed.data;
  // Pass the default connector's embedder (if any) so learned READMEs join the
  // vector index. The full chunk bodies stay server-side; the client gets the
  // discovered repos + learn counts (the GitHubLearnView shape).
  const conn = getDefaultConnectorInstance();
  const embed = conn?.embed ? conn.embed.bind(conn) : undefined;
  const r = await discoverAndLearn(query, { minStars, language, limit, embed });
  res.json({
    ok: r.ok,
    query: r.query,
    repos: r.repos,
    reposLearned: r.reposLearned,
    ingested: r.ingested,
    deduped: r.deduped,
    reason: r.reason,
  });
});
