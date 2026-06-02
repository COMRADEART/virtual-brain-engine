// Persistence for ingestion governance: per-source consent (default OFF) and
// the per-run audit log.

import { ulid } from "ulid";
import { openDb } from "../sqlite.js";
import type { IngestLogEntry, IngestSourceId } from "../../../../shared/ingest.js";

// --- Consent ----------------------------------------------------------------

export function isConsentEnabled(sourceId: IngestSourceId): boolean {
  const db = openDb();
  const row = db
    .prepare<[string], { enabled: number }>(`SELECT enabled FROM ingest_consent WHERE source_id = ?`)
    .get(sourceId);
  return row?.enabled === 1;
}

export function setConsent(sourceId: IngestSourceId, enabled: boolean): void {
  const db = openDb();
  db.prepare(
    `INSERT INTO ingest_consent (source_id, enabled, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(source_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
  ).run(sourceId, enabled ? 1 : 0, new Date().toISOString());
}

export function listConsent(): Record<string, boolean> {
  const db = openDb();
  const rows = db
    .prepare<[], { source_id: string; enabled: number }>(`SELECT source_id, enabled FROM ingest_consent`)
    .all();
  const out: Record<string, boolean> = {};
  for (const r of rows) {
    out[r.source_id] = r.enabled === 1;
  }
  return out;
}

// --- Run log ----------------------------------------------------------------

interface IngestLogRow {
  id: string;
  source_id: string;
  received: number;
  ingested: number;
  deduped: number;
  redacted: number;
  skipped: number;
  created_at: string;
}

function rowToEntry(row: IngestLogRow): IngestLogEntry {
  return {
    id: row.id,
    sourceId: row.source_id,
    received: row.received,
    ingested: row.ingested,
    deduped: row.deduped,
    redacted: row.redacted,
    skipped: row.skipped,
    createdAt: row.created_at,
  };
}

export interface IngestLogInput {
  sourceId: string;
  received: number;
  ingested: number;
  deduped: number;
  redacted: number;
  skipped: number;
}

export function insertIngestLog(input: IngestLogInput): IngestLogEntry {
  const db = openDb();
  const id = ulid();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO ingest_log (id, source_id, received, ingested, deduped, redacted, skipped, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.sourceId, input.received, input.ingested, input.deduped, input.redacted, input.skipped, createdAt);
  return { id, ...input, createdAt };
}

export function listIngestLog(limit = 50): IngestLogEntry[] {
  const db = openDb();
  const rows = db
    .prepare<[number], IngestLogRow>(`SELECT * FROM ingest_log ORDER BY created_at DESC LIMIT ?`)
    .all(limit);
  return rows.map(rowToEntry);
}

export function lastRunForSource(sourceId: string): string | null {
  const db = openDb();
  const row = db
    .prepare<[string], { created_at: string }>(
      `SELECT created_at FROM ingest_log WHERE source_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(sourceId);
  return row?.created_at ?? null;
}

// Total memories ingested across ALL sources (Learning Lab usage summary).
export function totalIngested(): number {
  const db = openDb();
  const row = db
    .prepare<[], { total: number }>(`SELECT COALESCE(SUM(ingested), 0) AS total FROM ingest_log`)
    .get();
  return row?.total ?? 0;
}

export function totalIngestedForSource(sourceId: string): number {
  const db = openDb();
  const row = db
    .prepare<[string], { total: number }>(
      `SELECT COALESCE(SUM(ingested), 0) AS total FROM ingest_log WHERE source_id = ?`,
    )
    .get(sourceId);
  return row?.total ?? 0;
}
