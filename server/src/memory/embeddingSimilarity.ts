// Real embedding cosine similarity for the memory layer. Replaces the string
// heuristics (word/bigram Jaccard) in noveltyDetector + semanticCluster with the
// actual stored vector geometry — but ONLY when a memory has a stored embedding.
//
// Everything here is SYNCHRONOUS and free of network calls. better-sqlite3 reads
// are synchronous, so reading a vector blob inside a sync function is fine. The
// helpers are fully DEFENSIVE: any failure (no sqlite-vec extension, missing
// memory_vec table, null embedding_id, malformed blob, unit-test DB without the
// embedding columns) yields null / an empty map and NEVER throws. That defensive
// contract is what keeps the no-embedding path byte-identical to the old string
// path and keeps the cluster unit test (which builds a column-less in-memory DB)
// passing.

import { openDb, isVectorAvailable, type SqliteDatabase } from "../db/sqlite.js";

/** Cosine similarity of two equal-length vectors. Pure.
 *  Returns 0 on length mismatch, empty, or a zero-norm vector (never NaN). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Mirror of embeddingToBlob() in db/repositories/memory.ts, in reverse:
// the BLOB is a little-endian float32 array, so length must be a multiple of 4.
function blobToEmbedding(buf: Buffer): number[] | null {
  if (!Buffer.isBuffer(buf) || buf.length === 0 || buf.length % 4 !== 0) {
    return null;
  }
  const n = buf.length / 4;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = buf.readFloatLE(i * 4);
  }
  return out;
}

/** Read a memory's stored embedding as number[], or null if it has none.
 *  FULLY defensive: any failure (no vec extension, missing memory_vec table,
 *  null embedding_id, malformed blob) returns null — never throws. This is what
 *  makes the no-embedding path byte-identical and keeps it safe on the unit-test
 *  DB that has no embedding_id column / memory_vec table. */
export function getStoredEmbedding(
  memoryId: string,
  db: SqliteDatabase = openDb(),
): number[] | null {
  if (!isVectorAvailable()) {
    return null;
  }
  try {
    const row = db
      .prepare<[string], { embedding: unknown }>(
        `SELECT v.embedding AS embedding
         FROM memory_vec v
         JOIN memory_points mp ON mp.embedding_id = v.rowid
         WHERE mp.id = ?`,
      )
      .get(memoryId);
    if (!row || !Buffer.isBuffer(row.embedding)) {
      return null;
    }
    return blobToEmbedding(row.embedding);
  } catch {
    return null;
  }
}

// SQLite caps bound parameters per statement (SQLITE_MAX_VARIABLE_NUMBER —
// 999 on older builds, 32766 on newer). assessNovelty can pass *every* memory
// id here, so chunk the IN clause well under the conservative limit. Without
// this, a large corpus throws at prepare(), the catch swallows it, and EVERY
// candidate is silently skipped → genuinely-redundant memories misclassify as
// "novel". 800 keeps us safe even on a 999-variable build.
const ID_CHUNK = 800;

/** Batched form — chunked queries for many ids (avoid N+1, stay under the
 *  SQLite variable limit). Missing ones are absent from the map. Same
 *  full-defensive contract: on any error return what was gathered so far. */
export function getStoredEmbeddings(
  ids: string[],
  db: SqliteDatabase = openDb(),
): Map<string, number[]> {
  const result = new Map<string, number[]>();
  if (ids.length === 0 || !isVectorAvailable()) {
    return result;
  }
  try {
    for (let start = 0; start < ids.length; start += ID_CHUNK) {
      const chunk = ids.slice(start, start + ID_CHUNK);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = db
        .prepare<string[], { id: string; embedding: unknown }>(
          `SELECT mp.id AS id, v.embedding AS embedding
           FROM memory_points mp
           JOIN memory_vec v ON mp.embedding_id = v.rowid
           WHERE mp.id IN (${placeholders})`,
        )
        .all(...chunk);
      for (const row of rows) {
        if (!Buffer.isBuffer(row.embedding)) {
          continue;
        }
        const vec = blobToEmbedding(row.embedding);
        if (vec) {
          result.set(row.id, vec);
        }
      }
    }
    return result;
  } catch {
    return result;
  }
}
