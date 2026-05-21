import { createHash } from "node:crypto";
import { openDb, type SqliteDatabase } from "../db/sqlite.js";
import { ulid } from "ulid";

export interface TopicCluster {
  clusterId: string;
  topic: string;
  memoryIds: string[];
  centroid?: string;
  strength: number;
  coherence: number;
  createdAt: string;
  lastUpdated: string;
}

export interface TopicLabel {
  clusterId: string;
  label: string;
  confidence: number;
}

interface TopicRow {
  id: string;
  topic: string;
  strength: number;
  coherence: number;
  memory_ids: string;
  created_at: string;
  last_updated: string;
}

function sha1(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

function keywordsFromContent(content: string): string[] {
  const stopWords = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "is", "was", "are", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "can", "this", "that", "these", "those",
    "it", "its", "they", "them", "their", "we", "us", "our", "you", "your",
    "i", "me", "my", "not", "no", "so", "just", "about", "also", "as",
  ]);
  return content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !stopWords.has(w));
}

function ngrams(words: string[], n: number): string[] {
  const result: string[] = [];
  for (let i = 0; i <= words.length - n; i++) {
    result.push(words.slice(i, i + n).join(" "));
  }
  return result;
}

export function computeSemanticHash(content: string): string {
  const words = keywordsFromContent(content);
  const bigrams = ngrams(words, 2);
  const trigrams = ngrams(words, 3);
  const combined = [...bigrams, ...trigrams];
  const hash = createHash("sha1").update(combined.sort().join(" ")).digest("hex");
  return hash.slice(0, 12);
}

export function computeJaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(keywordsFromContent(a));
  const wordsB = new Set(keywordsFromContent(b));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? intersection / union : 0;
}

export function computeNgramOverlap(a: string, b: string): number {
  const wordsA = keywordsFromContent(a);
  const wordsB = keywordsFromContent(b);
  const bigramsA = new Set(ngrams(wordsA, 2));
  const bigramsB = new Set(ngrams(wordsB, 2));
  if (bigramsA.size === 0 || bigramsB.size === 0) return computeJaccardSimilarity(a, b);
  const intersection = [...bigramsA].filter((bg) => bigramsB.has(bg)).length;
  const union = new Set([...bigramsA, ...bigramsB]).size;
  return union > 0 ? intersection / union : 0;
}

// Two memories join the same cluster when their keyword-bigram overlap clears
// this bar. Tuned for computeNgramOverlap (Jaccard over keyword bigrams):
// identical / near-identical content scores ~1.0, unrelated content ~0, and
// same-topic restatements land in the ~0.15-0.4 band. Matching on this instead
// of exact semantic-hash equality is the fix for clusters that never grew:
// byte-identical bigram-set hashes almost never collide across distinct
// memories, so the old `topic = ?` path produced one-member clusters forever.
const SIMILARITY_THRESHOLD = 0.18;
// Bound the candidate scan so an insert stays ~O(1) regardless of history.
const MAX_CANDIDATE_CLUSTERS = 25;

export function updateClusterForMemory(
  memoryId: string,
  content: string,
  db: SqliteDatabase = openDb(),
): void {
  try {
    const now = new Date().toISOString();

    // Recently-active clusters, strongest first. We match by content
    // similarity against one representative member per cluster.
    const candidates = db
      .prepare<[number], { id: string; memory_ids: string }>(
        `SELECT id, memory_ids FROM memory_clusters
         WHERE datetime(last_updated) > datetime('now', '-3 days')
         ORDER BY strength DESC
         LIMIT ?`,
      )
      .all(MAX_CANDIDATE_CLUSTERS);

    let best: { id: string; ids: string[]; sim: number } | null = null;
    if (candidates.length > 0) {
      // One representative id per candidate, then a single batched content
      // fetch — never a per-candidate query (no N+1).
      const repByCluster = new Map<string, string>();
      const idsByCluster = new Map<string, string[]>();
      for (const c of candidates) {
        const ids: string[] = c.memory_ids ? JSON.parse(c.memory_ids) : [];
        idsByCluster.set(c.id, ids);
        if (ids.length > 0) repByCluster.set(c.id, ids[0]);
      }
      const repIds = [...new Set(repByCluster.values())];
      const contentById = new Map<string, string>();
      if (repIds.length > 0) {
        const placeholders = repIds.map(() => "?").join(", ");
        const rows = db
          .prepare<[string[]], { id: string; content: string }>(
            `SELECT id, content FROM memory_points
             WHERE id IN (${placeholders}) AND summary_id IS NULL`,
          )
          .all(repIds);
        for (const r of rows) contentById.set(r.id, r.content);
      }
      for (const c of candidates) {
        const repId = repByCluster.get(c.id);
        const repContent = repId ? contentById.get(repId) : undefined;
        if (!repContent) continue;
        const sim = computeNgramOverlap(content, repContent);
        if (!best || sim > best.sim) {
          best = { id: c.id, ids: idsByCluster.get(c.id) ?? [], sim };
        }
      }
    }

    if (best && best.sim >= SIMILARITY_THRESHOLD) {
      if (!best.ids.includes(memoryId)) {
        best.ids.push(memoryId);
        const coherence = computeClusterCoherence(best.ids, content, db);
        db.prepare(
          `UPDATE memory_clusters
           SET memory_ids = ?, memory_count = ?, strength = strength * 1.05, coherence = ?, last_updated = ?
           WHERE id = ?`,
        ).run(JSON.stringify(best.ids), best.ids.length, coherence, now, best.id);
      }
    } else {
      const id = ulid();
      const ids = [memoryId];
      const topic = computeSemanticHash(content);
      db.prepare(
        `INSERT INTO memory_clusters (id, topic, memory_ids, memory_count, strength, coherence, created_at, last_updated)
         VALUES (?, ?, ?, 1, 0.5, 0.8, ?, ?)`,
      ).run(id, topic, JSON.stringify(ids), now, now);
    }
  } catch {
    // ignore
  }
}

