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
 * Execute a merge: tombstone + delete the "delete" memory, keep the "keep" one.
 *
 * REVERSIBLE: before deleting, the loser row and its relations are serialized
 * into memory_tombstones so unmergePair() can restore them. The embedding is
 * the one thing not preserved (the vec row is dropped); a restored memory is
 * keyword-retrievable immediately and re-embeddable later.
 */
export function mergePair(keep: string, deleteId: string, similarity?: number): void {
  const db = openDb();
  db.transaction(() => {
    // Serialize the loser BEFORE any deletion.
    const point = db.prepare(`SELECT * FROM memory_points WHERE id = ?`).get(deleteId);
    if (point) {
      const relations = db
        .prepare(`SELECT * FROM memory_relations WHERE from_id = ? OR to_id = ?`)
        .all(deleteId, deleteId);
      db.prepare(
        `INSERT OR REPLACE INTO memory_tombstones (id, kept_id, reason, similarity, point_json, relations_json, created_at)
         VALUES (?, ?, 'dedup-merge', ?, ?, ?, ?)`,
      ).run(deleteId, keep, similarity ?? null, JSON.stringify(point), JSON.stringify(relations), new Date().toISOString());
    }
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

export interface TombstoneInfo {
  id: string;
  keptId: string;
  reason: string;
  similarity: number | null;
  title: string | null;
  contentPreview: string;
  createdAt: string;
}

/** Tombstones, newest first — the "what did dedup merge away" audit surface. */
export function listTombstones(limit = 100): TombstoneInfo[] {
  const db = openDb();
  const rows = db
    .prepare<[number], { id: string; kept_id: string; reason: string; similarity: number | null; point_json: string; created_at: string }>(
      `SELECT id, kept_id, reason, similarity, point_json, created_at
       FROM memory_tombstones ORDER BY created_at DESC LIMIT ?`,
    )
    .all(Math.max(1, limit));
  return rows.map((r) => {
    let title: string | null = null;
    let contentPreview = "";
    try {
      const p = JSON.parse(r.point_json) as { title?: string | null; content?: string };
      title = p.title ?? null;
      contentPreview = (p.content ?? "").slice(0, 160);
    } catch {
      /* preview is best-effort */
    }
    return { id: r.id, keptId: r.kept_id, reason: r.reason, similarity: r.similarity, title, contentPreview, createdAt: r.created_at };
  });
}

/**
 * Undo a merge: re-insert the tombstoned memory_points row (embedding_id
 * cleared — the vector is gone), restore the relations whose OTHER endpoint
 * still exists, take back the keep-side importance bump, drop the tombstone.
 * Returns false when there is no tombstone or the id is occupied again.
 */
export function unmergePair(deletedId: string): boolean {
  const db = openDb();
  let restored = false;
  db.transaction(() => {
    const ts = db
      .prepare<[string], { kept_id: string; point_json: string; relations_json: string }>(
        `SELECT kept_id, point_json, relations_json FROM memory_tombstones WHERE id = ?`,
      )
      .get(deletedId);
    if (!ts) return;
    const exists = db.prepare(`SELECT 1 FROM memory_points WHERE id = ?`).get(deletedId);
    if (exists) return; // id re-used since — refuse rather than clobber
    const point = JSON.parse(ts.point_json) as Record<string, unknown>;
    const cols = Object.keys(point).filter((c) => c !== "embedding_id");
    db.prepare(
      `INSERT INTO memory_points (${cols.join(", ")}, embedding_id) VALUES (${cols.map(() => "?").join(", ")}, NULL)`,
    ).run(...cols.map((c) => point[c]));
    const relations = JSON.parse(ts.relations_json) as Array<Record<string, unknown>>;
    for (const rel of relations) {
      const relCols = Object.keys(rel);
      try {
        db.prepare(
          `INSERT OR IGNORE INTO memory_relations (${relCols.join(", ")})
           SELECT ${relCols.map(() => "?").join(", ")}
           WHERE EXISTS (SELECT 1 FROM memory_points WHERE id = ?)
             AND EXISTS (SELECT 1 FROM memory_points WHERE id = ?)`,
        ).run(...relCols.map((c) => rel[c]), rel["from_id"], rel["to_id"]);
      } catch {
        /* a single unrestorable relation must not block the memory itself */
      }
    }
    db.prepare(`UPDATE memory_points SET importance = MAX(0.0, importance - 0.05) WHERE id = ?`).run(ts.kept_id);
    db.prepare(`DELETE FROM memory_tombstones WHERE id = ?`).run(deletedId);
    restored = true;
  })();
  return restored;
}
