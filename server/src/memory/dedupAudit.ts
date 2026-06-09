// Memory dedup audit: scans for near-duplicate memories using embedding
// similarity and merges them (keeps the newer one, deletes the older).
//
// Runs as a background job on a configurable interval. Threshold is tunable
// via DEDUP_SIMILARITY_THRESHOLD (default 0.92). The audit is read-heavy but
// write-light — only genuinely near-duplicate pairs trigger a delete.

import { openDb } from "../db/sqlite.js";
import { cosineSimilarity, getStoredEmbeddings } from "./embeddingSimilarity.js";

export interface DedupConfig {
  similarityThreshold: number;
  maxPairsPerRun: number;
}

export interface DedupResult {
  scanned: number;
  duplicatesFound: number;
  merged: number;
  pairs: Array<{ keep: string; delete: string; similarity: number }>;
}

const DEFAULT_CONFIG: DedupConfig = {
  similarityThreshold: parseFloat(process.env.DEDUP_SIMILARITY_THRESHOLD ?? "0.92"),
  maxPairsPerRun: parseInt(process.env.DEDUP_MAX_PAIRS ?? "50", 10),
};

/**
 * Run a dedup audit pass. Returns pairs of near-duplicate memories and the
 * number actually merged. Does NOT auto-merge — the caller decides.
 */
export function runDedupAudit(config: Partial<DedupConfig> = {}): DedupResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const db = openDb();

  // Get all memories with embeddings
  const rows = db
    .prepare<[], { id: string; created_at: string }>(
      `SELECT mp.id, mp.created_at FROM memory_points mp
       JOIN memory_vec v ON mp.embedding_id = v.rowid
       ORDER BY mp.created_at DESC`,
    )
    .all();

  if (rows.length < 2) return { scanned: rows.length, duplicatesFound: 0, merged: 0, pairs: [] };

  const ids = rows.map((r) => r.id);
  const embeddings = getStoredEmbeddings(ids, db);

  const pairs: DedupResult["pairs"] = [];
  const deleted = new Set<string>();

  // Compare each pair (O(n²) but bounded by memory count)
  for (let i = 0; i < rows.length && pairs.length < cfg.maxPairsPerRun; i++) {
    if (deleted.has(rows[i].id)) continue;
    const embI = embeddings.get(rows[i].id);
    if (!embI) continue;

    for (let j = i + 1; j < rows.length && pairs.length < cfg.maxPairsPerRun; j++) {
      if (deleted.has(rows[j].id)) continue;
      const embJ = embeddings.get(rows[j].id);
      if (!embJ) continue;

      const sim = cosineSimilarity(embI, embJ);
      if (sim >= cfg.similarityThreshold) {
        // Keep the newer one (already ordered by created_at DESC, so i is newer)
        pairs.push({ keep: rows[i].id, delete: rows[j].id, similarity: Math.round(sim * 1000) / 1000 });
        deleted.add(rows[j].id);
      }
    }
  }

  return {
    scanned: rows.length,
    duplicatesFound: pairs.length,
    merged: 0, // caller decides whether to merge
    pairs,
  };
}

/**
 * Execute a merge: delete the "delete" memory and keep the "keep" one.
 */
export function mergePair(keep: string, deleteId: string): void {
  const db = openDb();
  db.transaction(() => {
    // Delete the embedding first (FK)
    db.prepare(`DELETE FROM memory_vec WHERE rowid = (SELECT embedding_id FROM memory_points WHERE id = ?)`).run(deleteId);
    // Delete relations referencing this memory. (The memory_points FK already
    // CASCADEs on delete, but we clear them explicitly so the order is well-defined
    // and it works even if FK enforcement is off.) Columns are from_id/to_id.
    db.prepare(`DELETE FROM memory_relations WHERE from_id = ? OR to_id = ?`).run(deleteId, deleteId);
    // Delete the memory point
    db.prepare(`DELETE FROM memory_points WHERE id = ?`).run(deleteId);
    // Bump importance of the kept memory slightly
    db.prepare(`UPDATE memory_points SET importance = MIN(1.0, importance + 0.05) WHERE id = ?`).run(keep);
  })();
}
