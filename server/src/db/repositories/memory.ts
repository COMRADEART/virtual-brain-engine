import { ulid } from "ulid";
import type {
  MemoryPoint,
  MemoryRelation,
  MemoryRelationKind,
  MemorySourceType,
} from "../../../../shared/memory.js";
import { openDb, isVectorAvailable } from "../sqlite.js";
import { CONFIG } from "../../config.js";

interface MemoryRow {
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
}

function rowToMemory(row: MemoryRow): MemoryPoint {
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
  };
}

function safeJsonParse(value: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export interface MemoryUpsertInput {
  sourceType: MemorySourceType;
  filePath?: string | null;
  projectName?: string | null;
  title?: string | null;
  content: string;
  contentHash: string;
  embedding?: number[];
  importance?: number;
  metadata?: Record<string, unknown>;
}

// Serialise a JS number[] into the little-endian float32 BLOB sqlite-vec expects.
function embeddingToBlob(values: number[]): Buffer {
  const buf = Buffer.allocUnsafe(values.length * 4);
  for (let i = 0; i < values.length; i += 1) {
    buf.writeFloatLE(values[i], i * 4);
  }
  return buf;
}

export function upsertMemoryPoint(input: MemoryUpsertInput): MemoryPoint {
  const db = openDb();
  const id = ulid();
  const now = new Date().toISOString();
  const metadata = input.metadata ? JSON.stringify(input.metadata) : null;
  const importance = input.importance ?? 0.5;

  // If a row with the same content_hash + file_path already exists, return it
  // unchanged. The scanner uses this to make re-runs cheap.
  if (input.filePath) {
    const existing = db
      .prepare<[string, string], MemoryRow>(
        `SELECT * FROM memory_points WHERE content_hash = ? AND file_path = ? LIMIT 1`,
      )
      .get(input.contentHash, input.filePath);
    if (existing) {
      return rowToMemory(existing);
    }
  }

  let embeddingId: number | null = null;
  if (input.embedding && isVectorAvailable()) {
    if (input.embedding.length !== CONFIG.embeddingDim) {
      throw new Error(
        `Embedding dim mismatch: got ${input.embedding.length}, expected ${CONFIG.embeddingDim}`,
      );
    }
    const blob = embeddingToBlob(input.embedding);
    const result = db
      .prepare(`INSERT INTO memory_vec (embedding) VALUES (?)`)
      .run(blob);
    embeddingId = Number(result.lastInsertRowid);
  }

  db.prepare(
    `INSERT INTO memory_points
       (id, source_type, file_path, project_name, title, content, content_hash,
        embedding_id, importance, created_at, updated_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.sourceType,
    input.filePath ?? null,
    input.projectName ?? null,
    input.title ?? null,
    input.content,
    input.contentHash,
    embeddingId,
    importance,
    now,
    now,
    metadata,
  );

  const row = db
    .prepare<[string], MemoryRow>(`SELECT * FROM memory_points WHERE id = ?`)
    .get(id);
  if (!row) {
    throw new Error("Insert succeeded but row not found");
  }
  return rowToMemory(row);
}

export function getMemoryPoint(id: string): MemoryPoint | null {
  const db = openDb();
  const row = db
    .prepare<[string], MemoryRow>(`SELECT * FROM memory_points WHERE id = ?`)
    .get(id);
  return row ? rowToMemory(row) : null;
}

export function countMemoryPoints(filter?: { sourceType?: MemorySourceType }): number {
  const db = openDb();
  if (filter?.sourceType) {
    const row = db
      .prepare<[string], { c: number }>(
        `SELECT count(*) AS c FROM memory_points WHERE source_type = ?`,
      )
      .get(filter.sourceType);
    return row?.c ?? 0;
  }
  const row = db
    .prepare<[], { c: number }>(`SELECT count(*) AS c FROM memory_points`)
    .get();
  return row?.c ?? 0;
}

export interface VectorSearchHit {
  memory: MemoryPoint;
  score: number;
}

export function vectorSearch(
  embedding: number[],
  limit: number,
  filter?: { sourceType?: MemorySourceType; projectName?: string },
): VectorSearchHit[] {
  const db = openDb();
  if (!isVectorAvailable()) {
    return [];
  }
  if (embedding.length !== CONFIG.embeddingDim) {
    throw new Error(`Embedding dim mismatch in vectorSearch: ${embedding.length}`);
  }

  const blob = embeddingToBlob(embedding);
  // memory_vec returns distance. Convert to a similarity-ish score = 1/(1+d).
  type Row = MemoryRow & { distance: number };
  const sql = `
    SELECT mp.*, v.distance AS distance
    FROM memory_vec v
    JOIN memory_points mp ON mp.embedding_id = v.rowid
    WHERE v.embedding MATCH ? AND k = ?
    ${filter?.sourceType ? "AND mp.source_type = ?" : ""}
    ${filter?.projectName ? "AND mp.project_name = ?" : ""}
    ORDER BY v.distance ASC
  `;
  const params: Array<Buffer | string | number> = [blob, limit];
  if (filter?.sourceType) {
    params.push(filter.sourceType);
  }
  if (filter?.projectName) {
    params.push(filter.projectName);
  }

  const rows = db.prepare<unknown[], Row>(sql).all(...params);
  return rows.map((row) => ({
    memory: rowToMemory(row),
    score: 1 / (1 + (row.distance ?? 1)),
  }));
}

export function keywordSearch(query: string, limit: number): VectorSearchHit[] {
  const db = openDb();
  const like = `%${query.replace(/[%_]/g, " ")}%`;
  const rows = db
    .prepare<[string, number], MemoryRow>(
      `SELECT * FROM memory_points WHERE content LIKE ? ORDER BY importance DESC, updated_at DESC LIMIT ?`,
    )
    .all(like, limit);
  return rows.map((row) => ({
    memory: rowToMemory(row),
    score: 0.4, // flat score so vector hits naturally outrank exact lexical matches
  }));
}

export function insertRelation(
  fromId: string,
  toId: string,
  kind: MemoryRelationKind,
  weight = 1,
): MemoryRelation {
  const db = openDb();
  const id = ulid();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO memory_relations (id, from_id, to_id, kind, weight, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, fromId, toId, kind, weight, now);
  return { id, fromId, toId, kind, weight, createdAt: now };
}

export function getRelationsFor(memoryId: string): MemoryRelation[] {
  const db = openDb();
  type Row = {
    id: string;
    from_id: string;
    to_id: string;
    kind: MemoryRelationKind;
    weight: number;
    created_at: string;
  };
  const rows = db
    .prepare<[string, string], Row>(
      `SELECT * FROM memory_relations WHERE from_id = ? OR to_id = ? ORDER BY created_at DESC`,
    )
    .all(memoryId, memoryId);
  return rows.map((row) => ({
    id: row.id,
    fromId: row.from_id,
    toId: row.to_id,
    kind: row.kind,
    weight: row.weight,
    createdAt: row.created_at,
  }));
}

export function listRecentMemories(
  limit: number,
  sourceType?: MemorySourceType,
  offset = 0,
): MemoryPoint[] {
  const db = openDb();
  const rows = sourceType
    ? db
        .prepare<[string, number, number], MemoryRow>(
          `SELECT * FROM memory_points WHERE source_type = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
        )
        .all(sourceType, limit, offset)
    : db
        .prepare<[number, number], MemoryRow>(
          `SELECT * FROM memory_points ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
        )
        .all(limit, offset);
  return rows.map(rowToMemory);
}

export function getMemoryCount(): number {
  const db = openDb();
  const row = db.prepare("SELECT COUNT(*) as count FROM memory_points").get() as { count: number };
  return row.count;
}

export function deleteMemoryPoint(id: string): boolean {
  const db = openDb();
  const result = db.prepare("DELETE FROM memory_points WHERE id = ?").run(id);
  return result.changes > 0;
}

export interface EmbeddingDimMismatch {
  valid: boolean;
  expectedDim: number;
  actualDims: number[];
  memoryCount: number;
}

function parseEmbeddingDimFromSql(sql: string): number | null {
  const match = sql.match(/embedding\s+float\[(\d+)\]/i);
  return match ? parseInt(match[1], 10) : null;
}

export function checkEmbeddingDimMismatch(): EmbeddingDimMismatch {
  const db = openDb();
  if (!isVectorAvailable()) {
    return { valid: true, expectedDim: CONFIG.embeddingDim, actualDims: [], memoryCount: 0 };
  }

  const count = getMemoryCount();
  if (count === 0) {
    return { valid: true, expectedDim: CONFIG.embeddingDim, actualDims: [], memoryCount: 0 };
  }

  try {
    const row = db
      .prepare<[], { sql: string }>(
        `SELECT sql FROM sqlite_master WHERE name = 'memory_vec' AND type = 'table'`,
      )
      .get();

    if (!row?.sql) {
      return { valid: true, expectedDim: CONFIG.embeddingDim, actualDims: [], memoryCount: count };
    }

    const actualDim = parseEmbeddingDimFromSql(row.sql);
    if (actualDim === null) {
      return { valid: true, expectedDim: CONFIG.embeddingDim, actualDims: [], memoryCount: count };
    }

    const hasMismatch = actualDim !== CONFIG.embeddingDim;

    return {
      valid: !hasMismatch,
      expectedDim: CONFIG.embeddingDim,
      actualDims: hasMismatch ? [actualDim] : [actualDim],
      memoryCount: count,
    };
  } catch {
    return { valid: true, expectedDim: CONFIG.embeddingDim, actualDims: [], memoryCount: count };
  }
}
