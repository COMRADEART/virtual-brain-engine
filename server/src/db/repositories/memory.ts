import { ulid } from "ulid";
import type {
  MemoryPoint,
  MemoryRelation,
  MemoryRelationKind,
  MemorySourceType,
} from "../../../../shared/memory.js";
import { openDb, isVectorAvailable, isFtsAvailable } from "../sqlite.js";
import { CONFIG } from "../../config.js";
import { surfaceError } from "../../util/diagnostics.js";
import {
  isTurbovecAvailable,
  turbovecEnqueueAdd,
  turbovecSearch,
  scoreFromTurbovecSimilarity,
} from "../../learning/turbovecClient.js";

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

// Reverse of embeddingToBlob — read a float32 LE BLOB back into a number[]. Used
// only by the turbovec backfill, which re-derives every memory_vec row's vector so
// the worker index can be rebuilt from the existing sqlite-vec store.
export function blobToEmbedding(blob: Buffer): number[] {
  const out = new Array<number>(blob.length / 4);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = blob.readFloatLE(i * 4);
  }
  return out;
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
    // Mirror into the optional turbovec worker index. Still fire-and-forget (this
    // stays sync — awaiting would cascade async through every ingest caller), but
    // routed through a BOUNDED single-in-flight queue rather than spawning one
    // unresolved promise per upsert: against a slow/wedged worker the old path
    // piled up a 30s-timeout promise per ingest (a 50k scan = 50k in-flight). The
    // queue drops oldest on overflow; the next backfill reconciles any miss. See
    // memory/turbovec-deferred.md.
    if (CONFIG.turbovecEnabled) {
      turbovecEnqueueAdd(embeddingId, input.embedding);
    }
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

export async function vectorSearch(
  embedding: number[],
  limit: number,
  filter?: { sourceType?: MemorySourceType; projectName?: string },
): Promise<VectorSearchHit[]> {
  if (embedding.length !== CONFIG.embeddingDim) {
    throw new Error(`Embedding dim mismatch in vectorSearch: ${embedding.length}`);
  }

  // turbovec branch — only when explicitly enabled AND the worker index is live.
  // Returns null when the worker is down so the caller falls back to sqlite-vec;
  // any thrown error is also caught and falls back. The hot path never breaks on a
  // turbovec miss. See memory/turbovec-deferred.md.
  if (CONFIG.turbovecEnabled) {
    try {
      const hits = await vectorSearchTurbovec(embedding, limit, filter);
      if (hits !== null) return hits;
    } catch {
      // fall through to the sqlite-vec path
    }
  }

  return vectorSearchSqlite(embedding, limit, filter);
}

