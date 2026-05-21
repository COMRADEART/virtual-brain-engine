import type { MemoryPoint, MemorySourceType } from "../../../shared/memory.js";

export interface ImportanceFactors {
  baseImportance: number;
  ageDays: number;
  citationCount: number;
  projectBoost: number;
  sourceType: MemorySourceType;
  contentLength: number;
}

export interface ImportanceResult {
  score: number;
  factors: ImportanceFactors;
  breakdown: {
    recencyScore: number;
    frequencyScore: number;
    projectScore: number;
    sourceScore: number;
  };
}

const RECENCY_HALF_LIFE_DAYS = 14;
const MAX_CITATION_BOOST = 3;
const CITATION_HALF_LIFE = 5;
const SOURCE_WEIGHTS: Record<MemorySourceType, number> = {
  conversation: 1.2,
  chunk: 1.0,
  manual: 1.4,
};
const MIN_IMPORTANCE = 0.02;
const MAX_IMPORTANCE = 1.0;

function recencyFactor(ageDays: number): number {
  return Math.exp(-(ageDays * Math.LN2) / RECENCY_HALF_LIFE_DAYS);
}

function frequencyBoost(citationCount: number): number {
  if (citationCount === 0) return 1.0;
  return 1 + (MAX_CITATION_BOOST - 1) * (1 - Math.exp(-citationCount / CITATION_HALF_LIFE));
}

export function computeImportance(factors: ImportanceFactors): ImportanceResult {
  const recencyScore = recencyFactor(factors.ageDays);
  const frequencyScore = frequencyBoost(factors.citationCount);
  const projectScore = factors.projectBoost >= 0.5 ? 1.2 : 0.9;
  const sourceScore = SOURCE_WEIGHTS[factors.sourceType] ?? 1.0;

  const score = Math.min(
    MAX_IMPORTANCE,
    Math.max(
      MIN_IMPORTANCE,
      factors.baseImportance * recencyScore * frequencyScore * projectScore * sourceScore,
    ),
  );

  return {
    score,
    factors,
    breakdown: {
      recencyScore,
      frequencyScore,
      projectScore,
      sourceScore,
    },
  };
}

export function applyImportanceBoost(
  currentImportance: number,
  citationDelta: number,
): number {
  const boost = Math.min(0.15, citationDelta * 0.05);
  return Math.min(MAX_IMPORTANCE, currentImportance + boost);
}

export function applyDecay(currentImportance: number, ageDays: number): number {
  const decayed = currentImportance * recencyFactor(ageDays);
  // Clamp both ends: a negative ageDays (clock skew / a row whose updatedAt is
  // slightly in the future) makes recencyFactor() > 1, which would otherwise
  // inflate importance past the ceiling. Mirrors computeImportance().
  return Math.min(MAX_IMPORTANCE, Math.max(MIN_IMPORTANCE, decayed));
}

export function getImportanceTier(
  importance: number,
): "high" | "medium" | "low" | "forget" {
  if (importance >= 0.6) return "high";
  if (importance >= 0.3) return "medium";
  if (importance >= 0.1) return "low";
  return "forget";
}