// "Feed a file to the brain" — turn one uploaded file into governed, retrievable
// memory. Bridges the pure extractor (fileExtract.ts) to the governed ingest
// pipeline (ingest/index.ts):
//
//   image            -> deps.caption() (BLIP via the perception worker) -> ingest
//   text/pdf/office  -> extractTextFromFile() -> chunk -> ingestExplicitEmbedded("file")
//   nothing readable -> ingested:0 with an honest `note` (no useless stub stored)
//
// `deps` (caption + embed) are INJECTED so this is unit-testable with ZERO
// worker/network: the route wires the real perception worker + embedder, the
// selfcheck passes stubs. The "file" source uses ingestExplicit* (no ambient
// consent gate) because an upload IS the user's explicit consent — same posture
// as the web "learn-url" path.

import { chunkText } from "../ingest/webFetch.js";
import { ingestExplicit, ingestExplicitEmbedded } from "../ingest/index.js";
import { extractTextFromFile } from "./fileExtract.js";
import type { FileIngestResult, IngestItem, IngestRunResult } from "../../../shared/ingest.js";

export interface UploadedFile {
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

export interface FileIngestDeps {
  // Describe an image (base64) -> a caption. Absent => images can't be read.
  caption?: (imageBase64: string) => Promise<{ ok: true; caption: string } | { ok: false; error: string }>;
  // Embed extracted text so it joins the vector index. Absent => keyword-only.
  embed?: (text: string) => Promise<number[]>;
}

function blockedRun(reason: string): IngestRunResult {
  return { sourceId: "file", received: 1, ingested: 0, deduped: 0, redacted: 0, skipped: 1, reason };
}

// Strip the embedded path's extra `points` so the API payload stays small.
function toRun(r: IngestRunResult): IngestRunResult {
  return {
    sourceId: r.sourceId,
    received: r.received,
    ingested: r.ingested,
    deduped: r.deduped,
    redacted: r.redacted,
    skipped: r.skipped,
    reason: r.reason,
  };
}

async function ingestChunks(
  content: string,
  filename: string,
  embed: FileIngestDeps["embed"],
): Promise<IngestRunResult> {
  const chunks = chunkText(content, { targetChars: 1000, maxChunks: 200 });
  const occurredAt = new Date().toISOString();
  const items: IngestItem[] = chunks.map((text, i) => ({
    text,
    title: chunks.length > 1 ? `${filename} (${i + 1}/${chunks.length})` : filename,
    sourcePath: filename,
    occurredAt,
  }));
  if (embed) {
    return toRun(await ingestExplicitEmbedded("file", items, embed));
  }
  return ingestExplicit("file", items);
}

export async function ingestUploadedFile(file: UploadedFile, deps: FileIngestDeps = {}): Promise<FileIngestResult> {
  const extracted = extractTextFromFile(file.filename, file.mimeType, file.bytes);

  // --- Image: read via the perception worker's caption ---------------------
  if (extracted.kind === "image") {
    if (!deps.caption) {
      return {
        ok: false,
        filename: file.filename,
        kind: "image",
        chars: 0,
        note: "the perception worker is needed to read images — start it (worker/) to caption uploads",
        ingest: blockedRun("perception worker offline"),
      };
    }
    const cap = await deps.caption(file.bytes.toString("base64"));
    if (!cap.ok) {
      return {
        ok: false,
        filename: file.filename,
        kind: "image",
        chars: 0,
        note: `image could not be described: ${cap.error}`,
        ingest: blockedRun(cap.error),
      };
    }
    const content = `Image "${file.filename}": ${cap.caption}`;
    const run = await ingestChunks(content, file.filename, deps.embed);
    return {
      ok: run.ingested > 0,
      filename: file.filename,
      kind: "image",
      chars: cap.caption.length,
      note: `described: "${cap.caption}"`,
      ingest: run,
    };
  }

  // --- Everything else: extracted text -> governed ingest ------------------
  if (!extracted.text) {
    return {
      ok: false,
      filename: file.filename,
      kind: extracted.kind,
      chars: 0,
      note: extracted.note,
      ingest: blockedRun(extracted.note),
    };
  }

  const run = await ingestChunks(extracted.text, file.filename, deps.embed);
  const note = extracted.truncated ? `${extracted.note} (truncated to fit)` : extracted.note;
  return {
    ok: run.ingested > 0,
    filename: file.filename,
    kind: extracted.kind,
    chars: extracted.text.length,
    note: run.ingested === 0 && run.deduped > 0 ? "already in memory (deduped)" : note,
    ingest: run,
  };
}
