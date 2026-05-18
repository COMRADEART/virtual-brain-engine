import { openDb, type SqliteDatabase } from "../db/sqlite.js";
import type { MemoryPoint, MemorySourceType } from "../../../shared/memory.js";
import { ulid } from "ulid";

export interface LifecycleMemory extends MemoryPoint {
  citation_count: number;
}

function rowToLifecycle(row: LifecycleRow): LifecycleMemory {
  return {
    id: row.id,
    sourceType: row.source_type,
    filePath: row.file_path,
    projectName: row.project_name,
    title: row.title,
    content: row.content,
    contentHash: row.content_hash,
    embeddingId: row.embedding_id,
    importance: row.importance,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: row.metadata ? safeJsonParse(row.metadata) : undefined,
    citation_count: row.citation_count ?? 0,
  };
}

interface LifecycleRow {
  id: string;
  source_type: MemorySourceType;
  file_path: string | null;
  project_name: string | null;
  title: string | null;
  content: string;
  content_hash: string;
  embedding_id: number | null;
  importance: number;
  created_at: string;
  updated_at: string;
  metadata: string | null;
  citation_count: number;
}

function safeJsonParse(value: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function updateMemoryImportance(id: string, importance: number): void {
  const db = openDb();
  db.prepare(
    `UPDATE memory_points SET importance = ?, updated_at = ? WHERE id = ?`,
  ).run(importance, new Date().toISOString(), id);
}

export function getMemoriesForConsolidation(
  limit: number,
  db: SqliteDatabase = openDb(),
): LifecycleMemory[] {
  const rows = db
    .prepare<[number, number], LifecycleRow>(
      `SELECT mp.*,
              (SELECT COUNT(*) FROM memory_relations mr WHERE mr.to_id = mp.id AND mr.kind = 'cites') AS citation_count
       FROM memory_points mp
       WHERE mp.summary_id IS NULL
         AND mp.source_type = 'conversation'
         AND mp.importance < ?
         AND datetime(mp.created_at) < datetime('now', '-7 days')
       ORDER BY mp.importance ASC, mp.created_at ASC
       LIMIT ?`,
    )
    .all(0.5, limit);
  return rows.map(rowToLifecycle);
}

export function getLowImportanceMemories(threshold: number, limit: number): LifecycleMemory[] {
  const db = openDb();
  const rows = db
    .prepare<[number, number], LifecycleRow>(
      `SELECT mp.*,
              (SELECT COUNT(*) FROM memory_relations mr WHERE mr.to_id = mp.id AND mr.kind = 'cites') AS citation_count
       FROM memory_points mp
       WHERE mp.importance < ?
         AND mp.summary_id IS NULL
       ORDER BY mp.importance ASC
       LIMIT ?`,
    )
    .all(threshold, limit);
  return rows.map(rowToLifecycle);
}

export function softDeleteMemory(id: string): void {
  const db = openDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE memory_points
     SET metadata = json_set(COALESCE(metadata, '{}'), '$.archived', true, '$.archivedAt', ?),
         updated_at = ?
     WHERE id = ?`,
  ).run(now, now, id);
}

export function createSummaryMemory(
  originalId: string,
  summaryContent: string,
  summaryImportance: number,
  projectName: string | null,
): LifecycleMemory {
  const db = openDb();
  const id = ulid();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO memory_points
       (id, source_type, file_path, project_name, title, content, content_hash,
        embedding_id, importance, created_at, updated_at, metadata, summary_id)
     SELECT ?, source_type, file_path, ?, title, ?, content_hash,
            NULL, ?, ?, ?, metadata, ?
       FROM memory_points WHERE id = ?`,
  ).run(
    id,
    projectName,
    summaryContent,
    summaryImportance,
    now,
    now,
    id,
    originalId,
  );
  const row = db
    .prepare<[string], LifecycleRow>(`SELECT * FROM memory_points WHERE id = ?`)
    .get(id);
  if (!row) throw new Error("Summary insert succeeded but row not found");
  return rowToLifecycle(row);
}

export function linkSummary(originalId: string, summaryId: string): void {
  const db = openDb();
  db.prepare(
    `UPDATE memory_points SET summary_id = ?, updated_at = ? WHERE id = ?`,
  ).run(summaryId, new Date().toISOString(), originalId);
}

export function getMemoryById(id: string): LifecycleMemory | null {
  const db = openDb();
  const row = db
    .prepare<[string, string], LifecycleRow>(
      `SELECT mp.*,
              (SELECT COUNT(*) FROM memory_relations mr WHERE mr.to_id = mp.id AND mr.kind = 'cites') AS citation_count
       FROM memory_points mp WHERE mp.id = ?`,
    )
    .get(id, id);
  return row ? rowToLifecycle(row) : null;
}

export function getActiveProjectNames(): string[] {
  const db = openDb();
  const rows = db
    .prepare<[string], { project_name: string }>(
      `SELECT DISTINCT project_name FROM memory_points
       WHERE project_name IS NOT NULL
         AND datetime(updated_at) > datetime('now', '-30 days')
       ORDER BY updated_at DESC
       LIMIT 20`,
    )
    .all("last 30 days");
  return rows.map((r: { project_name: string }) => r.project_name).filter(Boolean) as string[];
}

export function isMemoryArchived(id: string): boolean {
  const db = openDb();
  const row = db
    .prepare<[string], { archived: number }>(
      `SELECT json_extract(metadata, '$.archived') AS archived FROM memory_points WHERE id = ?`,
    )
    .get(id);
  return row?.archived === 1;
}