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

// Content-hash dedup, independent of file_path (the upsert's built-in dedup only
// fires when a file_path is present). Used by the ingestion pipeline so the same
// clipboard/doc text isn't stored twice. Backed by the memory_points_hash index.
export function hasMemoryWithContentHash(hash: string): boolean {
  const db = openDb();
  const row = db
    .prepare<[string], { c: number }>(
      `SELECT count(*) AS c FROM memory_points WHERE content_hash = ?`,
    )
    .get(hash);
  return (row?.c ?? 0) > 0;
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

export interface MemoryCorpus {
  text: string;
  chars: number;
  documents: number;
}

// Letter ranges for scripts that are NOT Latin — used by isMostlyEnglish.
// Deliberately scoped to real writing systems: digits, punctuation, accented
// Latin, and emoji are all neutral (neither English nor "other"), so a
// code-heavy or symbol-heavy doc is never misclassified.
const NON_LATIN_LETTER_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0370, 0x03ff], // Greek
  [0x0400, 0x04ff], // Cyrillic
  [0x0590, 0x05ff], // Hebrew
  [0x0600, 0x06ff], // Arabic
  [0x0900, 0x097f], // Devanagari
  [0x0e00, 0x0e7f], // Thai
  [0x1100, 0x11ff], // Hangul jamo
  [0x3040, 0x30ff], // Hiragana + Katakana
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xac00, 0xd7af], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xff66, 0xff9f], // halfwidth Katakana
  [0x20000, 0x2ebef], // CJK extensions B+
];

// Pure heuristic: does this text read as mostly English? Counts ASCII letters
// vs letters from non-Latin scripts; the doc passes while non-Latin letters
// stay under `maxOtherRatio` of all counted letters. A doc with no letters at
// all (pure code/symbols/numbers) passes — there is nothing non-English in it.
export function isMostlyEnglish(text: string, maxOtherRatio = 0.3): boolean {
  let latin = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
      latin += 1;
    } else if (NON_LATIN_LETTER_RANGES.some(([lo, hi]) => code >= lo && code <= hi)) {
      other += 1;
    }
  }
  const counted = latin + other;
  return counted === 0 || other / counted <= maxOtherRatio;
}

// Concatenate the brain's own memories into one training corpus for the
// from-scratch LLM trainer (Learning Lab — Phase C). Newest first, each doc
// separated by a blank line. `maxChars` caps the export so a huge DB can't
// blow up the worker payload; `minImportance` lets the caller train on only
// the memories the brain considers worth keeping. `englishOnly` drops
// non-mostly-English docs (skipped docs don't consume the char budget) so the
// trainers can keep the brain's own model anchored to English.
export function exportMemoryCorpus(
  opts: { maxChars?: number; minImportance?: number; englishOnly?: boolean } = {},
): MemoryCorpus {
  const maxChars = opts.maxChars ?? 5_000_000;
  const minImportance = opts.minImportance ?? 0;
  const db = openDb();
  const rows = db
    .prepare<[number], { title: string | null; content: string }>(
      `SELECT title, content FROM memory_points
       WHERE importance >= ?
       ORDER BY updated_at DESC`,
    )
    .all(minImportance);
  const parts: string[] = [];
  let chars = 0;
  let documents = 0;
  for (const row of rows) {
    const piece = (row.title ? `${row.title}\n` : "") + row.content;
    if (opts.englishOnly && !isMostlyEnglish(piece)) {
      continue;
    }
    if (chars + piece.length > maxChars) {
      break;
    }
    parts.push(piece);
    chars += piece.length + 2; // +2 for the "\n\n" separator
    documents += 1;
  }
  return { text: parts.join("\n\n"), chars, documents };
}

export function getRelationCount(): number {
  const db = openDb();
  const row = db.prepare("SELECT COUNT(*) as count FROM memory_relations").get() as { count: number };
  return row.count;
}

// Edges whose BOTH endpoints fall within the given node-id set — i.e. the
// induced subgraph for a sampled node window. Used by the knowledge-graph view.
export function listRelationsAmong(ids: string[]): MemoryRelation[] {
  if (ids.length === 0) {
    return [];
  }
  const db = openDb();
  const placeholders = ids.map(() => "?").join(", ");
  type Row = {
    id: string;
    from_id: string;
    to_id: string;
    kind: MemoryRelationKind;
    weight: number;
    created_at: string;
  };
  const rows = db
    .prepare<string[], Row>(
      `SELECT * FROM memory_relations
       WHERE from_id IN (${placeholders}) AND to_id IN (${placeholders})
       ORDER BY created_at DESC LIMIT 400`,
    )
    .all(...ids, ...ids);
  return rows.map((row) => ({
    id: row.id,
    fromId: row.from_id,
    toId: row.to_id,
    kind: row.kind,
    weight: row.weight,
    createdAt: row.created_at,
  }));
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
