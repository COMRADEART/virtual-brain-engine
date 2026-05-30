import { ulid } from "ulid";
import type { InterBrainMemory } from "../../../shared/civilization.js";

/**
 * Inter-Brain Social Memory (architecture component #11).
 *
 * Remembers cross-brain *interactions* (not knowledge — that's collectiveMemory):
 * which collaborations worked, which negotiations failed, who specialises in what,
 * and how credit was assigned. Pure in-memory; consulted when deciding whether to
 * cooperate with a peer again and to seed the digital twin / reputation layers.
 */

export type InteractionKind = InterBrainMemory["interactionType"];
export type InteractionOutcome = InterBrainMemory["outcome"];

export interface InterBrainMemoryConfig {
  maxRecords: number;
  /** Outcomes weighted when scoring a peer's collaboration value. */
  outcomeWeights: Record<InteractionOutcome, number>;
}

const DEFAULT_CONFIG: InterBrainMemoryConfig = {
  maxRecords: 10000,
  outcomeWeights: { success: 1, partial: 0.4, failure: -0.6 },
};

export interface CollaborationStats {
  brainId: string;
  total: number;
  success: number;
  partial: number;
  failure: number;
  /** Net collaboration value in [-1, 1]. */
  score: number;
  totalCredit: number;
  lastInteractionAt?: string;
}

export class InterBrainMemorySystem {
  private readonly config: InterBrainMemoryConfig;
  private readonly records: InterBrainMemory[] = [];

  constructor(config: Partial<InterBrainMemoryConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  record(
    interactionType: InteractionKind,
    participants: string[],
    outcome: InteractionOutcome,
    summary: string,
    lessonsLearned: string[] = [],
    creditAssignment: Record<string, number> = {},
  ): InterBrainMemory {
    const memory: InterBrainMemory = {
      id: ulid(),
      interactionType,
      participants,
      outcome,
      summary,
      lessonsLearned,
      creditAssignment,
      createdAt: new Date().toISOString(),
    };
    this.records.push(memory);
    if (this.records.length > this.config.maxRecords) {
      this.records.shift();
    }
    return memory;
  }

  getMemory(id: string): InterBrainMemory | undefined {
    return this.records.find((m) => m.id === id);
  }

  getMemoriesAbout(brainId: string): InterBrainMemory[] {
    return this.records.filter((m) => m.participants.includes(brainId));
  }

  getMemoriesByType(type: InteractionKind): InterBrainMemory[] {
    return this.records.filter((m) => m.interactionType === type);
  }

  getLessonsLearned(brainId?: string): string[] {
    const source = brainId ? this.getMemoriesAbout(brainId) : this.records;
    const lessons: string[] = [];
    for (const m of source) lessons.push(...m.lessonsLearned);
    return lessons;
  }

  /** Aggregate credit earned by a brain across all remembered interactions. */
  getCreditFor(brainId: string): number {
    let credit = 0;
    for (const m of this.records) {
      credit += m.creditAssignment[brainId] ?? 0;
    }
    return credit;
  }

  /** Per-peer collaboration profile — drives "cooperate again?" decisions. */
  getCollaborationStats(brainId: string): CollaborationStats {
    const memories = this.getMemoriesAbout(brainId);
    let success = 0, partial = 0, failure = 0, weighted = 0;
    let lastInteractionAt: string | undefined;

    for (const m of memories) {
      if (m.outcome === "success") success++;
      else if (m.outcome === "partial") partial++;
      else failure++;
      weighted += this.config.outcomeWeights[m.outcome];
      if (!lastInteractionAt || m.createdAt > lastInteractionAt) {
        lastInteractionAt = m.createdAt;
      }
    }

    const total = memories.length;
    return {
      brainId,
      total,
      success,
      partial,
      failure,
      score: total === 0 ? 0 : Math.max(-1, Math.min(1, weighted / total)),
      totalCredit: this.getCreditFor(brainId),
      lastInteractionAt,
    };
  }

  /** A short, human-readable history of dealings with a peer. */
  summarizeRelationship(brainId: string): string {
    const stats = this.getCollaborationStats(brainId);
    if (stats.total === 0) return `No remembered interactions with ${brainId}.`;
    const verdict = stats.score > 0.3 ? "reliable partner" : stats.score < -0.2 ? "troubled history" : "mixed record";
    return `${brainId}: ${stats.total} interactions (${stats.success}✓/${stats.partial}~/${stats.failure}✗), ${verdict}, credit ${stats.totalCredit.toFixed(1)}.`;
  }

  /** Brains we've worked with, best collaboration score first. */
  rankPartners(): CollaborationStats[] {
    const ids = new Set<string>();
    for (const m of this.records) for (const p of m.participants) ids.add(p);
    return Array.from(ids)
      .map((id) => this.getCollaborationStats(id))
      .sort((a, b) => b.score - a.score);
  }

  getAll(): InterBrainMemory[] {
    return [...this.records];
  }

  count(): number {
    return this.records.length;
  }
}

let singleton: InterBrainMemorySystem | null = null;

export function createInterBrainMemory(config?: Partial<InterBrainMemoryConfig>): InterBrainMemorySystem {
  if (!singleton) {
    singleton = new InterBrainMemorySystem(config);
  }
  return singleton;
}

export function getInterBrainMemory(): InterBrainMemorySystem | null {
  return singleton;
}
