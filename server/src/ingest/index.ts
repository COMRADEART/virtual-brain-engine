// Computer-wide memory ingestion orchestrator (Phase 2). Source-agnostic: any
// collector — the Tauri clipboard/app-usage/recent-docs readers (Phase 2b) or a
// direct manual push — hands items here, and this is the ONE place governance is
// enforced. It runs everything through, in order:
//
//   consent gate (server-side, never trusts the caller) → exclude-path drop →
//   redact EVERY persisted field → content-hash dedup → importance → persist as
//   a "chunk" memory → audit.
//
// Why "chunk" and not "manual": ambient auto-capture is the noisiest, lowest-
// signal source. "manual" carries the highest source weight in importanceScorer
// (1.4) and is reserved for deliberate user notes (the create-note action);
// ambient ingest uses "chunk" (1.0).

import { createHash } from "node:crypto";
import { CONFIG } from "../config.js";
import { computeImportance } from "../memory/importanceScorer.js";
import {
  hasMemoryWithContentHash,
  upsertMemoryPoint,
  type MemoryUpsertInput,
} from "../db/repositories/memory.js";
import type { MemoryPoint } from "../../../shared/memory.js";
import {
  insertIngestLog,
  isConsentEnabled,
  lastRunForSource,
  listIngestLog,
  listConsent,
  totalIngestedForSource,
} from "../db/repositories/ingest.js";
import { isExcludedPath, redactSecrets } from "./governance.js";
import { fetchUrlText, chunkText, type WebFetchOptions } from "./webFetch.js";
import { surfaceError } from "../util/diagnostics.js";
import {
  INGEST_SOURCES,
  type IngestItem,
  type IngestRunResult,
  type IngestSourceId,
  type IngestStatus,
} from "../../../shared/ingest.js";