export function computeClusterCoherence(
  memoryIds: string[],
  newContent: string,
  db: SqliteDatabase = openDb(),
): number {
  // L1: an empty id list would render `IN ()`, a SQLite syntax error. The sole
  // caller always passes >=1 id today, but guarding keeps this reusable.
  if (memoryIds.length === 0) return 1.0;
  try {
    const placeholders = memoryIds.map(() => "?").join(", ");
    const rows = db
      .prepare<[string[]], { content: string }>(
        `SELECT content FROM memory_points WHERE id IN (${placeholders}) AND summary_id IS NULL`,
      )
      .all(memoryIds);
    const contents = rows.map((r) => r.content);
    contents.push(newContent);
    if (contents.length < 2) return 1.0;
    let totalSim = 0;
    let count = 0;
    for (let i = 0; i < contents.length; i++) {
      for (let j = i + 1; j < contents.length; j++) {
        totalSim += computeNgramOverlap(contents[i], contents[j]);
        count++;
      }
    }
    return count > 0 ? totalSim / count : 0.8;
  } catch {
    return 0.8;
  }
}

export function getClustersForMemory(
  memoryId: string,
  db: SqliteDatabase = openDb(),
): TopicCluster[] {
  try {
    const rows = db
      .prepare<[string], TopicRow>(
        `SELECT * FROM memory_clusters
         WHERE memory_ids LIKE ?
         ORDER BY strength DESC
         LIMIT 10`,
      )
      .all(`%"${memoryId}"%`);
    return rows.map(rowToCluster);
  } catch {
    return [];
  }
}

export function getAllClusters(
  limit = 50,
  db: SqliteDatabase = openDb(),
): TopicCluster[] {
  try {
    const rows = db
      .prepare<[number], TopicRow>(
        `SELECT * FROM memory_clusters ORDER BY strength DESC, memory_count DESC LIMIT ?`,
      )
      .all(limit);
    return rows.map(rowToCluster);
  } catch {
    return [];
  }
}

export function mergeClusters(
  sourceId: string,
  targetId: string,
  db: SqliteDatabase = openDb(),
): void {
  try {
    const source = db
      .prepare<[string], TopicRow>(`SELECT * FROM memory_clusters WHERE id = ?`)
      .get(sourceId);
    const target = db
      .prepare<[string], TopicRow>(`SELECT * FROM memory_clusters WHERE id = ?`)
      .get(targetId);
    if (!source || !target) return;
    const mergedIds = [...new Set([...JSON.parse(source.memory_ids), ...JSON.parse(target.memory_ids)])];
    const avgStrength = (source.strength + target.strength) / 2;
    const avgCoherence = (source.coherence + target.coherence) / 2;
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE memory_clusters
       SET memory_ids = ?, memory_count = ?, strength = ?, coherence = ?, last_updated = ?
       WHERE id = ?`,
    ).run(JSON.stringify(mergedIds), mergedIds.length, avgStrength, avgCoherence, now, targetId);
    db.prepare(`DELETE FROM memory_clusters WHERE id = ?`).run(sourceId);
  } catch {
    // ignore
  }
}

export function suggestClusterLabel(clusterId: string, sampleContent: string): TopicLabel | null {
  const words = keywordsFromContent(sampleContent);
  const freqMap = new Map<string, number>();
  for (const w of words) {
    freqMap.set(w, (freqMap.get(w) ?? 0) + 1);
  }
  const topWords = [...freqMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map((e) => e[0]);
  const label = topWords.join(" ") || "general";
  return { clusterId, label, confidence: freqMap.size > 0 ? Math.min(1, freqMap.size / 10) : 0.3 };
}

export function getClusterStats(db: SqliteDatabase = openDb()): {
  totalClusters: number;
  avgCoherence: number;
  avgStrength: number;
  largestCluster: number;
} {
  try {
    const row = db
      .prepare<[], { total: number; avg_coherence: number; avg_strength: number; largest: number }>(
        `SELECT COUNT(*) AS total,
                AVG(coherence) AS avg_coherence,
                AVG(strength) AS avg_strength,
                MAX(memory_count) AS largest
         FROM memory_clusters`,
      )
      .get();
    return {
      totalClusters: row?.total ?? 0,
      avgCoherence: row?.avg_coherence ?? 0,
      avgStrength: row?.avg_strength ?? 0,
      largestCluster: row?.largest ?? 0,
    };
  } catch {
    return { totalClusters: 0, avgCoherence: 0, avgStrength: 0, largestCluster: 0 };
  }
}

function rowToCluster(row: TopicRow): TopicCluster {
  return {
    clusterId: row.id,
    topic: row.topic,
    memoryIds: row.memory_ids ? JSON.parse(row.memory_ids) : [],
    strength: row.strength,
    coherence: row.coherence,
    createdAt: row.created_at,
    lastUpdated: row.last_updated,
  };
}