import { ulid } from "ulid";
import { openDb } from "../sqlite.js";

export interface ScanRoot {
  id: string;
  path: string;
  enabled: boolean;
  createdAt: string;
}

interface ScanRootRow {
  id: string;
  path: string;
  enabled: number;
  created_at: string;
}

function rowToRoot(row: ScanRootRow): ScanRoot {
  return {
    id: row.id,
    path: row.path,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

export function listScanRoots(): ScanRoot[] {
  const db = openDb();
  return db
    .prepare<[], ScanRootRow>(`SELECT * FROM scan_roots ORDER BY created_at ASC`)
    .all()
    .map(rowToRoot);
}

export function ensureScanRoot(path: string): ScanRoot {
  const db = openDb();
  const existing = db
    .prepare<[string], ScanRootRow>(`SELECT * FROM scan_roots WHERE path = ?`)
    .get(path);
  if (existing) {
    return rowToRoot(existing);
  }
  const id = ulid();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO scan_roots (id, path, enabled, created_at) VALUES (?, ?, 1, ?)`,
  ).run(id, path, now);
  return { id, path, enabled: true, createdAt: now };
}

export function deleteScanRoot(id: string): void {
  const db = openDb();
  db.prepare(`DELETE FROM scan_roots WHERE id = ?`).run(id);
}

export function setScanRootEnabled(id: string, enabled: boolean): void {
  const db = openDb();
  db.prepare(`UPDATE scan_roots SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
}

export interface FileRecord {
  path: string;
  projectName: string | null;
  sizeBytes: number;
  contentHash: string;
  scannedAt: string;
  chunkCount: number;
}

interface FileRow {
  path: string;
  project_name: string | null;
  size_bytes: number;
  content_hash: string;
  scanned_at: string;
  chunk_count: number;
}

function rowToFile(row: FileRow): FileRecord {
  return {
    path: row.path,
    projectName: row.project_name,
    sizeBytes: row.size_bytes,
    contentHash: row.content_hash,
    scannedAt: row.scanned_at,
    chunkCount: row.chunk_count,
  };
}

export function getFile(path: string): FileRecord | null {
  const db = openDb();
  const row = db.prepare<[string], FileRow>(`SELECT * FROM files WHERE path = ?`).get(path);
  return row ? rowToFile(row) : null;
}

export function upsertFile(record: FileRecord): void {
  const db = openDb();
  db.prepare(
    `INSERT INTO files (path, project_name, size_bytes, content_hash, scanned_at, chunk_count)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       project_name=excluded.project_name,
       size_bytes=excluded.size_bytes,
       content_hash=excluded.content_hash,
       scanned_at=excluded.scanned_at,
       chunk_count=excluded.chunk_count`,
  ).run(
    record.path,
    record.projectName,
    record.sizeBytes,
    record.contentHash,
    record.scannedAt,
    record.chunkCount,
  );
}
