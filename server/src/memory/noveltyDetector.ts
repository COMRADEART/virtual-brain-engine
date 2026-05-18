import { createHash } from "node:crypto";
import { openDb, type SqliteDatabase } from "../db/sqlite.js";
import { insertRelation } from "../db/repositories/memory.js";

export interface NoveltyResult {
  isNovel: boolean;
  noveltyScore: number;
  category: "novel" | "reinforcement" | "redundant" | "contradictory";
  relatedIds: string[];
  explanation: string;
}

const NOVELTY_BOOST = 0.12;
const REDUNDANCY_PENALTY = 0.06;

function contentFingerprint(content: string): string {
  const words = content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
  const unique = [...new Set(words)].sort();
  return createHash("sha1").update(unique.join(" ")).digest("hex").slice(0, 12);
}

function hammingDistance(a: string, b: string): number {
  let dist = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) dist++;
  }
  return dist + Math.abs(a.length - b.length);
}

export function assessNovelty(
  content: string,
  projectName?: string | null,
): NoveltyResult {
  const contentHash = createHash("sha1").update(content).digest("hex");
  const db = openDb();

  const existingRows = db
    .prepare<[string], { id: string; content: string; importance: number; project_name: string | null }>(
      `SELECT id, content, importance, project_name FROM memory_points
       WHERE summary_id IS NULL
         AND content_hash != ?`,
    )
    .all(contentHash);

  let totalSimilarity = 0;
  let contradictoryCount = 0;
  let reinforceCount = 0;
  const relatedIds: string[] = [];

  for (const row of existingRows) {
    const similarity = computeTextSimilarity(content, row.content);
    if (similarity > 0.7) {
      totalSimilarity += similarity;
      relatedIds.push(row.id);
      if (similarity > 0.9) {
        reinforceCount++;
      } else if (similarity > 0.7 && hasNegation(content) && hasNegation(row.content)) {
        contradictoryCount++;
      }
    }
  }

  const avgSimilarity = relatedIds.length > 0 ? totalSimilarity / relatedIds.length : 0;
  const redundancyPct = relatedIds.length / Math.max(1, existingRows.length);
  const noveltyScore = Math.max(
    0,
    1 - avgSimilarity - redundancyPct * 0.5 + (contradictoryCount > 0 ? 0.2 : 0),
  );

  let category: NoveltyResult["category"];
  let explanation: string;

  if (contradictoryCount > 0) {
    category = "contradictory";
    explanation = `Found ${contradictoryCount} potentially contradictory memory(ies) with overlapping claims.`;
  } else if (noveltyScore > 0.6) {
    category = "novel";
    explanation = `Content introduces new information (novelty score: ${noveltyScore.toFixed(2)}).`;
  } else if (avgSimilarity > 0.85) {
    category = "redundant";
    explanation = `Content is highly similar to ${reinforceCount} existing memory(ies) — reinforcing existing knowledge.`;
  } else {
    category = "reinforcement";
    explanation = `Content adds context to ${relatedIds.length} related memory(ies) without redundancy.`;
  }

  return {
    isNovel: noveltyScore > 0.5,
    noveltyScore,
    category,
    relatedIds: relatedIds.slice(0, 5),
    explanation,
  };
}

function computeTextSimilarity(a: string, b: string): number {
  const wordsA = new Set(
    a.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2),
  );
  const wordsB = new Set(
    b.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2),
  );
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? intersection / union : 0;
}

function hasNegation(text: string): boolean {
  const negationPattern =
    /\b(not|no|never|don't|doesn't|didn't|won't|wouldn't|couldn't|shouldn't|isn't|aren't|wasn't|weren't)\b/i;
  return negationPattern.test(text);
}

export function detectContradictions(
  newContent: string,
  existingMemoryIds: string[],
): { contradictoryIds: string[]; confidence: number }[] {
  const results: { contradictoryIds: string[]; confidence: number }[] = [];
  if (existingMemoryIds.length === 0) return results;

  const db = openDb();
  const placeholders = existingMemoryIds.map(() => "?").join(", ");
  const rows = db
    .prepare<[string[]], { id: string; content: string }>(
      `SELECT id, content FROM memory_points WHERE id IN (${placeholders})`,
    )
    .all(existingMemoryIds);

  const newClaims = extractClaims(newContent);
  const newNegations = extractNegations(newContent);

  for (const row of rows) {
    const existingClaims = extractClaims(row.content);
    const existingNegations = extractNegations(row.content);
    let contradictions = 0;
    for (const nc of newClaims) {
      for (const ec of existingClaims) {
        if (areContradictory(nc, ec)) contradictions++;
      }
    }
    if (newNegations.length > 0 && existingClaims.length > 0) {
      for (const nn of newNegations) {
        for (const ec of existingClaims) {
          if (areNegationOf(nn, ec)) contradictions++;
        }
      }
    }
    if (contradictions > 0) {
      results.push({
        contradictoryIds: [row.id],
        confidence: Math.min(1, contradictions * 0.3),
      });
    }
  }
  return results;
}

function extractClaims(text: string): string[] {
  const factPatterns = [
    /\b(?:is|are|was|were|will be|has|have|had|does|do|did)\s+([^.!?]{10,50})/gi,
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+(?:is|was|are|were)\s+([^.!?]{5,50})/g,
    /\b(the\s+\w+\s+(?:is|was|are|were|has|have|had)\s+[^.!?]{5,50})/gi,
  ];
  const claims: string[] = [];
  for (const pattern of factPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      claims.push(match[1].toLowerCase().trim());
    }
  }
  return claims;
}

