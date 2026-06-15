// Computer-wide memory ingestion (Phase 2). Mounted under /api:
//   GET  /api/ingest/status   → sources (with consent + totals) + recent runs.
//   POST /api/ingest/consent  → enable/disable a source (opt-in; default OFF).
//   POST /api/ingest/push     → hand items to the governed pipeline.
//
// Collectors push here; governance (consent/exclude/redact/dedup/audit) is
// enforced server-side in ingest/index.ts. POST routes inherit the global
// X-Brain-Local guard.

import { Router, json } from "express";
import { z } from "zod";
import { fetchAndIngestUrl, ingestItems, ingestStatus } from "../ingest/index.js";
import { setConsent } from "../db/repositories/ingest.js";
import { ingestUploadedFile } from "../settings/fileIngest.js";
import { caption } from "../perception/workerClient.js";
import { getDefaultConnectorInstance, listConnectorInstances } from "../connectors/registry.js";
import { INGEST_SOURCES, type IngestSourceId } from "../../../shared/ingest.js";

export const ingestRouter = Router();

// File uploads carry base64-encoded bytes that routinely exceed the global 1mb
// json cap (server/src/index.ts), so this ONE path gets its own larger parser —
// exactly like /api/perceive/*. index.ts lets /api/ingest/file bypass the global
// parser, or this inner json() would be a no-op (body-parser is idempotent).
const FILE_BODY_LIMIT = "40mb";
ingestRouter.use("/ingest/file", json({ limit: FILE_BODY_LIMIT }));

// Resolve an embedder the same way the pipeline / perception route do: prefer the
// default connector, else any healthy local Ollama that can embed. Returns
// undefined when none can — uploads still land as keyword-retrievable memory.
function resolveEmbed(): ((text: string) => Promise<number[]>) | undefined {
  const active = getDefaultConnectorInstance();
  const embedder =
    active?.embed
      ? active
      : listConnectorInstances().find(
          (c) =>
            c.descriptor.kind === "ollama" &&
            c.descriptor.enabled &&
            c.descriptor.state === "ok" &&
            Boolean(c.embed),
        );
  if (!embedder?.embed) return undefined;
  const embed = embedder.embed.bind(embedder);
  return (text: string) => embed(text);
}

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

// "Read any file into the brain": the brain extracts readable content (text/code
// directly, HTML/PDF/Office best-effort, images via the perception worker's
// caption) and runs it through the SAME governed ingest as every other source.
// No egress (the file is already on the machine), so no LOCAL_ONLY gate; an
// upload is its own explicit consent (ingestExplicit, no ambient-consent check).
const fileSchema = z.object({
  filename: z.string().min(1).max(500),
  mimeType: z.string().max(200).optional(),
  // base64 (optionally a data: URL). ~40MB JSON cap above ≈ a ~28MB file.
  dataBase64: z.string().min(1).max(40_000_000),
});
ingestRouter.post("/ingest/file", async (req, res) => {
  const parsed = fileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { filename, mimeType, dataBase64 } = parsed.data;
  // Accept a raw base64 string OR a data: URL (the browser FileReader yields the
  // latter); strip the "data:...;base64," prefix if present.
  const b64 = dataBase64.startsWith("data:") && dataBase64.includes(",")
    ? dataBase64.slice(dataBase64.indexOf(",") + 1)
    : dataBase64;
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length === 0) {
    res.status(400).json({ error: "file is empty or not valid base64" });
    return;
  }

  const result = await ingestUploadedFile(
    { filename, mimeType: mimeType ?? "", bytes },
    {
      caption: async (imageBase64) => {
        const r = await caption({ imageBase64 });
        return r.ok ? { ok: true, caption: r.data.caption } : { ok: false, error: r.error };
      },
      embed: resolveEmbed(),
    },
  );
  res.json(result);
});