function sha1(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

function logRun(result: IngestRunResult): void {
  try {
    insertIngestLog(result);
  } catch (err) {
    surfaceError("ingest:log", err);
  }
}

// AMBIENT ingest: consent-gated. Any auto-capturing collector (clipboard,
// recent-docs, app-usage) routes here; the consent check is the opt-in gate that
// keeps ambient capture OFF until the user explicitly enables that source.
export function ingestItems(sourceId: IngestSourceId, items: IngestItem[]): IngestRunResult {
  // (1) CONSENT — checked server-side. We never trust that a pushed sourceId was
  // pre-authorised by the caller.
  if (!isConsentEnabled(sourceId)) {
    const result: IngestRunResult = {
      sourceId,
      received: items.length,
      ingested: 0,
      deduped: 0,
      redacted: 0,
      skipped: items.length,
      reason: "consent disabled for this source",
    };
    logRun(result);
    return result;
  }
  return ingestExplicit(sourceId, items);
}

// Per-item governance — THE single choke point shared by both the sync and the
// embedded async ingest paths (so the rule "exclude → redact → dedup →
// importance" has exactly one implementation, never two that can drift). Returns
// what to do with one item: skip, dedup (already stored), or persist the given
// upsert input (sans embedding — callers add that). DEDUP reads the live DB, so
// callers MUST persist an "ok" item before preparing the next one to catch
// within-batch duplicates (the original interleaved behaviour).
type Prepared =
  | { status: "skip" }
  | { status: "dedup" }
  | { status: "ok"; redacted: boolean; upsert: MemoryUpsertInput };

function prepareIngestItem(sourceId: IngestSourceId, item: IngestItem): Prepared {
  // (2) EXCLUDE obviously-sensitive provenance, regardless of redaction.
  if (isExcludedPath(item.sourcePath)) {
    return { status: "skip" };
  }
  // (3) REDACT every field we will persist, BEFORE deriving anything from it.
  const content = redactSecrets((item.text ?? "").trim());
  if (content.text.length === 0) {
    return { status: "skip" };
  }
  // Title is derived from the REDACTED text so a leading secret can't leak via
  // the title even though the body was scrubbed.
  const titleSource = item.title ? item.title : content.text.slice(0, 60);
  const title = redactSecrets(titleSource);
  const path = item.sourcePath ? redactSecrets(item.sourcePath) : { text: undefined as string | undefined, count: 0 };
  const redacted = content.count + title.count + path.count > 0;

  // (4) DEDUP on the POST-redaction text, so the hash invariant
  // (content_hash == sha1(content)) holds and the secret never enters the hash.
  const contentHash = sha1(content.text);
  if (hasMemoryWithContentHash(contentHash)) {
    return { status: "dedup" };
  }

  // (5) IMPORTANCE — reuse the pure scorer; ambient capture = "chunk" weight.
  const importance = computeImportance({
    baseImportance: 0.5,
    ageDays: 0,
    citationCount: 0,
    projectBoost: 0,
    sourceType: "chunk",
    contentLength: content.text.length,
  }).score;

  return {
    status: "ok",
    redacted,
    // (6) file_path stays null (this isn't a scanned file); provenance lives in
    // metadata, already redacted. No arbitrary item fields are stored.
    upsert: {
      sourceType: "chunk",
      filePath: null,
      title: title.text,
      content: content.text,
      contentHash,
      importance,
      metadata: {
        source: `ingest:${sourceId}`,
        sourcePath: path.text,
        occurredAt: item.occurredAt,
      },
    },
  };
}

// EXPLICIT ingest: the SAME governance (exclude → redact → dedup → importance →
// persist → audit) but WITHOUT the ambient-consent gate. Used by ingestItems
// (after consent passes) and by deliberate, user-initiated paths — web learning
// (fetchAndIngestUrl) — where the explicit command itself IS the consent.
export function ingestExplicit(sourceId: IngestSourceId, items: IngestItem[]): IngestRunResult {
  const result: IngestRunResult = {
    sourceId,
    received: items.length,
    ingested: 0,
    deduped: 0,
    redacted: 0,
    skipped: 0,
  };

  for (const item of items) {
    const prep = prepareIngestItem(sourceId, item);
    if (prep.status === "skip") {
      result.skipped += 1;
      continue;
    }
    if (prep.status === "dedup") {
      result.deduped += 1;
      continue;
    }
    if (prep.redacted) result.redacted += 1;
    try {
      upsertMemoryPoint(prep.upsert);
      result.ingested += 1;
    } catch (err) {
      surfaceError(`ingest:${sourceId}`, err);
      result.skipped += 1;
    }
  }

  logRun(result);
  return result;
}

// EMBEDDED explicit ingest: identical governance to ingestExplicit, but each
// persisted item is EMBEDDED (the embedding is computed on the REDACTED text, so
// a secret never reaches the embedder either) and the persisted MemoryPoints are
// returned. This is what makes "learn from the internet" first-class: web pages
// land in the vector index and are retrievable by future /api/ask, not just by
// keyword. A wrong-dim embedding is dropped (stored without a vector) rather than
// thrown, exactly like the pipeline's learned-memory path.
export async function ingestExplicitEmbedded(
  sourceId: IngestSourceId,
  items: IngestItem[],
  embed?: (text: string) => Promise<number[]>,
): Promise<IngestRunResult & { points: MemoryPoint[] }> {
  const result: IngestRunResult & { points: MemoryPoint[] } = {
    sourceId,
    received: items.length,
    ingested: 0,
    deduped: 0,
    redacted: 0,
    skipped: 0,
    points: [],
  };

  for (const item of items) {
    const prep = prepareIngestItem(sourceId, item);
    if (prep.status === "skip") {
      result.skipped += 1;
      continue;
    }
    if (prep.status === "dedup") {
      result.deduped += 1;
      continue;
    }
    if (prep.redacted) result.redacted += 1;

    let embedding: number[] | undefined;
    if (embed) {
      try {
        const vec = await embed(prep.upsert.content);
        embedding = vec.length === CONFIG.embeddingDim ? vec : undefined;
      } catch (err) {
        // Embedding is best-effort — store the memory anyway (keyword-retrievable).
        surfaceError(`ingest:${sourceId}:embed`, err);
      }
    }
    try {
      const point = upsertMemoryPoint({ ...prep.upsert, embedding });
      result.points.push(point);
      result.ingested += 1;
    } catch (err) {
      surfaceError(`ingest:${sourceId}`, err);
      result.skipped += 1;
    }
  }

  logRun(result);
  return result;
}

// "Learn from the internet": fetch a URL, extract its readable text, and persist
// it through the explicit governed path. EGRESS is gated inside fetchUrlText
// (LOCAL_ONLY → only local targets reachable). A blocked or failed fetch is
// still audited (received=1, skipped=1, reason) so the trail records attempts.
export interface WebIngestResult extends IngestRunResult {
  title: string | null;
  // The persisted web memories, present only when an `embed` fn was supplied
  // (the hybrid pipeline path). Each is a real, citeable MemoryPoint.
  points?: MemoryPoint[];
  // The page's final URL after redirects (for provenance / citations).
  finalUrl?: string;
}

// `embed` (optional): when supplied, fetched chunks are embedded + stored via the
// embedded path so the page joins the vector index; the persisted points are
// returned. Without it, the page is stored keyword-retrievable only (the existing
// `learn-url` / POST /api/ingest/web behaviour — unchanged).
export async function fetchAndIngestUrl(
  rawUrl: string,
  opts: WebFetchOptions & { embed?: (text: string) => Promise<number[]> } = {},
): Promise<WebIngestResult> {
  const fetched = await fetchUrlText(rawUrl, opts);
  if (!fetched.ok) {
    const result: IngestRunResult = {
      sourceId: "web",
      received: 1,
      ingested: 0,
      deduped: 0,
      redacted: 0,
      skipped: 1,
      reason: fetched.reason,
    };
    logRun(result);
    return { ...result, title: null };
  }
  return ingestFetchedPage(fetched, opts);
}

// Persist an ALREADY-FETCHED page through the SAME governed web ingest (chunk →
// redact → dedup → importance → [embed] → persist → audit). Split out of
// fetchAndIngestUrl so a caller that downloads many pages in PARALLEL (the
// pipeline's web research) can still run the dedup-sensitive PERSIST step
// SEQUENTIALLY — content-hash dedup is a check-then-insert (prepareIngestItem
// reads the live DB, the caller must persist one item before preparing the
// next), so interleaving concurrent persists would defeat it. The network
// fetch is the slow, parallelizable half; this persist half is the half that
// must stay ordered.
export async function ingestFetchedPage(
  fetched: { title: string | null; text: string; finalUrl: string },
  opts: { embed?: (text: string) => Promise<number[]> } = {},
): Promise<WebIngestResult> {
  const chunks = chunkText(fetched.text, { targetChars: 1000, maxChunks: 60 });
  const occurredAt = new Date().toISOString();
  const items: IngestItem[] = chunks.map((text, i) => ({
    text,
    title: fetched.title
      ? chunks.length > 1
        ? `${fetched.title} (${i + 1}/${chunks.length})`
        : fetched.title
      : undefined,
    sourcePath: fetched.finalUrl,
    occurredAt,
  }));
  if (opts.embed) {
    const result = await ingestExplicitEmbedded("web", items, opts.embed);
    return { ...result, title: fetched.title, finalUrl: fetched.finalUrl };
  }
  const result = ingestExplicit("web", items);
  return { ...result, title: fetched.title, finalUrl: fetched.finalUrl };
}

export function ingestStatus(): IngestStatus {
  const consent = listConsent();
  return {
    sources: INGEST_SOURCES.map((spec) => ({
      ...spec,
      enabled: consent[spec.id] === true,
      lastRunAt: lastRunForSource(spec.id),
      ingestedTotal: totalIngestedForSource(spec.id),
    })),
    recent: listIngestLog(20),
  };
}