function extractNegations(text: string): string[] {
  const pattern = /\b(not|no|never|don't|doesn't|didn't|won't|wouldn't)\s+([^.!?]{5,50})/gi;
  const negations: string[] = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    negations.push((match[1] + " " + match[2]).toLowerCase().trim());
  }
  return negations;
}

function areContradictory(a: string, b: string): boolean {
  const hashA = createHash("sha1").update(a).digest("hex").slice(0, 8);
  const hashB = createHash("sha1").update(b).digest("hex").slice(0, 8);
  return hammingDistance(hashA, hashB) < 3;
}

function areNegationOf(negation: string, claim: string): boolean {
  const negWords = negation.split(/\s+/);
  const claimWords = claim.split(/\s+/);
  const overlap = negWords.filter((w) => claimWords.includes(w)).length;
  return overlap >= 2 && negation.includes("not") !== claim.includes("not");
}

export function applyNoveltyBoost(memoryId: string, noveltyScore: number): void {
  if (noveltyScore <= 0 || !memoryId) return;
  const boost = Math.min(NOVELTY_BOOST, noveltyScore * NOVELTY_BOOST * 2);
  try {
    const db = openDb();
    db.prepare(
      `UPDATE memory_points
       SET importance = MIN(1.0, importance + ?), updated_at = ?
       WHERE id = ?`,
    ).run(boost, new Date().toISOString(), memoryId);
  } catch {
    // ignore
  }
}

export function applyRedundancyPenalty(
  memoryIds: string[],
  db: SqliteDatabase = openDb(),
): void {
  if (memoryIds.length < 1) return;
  try {
    const placeholders = memoryIds.map(() => "?").join(", ");
    db.prepare(
      `UPDATE memory_points
       SET importance = MAX(0.01, importance - ${REDUNDANCY_PENALTY}), updated_at = ?
       WHERE id IN (${placeholders})`,
    ).run(new Date().toISOString(), ...memoryIds);
  } catch {
    // ignore
  }
}

export function tagContradiction(memoryId: string, contradictoryWithId: string): void {
  try {
    const db = openDb();
    const metadata = JSON.stringify({
      contradictory: true,
      contradictoryWith: contradictoryWithId,
      taggedAt: new Date().toISOString(),
    });
    db.prepare(
      `UPDATE memory_points
       SET metadata = ?, updated_at = ?
       WHERE id = ?`,
    ).run(metadata, new Date().toISOString(), memoryId);
    insertRelation(memoryId, contradictoryWithId, "contradicts", 0.9);
  } catch {
    // ignore
  }
}

export function getNoveltyStats(): {
  totalAssessed: number;
  avgNoveltyScore: number;
  novelCount: number;
  contradictoryCount: number;
} {
  try {
    const db = openDb();
    const row = db
      .prepare<[], { total: number; avg_score: number }>(
        `SELECT COUNT(*) AS total, AVG(importance) AS avg_score FROM memory_points WHERE importance > 0.5`,
      )
      .get();
    const novel = db
      .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM memory_points WHERE importance >= 0.7`)
      .get();
    return {
      totalAssessed: row?.total ?? 0,
      avgNoveltyScore: row?.avg_score ?? 0.5,
      novelCount: novel?.c ?? 0,
      contradictoryCount: 0,
    };
  } catch {
    return { totalAssessed: 0, avgNoveltyScore: 0.5, novelCount: 0, contradictoryCount: 0 };
  }
}