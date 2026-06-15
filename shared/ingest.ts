// Shared contract for computer-wide memory ingestion (Phase 2 — "connect all
// the memory of the computer"). ZERO runtime deps. The governance + persistence
// live server-side (server/src/ingest/*).
//
// PRIVACY MODEL (enforced in server/src/ingest/index.ts):
//   - Opt-in: every source is OFF by default; nothing is ingested until the
//     user enables that source's consent. (PRIMARY guarantee.)
//   - Exclude paths: items from obviously-sensitive locations are dropped.
//     (PRIMARY guarantee.)
//   - Redaction: credentials/keys/tokens are scrubbed from EVERY persisted field
//     before write. This is a best-effort BACKSTOP — a regex misses novel secret
//     shapes, so it never substitutes for consent + excludes. It deliberately
//     does NOT touch emails/names: PII is the legitimate payload of a personal
//     memory brain.
//   - Local-only + audited: ingestion never egresses; every run is logged.

export type IngestSourceId = "clipboard" | "recent-docs" | "app-usage" | "manual" | "web" | "github" | "file";

export interface IngestSourceSpec {
  id: IngestSourceId;
  title: string;
  description: string;
  // True when the data can only be collected via the OS (Tauri side pushes it);
  // false when the server can accept it directly (e.g. a manual paste / API push).
  osBacked: boolean;
  // True when this source EGRESSES the machine to gather data ("learn from the
  // internet"). Such sources are blocked while the server is LOCAL_ONLY (default)
  // — the same gate the remote-LLM connectors sit behind — so "zero outbound by
  // default" holds. They are also never ambient: a fetch is always user-initiated.
  egress?: boolean;
}

// Static catalogue (pure data — safe in shared). Live consent/enabled state is
// DB-backed and merged in by the server at /api/ingest/status.
export const INGEST_SOURCES: IngestSourceSpec[] = [
  { id: "clipboard", title: "Clipboard", description: "Text you copy.", osBacked: true },
  { id: "recent-docs", title: "Recent documents", description: "Files you've recently opened.", osBacked: true },
  { id: "app-usage", title: "App usage", description: "Which apps/windows are active.", osBacked: true },
  { id: "manual", title: "Manual / pasted", description: "Text pushed directly into the brain.", osBacked: false },
  {
    id: "web",
    title: "Web pages",
    description: "Read a URL and learn its text. Needs LOCAL_ONLY=false (egresses).",
    osBacked: false,
    egress: true,
  },
  {
    id: "github",
    title: "GitHub projects",
    description: "Discover popular repos (>1k stars) by topic and learn their READMEs. Needs LOCAL_ONLY=false (egresses).",
    osBacked: false,
    egress: true,
  },
  {
    id: "file",
    title: "Uploaded files",
    description: "Files you drop in — text, code, PDFs, Office docs, and images. The brain extracts and remembers their contents.",
    osBacked: false,
  },
];

export interface IngestConsent {
  sourceId: IngestSourceId;
  enabled: boolean;
  updatedAt: string;
}

// One unit of captured information offered to the ingest pipeline.
export interface IngestItem {
  text: string;
  title?: string;
  // Provenance: a file path, URL, or app/window name. Redacted before storage
  // and never used as the dedup key.
  sourcePath?: string;
  occurredAt?: string;
}

export interface IngestRunResult {
  sourceId: IngestSourceId;
  received: number;
  ingested: number;
  deduped: number;
  // Count of ITEMS that had at least one secret scrubbed (backstop telemetry —
  // NOT a safety proof).
  redacted: number;
  // Blocked by consent, excluded path, or empty content.
  skipped: number;
  reason?: string;
}

export interface IngestLogEntry {
  id: string;
  sourceId: string;
  received: number;
  ingested: number;
  deduped: number;
  redacted: number;
  skipped: number;
  createdAt: string;
}

export interface IngestSourceStatus extends IngestSourceSpec {
  enabled: boolean;
  lastRunAt: string | null;
  ingestedTotal: number;
}

export interface IngestStatus {
  sources: IngestSourceStatus[];
  recent: IngestLogEntry[];
}

// Result of uploading ONE file to the brain (POST /api/ingest/file). The brain
// extracts readable content (text/code directly, HTML/PDF/Office best-effort,
// images via the perception worker's caption), then runs it through the SAME
// governed ingest pipeline as every other source. `kind` is how the file was
// classified; `chars` is how much text was extracted; `ingest` is the per-run
// governance tally (chunks ingested/deduped/redacted).
export interface FileIngestResult {
  ok: boolean;
  filename: string;
  // "text" | "html" | "pdf" | "office" | "image" | "binary"
  kind: string;
  chars: number;
  // Human-readable summary of what happened (esp. when nothing was extractable,
  // e.g. a scanned PDF or an image with the perception worker offline).
  note: string;
  ingest: IngestRunResult;
}