// The in-process sqlite-vec path — the default and the always-available fallback.
function vectorSearchSqlite(
  embedding: number[],
  limit: number,
  filter?: { sourceType?: MemorySourceType; projectName?: string },
): VectorSearchHit[] {
  const db = openDb();
  if (!isVectorAvailable()) {
    return [];
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

// The optional turbovec worker path. Returns null when the worker is down (caller
// falls back to sqlite-vec); otherwise a (possibly empty) hit list. Keys the worker
// index by memory_points.embedding_id (the memory_vec rowid) so the post-search
// hydration mirrors the sqlite-vec join exactly.
async function vectorSearchTurbovec(
  embedding: number[],
  limit: number,
  filter?: { sourceType?: MemorySourceType; projectName?: string },
): Promise<VectorSearchHit[] | null> {
  if (!(await isTurbovecAvailable())) return null;
  const db = openDb();

  // turbovec searches by id only, so a sourceType/projectName filter is applied as
  // an allowlist of the matching embedding_ids (one cheap indexed scan).
  let filterIds: number[] | undefined;
  if (filter?.sourceType || filter?.projectName) {
    const clauses: string[] = ["embedding_id IS NOT NULL"];
    const params: string[] = [];
    if (filter?.sourceType) {
      clauses.push("source_type = ?");
      params.push(filter.sourceType);
    }
    if (filter?.projectName) {
      clauses.push("project_name = ?");
      params.push(filter.projectName);
    }
    const idRows = db
      .prepare<unknown[], { embedding_id: number }>(
        `SELECT embedding_id FROM memory_points WHERE ${clauses.join(" AND ")}`,
      )
      .all(...params);
    filterIds = idRows.map((r) => r.embedding_id);
    if (filterIds.length === 0) return [];
  }

  const res = await turbovecSearch(embedding, limit, filterIds);
  if (!res.ok) return null; // worker errored mid-search → fall back
  if (res.hits.length === 0) return [];

  // Hydrate the memory_points rows for the returned embedding_ids (same join as
  // sqlite-vec). The IN-list is bounded by `limit`.
  const ids = res.hits.map((h) => h.id);
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare<unknown[], MemoryRow>(
      `SELECT * FROM memory_points WHERE embedding_id IN (${placeholders})`,
    )
    .all(...ids);
  const byId = new Map(rows.map((r) => [r.embedding_id, r]));
  const out: VectorSearchHit[] = [];
  for (const h of res.hits) {
    const row = byId.get(h.id);
    if (row) {
      out.push({ memory: rowToMemory(row), score: scoreFromTurbovecSimilarity(h.score) });
    }
  }
  return out;
}

// All (embedding_id, vector) pairs in the sqlite-vec store — the source for a
// turbovec backfill (rebuild the worker index from the existing local store).
// Returns [] when sqlite-vec isn't loaded (nothing to copy — reported honestly).
export function getAllEmbeddingRows(): { embeddingId: number; embedding: number[] }[] {
  const db = openDb();
  if (!isVectorAvailable()) return [];
  const rows = db
    .prepare<unknown[], { rowid: number; embedding: Buffer }>(
      `SELECT rowid, embedding FROM memory_vec ORDER BY rowid ASC`,
    )
    .all();
  return rows.map((r) => ({ embeddingId: r.rowid, embedding: blobToEmbedding(r.embedding) }));
}

// Build an FTS5 MATCH expression from a free-text query: lowercase, extract
// word/number tokens (Unicode-aware), drop 1-char noise, double-quote each token
// (so punctuation / FTS operators in the raw query can't break MATCH syntax or
// inject), and OR them for lexical recall. Returns null when nothing usable
// remains, so the caller falls back to LIKE. Pure — covered by substrate:selfcheck.
export function toFtsMatchQuery(query: string): string | null {
  const tokens = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1);
  if (tokens.length === 0) return null;
  return tokens
    .slice(0, 16)
    .map((t) => `"${t}"`)
    .join(" OR ");
}

export function keywordSearch(query: string, limit: number): VectorSearchHit[] {
  const db = openDb();

  // FTS path — a tokenised index lookup instead of a leading-wildcard LIKE scan.
  // Gated live on CONFIG.ftsEnabled so the flag can be flipped without a reboot.
  if (CONFIG.ftsEnabled && isFtsAvailable()) {
    const match = toFtsMatchQuery(query);
    if (match) {
      try {
        const rows = db
          .prepare<[string, number], MemoryRow>(
            `SELECT mp.* FROM memory_fts f
             JOIN memory_points mp ON mp.id = f.id
             WHERE memory_fts MATCH ?
             ORDER BY bm25(memory_fts), mp.importance DESC
             LIMIT ?`,
          )
          .all(match, limit);
        return rows.map((row) => ({
          memory: rowToMemory(row),
          score: 0.4, // flat score so vector hits naturally outrank lexical matches
        }));
      } catch (err) {
        // Any FTS quirk (malformed MATCH, missing shadow table) degrades to LIKE
        // rather than failing the retrieval.
        surfaceError("memory.keywordSearch.fts", err);
      }
    }
  }

  // LIKE fallback — substring match, the always-available path.
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

export function getRelationsFor(memoryId: string, limit = 256): MemoryRelation[] {
  const db = openDb();
  type Row = {
    id: string;
    from_id: string;
    to_id: string;
    kind: MemoryRelationKind;
    weight: number;
    created_at: string;
  };
  // Bounded: a hub memory (a summary node) can accrue thousands of relations;
  // without a LIMIT every caller pulled the whole star even when it uses the top
  // few. Newest-first so the cap keeps the most recent edges.
  const rows = db
    .prepare<[string, string, number], Row>(
      `SELECT * FROM memory_relations WHERE from_id = ? OR to_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(memoryId, memoryId, limit);
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
