// Computer-wide memory ingestion (Phase 2). Mounted under /api:
//   GET  /api/ingest/status   → sources (with consent + totals) + recent runs.
//   POST /api/ingest/consent  → enable/disable a source (opt-in; default OFF).
//   POST /api/ingest/push     → hand items to the governed pipeline.
//
// Collectors push here; governance (consent/exclude/redact/dedup/audit) is
// enforced server-side in ingest/index.ts. POST routes inherit the global
// X-Brain-Local guard.

import { Router } from "express";
import { z } from "zod";
import { fetchAndIngestUrl, ingestItems, ingestStatus } from "../ingest/index.js";
import { setConsent } from "../db/repositories/ingest.js";
import { INGEST_SOURCES, type IngestSourceId } from "../../../shared/ingest.js";

export const ingestRouter = Router();

const SOURCE_IDS = INGEST_SOURCES.map((s) => s.id) as [IngestSourceId, ...IngestSourceId[]];
const sourceIdSchema = z.enum(SOURCE_IDS);

ingestRouter.get("/ingest/status", (_req, res) => {
  res.json(ingestStatus());
});

const consentSchema = z.object({ sourceId: sourceIdSchema, enabled: z.boolean() });
ingestRouter.post("/ingest/consent", (req, res) => {
  const parsed = consentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  setConsent(parsed.data.sourceId, parsed.data.enabled);
  res.json({ ok: true, status: ingestStatus() });
});

const pushSchema = z.object({
  sourceId: sourceIdSchema,
  items: z
    .array(
      z.object({
        text: z.string().max(100_000),
        title: z.string().max(500).optional(),
        sourcePath: z.string().max(2000).optional(),
        occurredAt: z.string().max(64).optional(),
      }),
    )
    .max(500),
});
ingestRouter.post("/ingest/push", (req, res) => {
  const parsed = pushSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const result = ingestItems(parsed.data.sourceId, parsed.data.items);
  res.json(result);
});

// "Learn from the internet": user-initiated URL fetch → governed ingest. Egress
// is gated inside fetchAndIngestUrl (LOCAL_ONLY → only local targets reachable),
// so this returns a clear reason instead of leaking when the brain is local-only.
const webSchema = z.object({ url: z.string().url().max(4096) });
ingestRouter.post("/ingest/web", async (req, res) => {
  const parsed = webSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const result = await fetchAndIngestUrl(parsed.data.url);
  res.json(result);
});
