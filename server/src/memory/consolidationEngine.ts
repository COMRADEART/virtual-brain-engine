import { broadcast } from "../ws/brainBus.js";
import { getDefaultConnectorInstance, listConnectorInstances } from "../connectors/registry.js";
import { Connector } from "../connectors/Connector.js";
import { openDb, type SqliteDatabase } from "../db/sqlite.js";
import {
  applyDecay,
  applyImportanceBoost,
  computeImportance,
  getImportanceTier,
  type ImportanceFactors,
} from "./importanceScorer.js";
import {
  applySpreadingActivationBoost,
  batchUpdateStrength,
  computeMemoryHalfLife,
  getStrengthStats,
  propagateStrength,
  strengthenPathway,
  updateMemoryStrength,
} from "./memoryStrength.js";
import {
  applyNoveltyBoost,
  applyRedundancyPenalty,
  assessNovelty,
  detectContradictions,
  tagContradiction,
} from "./noveltyDetector.js";
import {
  applySpreadingActivation,
  buildAccessPattern,
  flushActivationCache,
  getActivationLevel,
  getHotMemories,
  getRelatedMemories,
  recordAccess,
} from "./accessPatternTracker.js";
import {
  computeNgramOverlap,
  getAllClusters,
  getClusterStats,
  getClustersForMemory,
  updateClusterForMemory,
} from "./semanticCluster.js";
import {
  predictNext,
  prefetchForQuery,
  recordConversationSequence,
  updateTemporalPattern,
} from "./predictivePrefetch.js";
import {
  adaptThresholds,
  getCurrentThresholds,
  getThresholdMetrics,
  loadThresholds,
  type AdaptiveThresholds,
} from "./thresholdController.js";
import {
  createSummaryMemory,
  getActiveProjectNames,
  getLowImportanceMemories,
  getMemoryById,
  isMemoryArchived,
  linkSummary,
  softDeleteMemory,
  type LifecycleMemory,
  updateMemoryImportance,
} from "./memoryLifecycle.js";
import { replayMemories } from "./replayService.js";

export interface ConsolidationAction {
  type: "promote" | "consolidate" | "archive" | "decay" | "skip";
  memoryId: string;
  reason: string;
  newImportance?: number;
  summaryId?: string;
}

export interface ConsolidationResult {
  actions: ConsolidationAction[];
  processed: number;
  promoted: number;
  consolidated: number;
  archived: number;
  decayed: number;
  skipped: number;
  replayed: number; // Count of replayed memories
  strengthened: number; // Count of pathways strengthened via STDP
  durationMs: number;
  nextRunIn: number;
  algorithms: {
    spreadingActivation: number;
    noveltyBoost: number;
    contradictionFlags: number;
    clustersAffected: number;
    strengthUpdates: number;
    replayEvents: number; // Count of replay cycles
    predictions: number;
  };
}

interface ConsolidationEvent {
  type: "consolidation";
  detail: string;
  status: "start" | "complete" | "progress";
  timestamp: string;
  [key: string]: unknown;
}

const SUMMARY_MODEL_MAX_TOKENS = 200;
const DECAY_INTERVAL_MESSAGES = 50;

let messageCountSinceLastDecay = 0;
let consolidationRunning = false;
let thresholds: AdaptiveThresholds;

function makeEvent(detail: string, status: "start" | "complete" | "progress" = "complete"): ConsolidationEvent {
  return {
    type: "consolidation",
    detail,
    status,
    timestamp: new Date().toISOString(),
  };
}

function getActiveEmbedder(): Connector | null {
  const active = getDefaultConnectorInstance();
  if (active?.embed) return active;
  const fallback = listConnectorInstances().find(
    (c) =>
      c.descriptor.kind === "ollama" &&
      c.descriptor.enabled &&
      c.descriptor.state === "ok" &&
      Boolean(c.embed),
  );
  return fallback ?? null;
}

function inferProjectRelevance(projectName: string | null | undefined): number {
  if (!projectName) return 0.3;
  const active = getActiveProjectNames();
  return active.includes(projectName) ? 0.8 : 0.5;
}

async function generateSummary(connector: Connector, memory: LifecycleMemory): Promise<string | null> {
  const summaryPrompt = `Summarize the following conversation concisely, preserving key facts, decisions, and conclusions. Keep it under 150 words.

Title: ${memory.title ?? "(untitled)"}
Content: ${memory.content}

Summary:`;

  try {
    const text = await connector.send(summaryPrompt, {
      system: "You are a precise text compressor. Output ONLY the summary, no preamble.",
      format: "text",
      temperature: 0.1,
      maxTokens: SUMMARY_MODEL_MAX_TOKENS,
    });
    return text.trim();
  } catch (err) {
    console.warn("[consolidation] summary generation failed:", err);
    return null;
  }
}

async function evaluateMemory(
  memory: LifecycleMemory,
  connector: Connector | null,
): Promise<ConsolidationAction> {
  const now = Date.now();
  const ageDays = (now - new Date(memory.createdAt).getTime()) / 86400000;
  const t = getCurrentThresholds();

  const factors: ImportanceFactors = {
    baseImportance: memory.importance,
    ageDays,
    citationCount: memory.citation_count,
    projectBoost: inferProjectRelevance(memory.projectName),
    sourceType: memory.sourceType,
    contentLength: memory.content.length,
  };

  const { score, breakdown } = computeImportance(factors);
  const tier = getImportanceTier(score);

  if (score < t.forget) {
    return {
      type: "archive",
      memoryId: memory.id,
      reason: `importance ${score.toFixed(3)} < forget threshold ${t.forget.toFixed(3)}`,
      newImportance: score,
    };
  }

  if (tier === "low" && memory.sourceType === "conversation" && ageDays > 7) {
    if (connector) {
      const summaryContent = await generateSummary(connector, memory);
      if (summaryContent && summaryContent.length < memory.content.length * 0.7) {
        try {
          const summary = createSummaryMemory(
            memory.id,
            summaryContent,
            score * 1.1,
            memory.projectName ?? null,
          );
          linkSummary(memory.id, summary.id);
          updateMemoryImportance(memory.id, score * 0.6);
          return {
            type: "consolidate",
            memoryId: memory.id,
            reason: `compressed ${memory.content.length} → ${summaryContent.length} chars`,
            newImportance: score * 0.6,
            summaryId: summary.id,
          };
        } catch (err) {
          console.warn("[consolidation] summary creation failed:", err);
        }
      }
    }
  }

  if (score >= t.promote && ageDays > 3) {
    return {
      type: "promote",
      memoryId: memory.id,
      reason: `high importance ${score.toFixed(3)} maintained (recency=${breakdown.recencyScore.toFixed(2)}, freq=${breakdown.frequencyScore.toFixed(2)})`,
      newImportance: Math.min(1.0, score * 1.05),
    };
  }

  return {
    type: "decay",
    memoryId: memory.id,
    reason: `routine decay applied`,
    newImportance: score,
  };
}

function applyAction(action: ConsolidationAction): void {
  switch (action.type) {
    case "archive":
      softDeleteMemory(action.memoryId);
      break;
    case "promote":
    case "decay":
      if (action.newImportance !== undefined) {
        updateMemoryImportance(action.memoryId, action.newImportance);
      }
      break;
    case "consolidate":
    case "skip":
      break;
  }
}

export async function runConsolidationCycle(): Promise<ConsolidationResult> {
  if (consolidationRunning) {
    return {
      actions: [],
      processed: 0,
      promoted: 0,
      consolidated: 0,
      archived: 0,
      decayed: 0,
      skipped: 0,
      replayed: 0,
      strengthened: 0,
      durationMs: 0,
      nextRunIn: DECAY_INTERVAL_MESSAGES,
      algorithms: { spreadingActivation: 0, noveltyBoost: 0, contradictionFlags: 0, clustersAffected: 0, strengthUpdates: 0, replayEvents: 0, predictions: 0 },
    };
  }

  consolidationRunning = true;
  const start = Date.now();
  broadcast(makeEvent("Starting memory consolidation cycle", "start"));

  thresholds = loadThresholds();
  const adapted = adaptThresholds();
  if (adapted !== thresholds) {
    broadcast(makeEvent(`Thresholds adapted: forget=${adapted.forget.toFixed(3)}, consolidate=${adapted.consolidate.toFixed(3)}, promote=${adapted.promote.toFixed(3)}`, "progress"));
  }

  const connector = getDefaultConnectorInstance();
  const actions: ConsolidationAction[] = [];
  let promoted = 0;
  let consolidated = 0;
  let archived = 0;
  let decayed = 0;
  let skipped = 0;
  const stats = {
    spreadingActivation: 0,
    noveltyBoost: 0,
    contradictionFlags: 0,
    clustersAffected: 0,
    strengthUpdates: 0,
    replayEvents: 0, // Initialize replay counter
    predictions: 0,
  };

  applySpreadingActivation();
  const strengthUpdates = flushActivationCache();
  stats.spreadingActivation = strengthUpdates.size;

  // Hippocampal-neocortical replay during consolidation
  // Focus on hot memories (frequently accessed, highly important)
  const hotMemories = getHotMemories(24, 20);
  const replayStats = await replayMemories(hotMemories.map((m) => m.id));
  stats.replayEvents = replayStats.replayed;
  stats.strengthUpdates += replayStats.strengthened;

  try {
    const candidates = getLowImportanceMemories(
      thresholds.consolidate,
      10,
    );

    for (const memory of candidates) {
      if (archived >= 3) break;
      if (isMemoryArchived(memory.id)) continue;

      const ageDays = (Date.now() - new Date(memory.createdAt).getTime()) / 86400000;
      const factors: ImportanceFactors = {
        baseImportance: memory.importance,
        ageDays,
        citationCount: memory.citation_count,
        projectBoost: inferProjectRelevance(memory.projectName),
        sourceType: memory.sourceType,
        contentLength: memory.content.length,
      };
      const { score } = computeImportance(factors);

      if (score < thresholds.forget) {
        const action: ConsolidationAction = {
          type: "archive",
          memoryId: memory.id,
          reason: `importance ${score.toFixed(3)} below forget threshold ${thresholds.forget.toFixed(3)}`,
          newImportance: score,
        };
        actions.push(action);
        applyAction(action);
        archived++;
        broadcast(makeEvent(`Archived ${memory.id.slice(-6)}: ${action.reason}`));
        continue;
      }

      if (consolidated >= 5) break;

      const action = await evaluateMemory(memory, connector);
      actions.push(action);
      applyAction(action);

      switch (action.type) {
        case "consolidate":
          consolidated++;
          broadcast(makeEvent(`Consolidated ${memory.id.slice(-6)}: ${action.reason}`));
          break;
        case "promote":
          promoted++;
          break;
        case "decay":
          decayed++;
          break;
        case "archive":
          archived++;
          break;
        case "skip":
          skipped++;
          break;
      }
    }

    for (const action of actions) {
      if (action.type === "consolidate" || action.type === "promote") {
        const related = getRelatedMemories(action.memoryId, 5);
        if (related.length > 0) {
          propagateStrength(action.memoryId, 1);
          stats.strengthUpdates += related.length + 1;
        }
      }
    }

    const remaining = getLowImportanceMemories(thresholds.consolidate, 20);
    let routineDecayed = 0;
    for (const memory of remaining) {
      if (actions.some((a) => a.memoryId === memory.id)) continue;
      if (routineDecayed >= 10) break;
      const aDays = (Date.now() - new Date(memory.updatedAt).getTime()) / 86400000;
      const newScore = applyDecay(memory.importance, aDays);
      if (newScore < memory.importance) {
        updateMemoryImportance(memory.id, newScore);
        routineDecayed++;
      }
    }
    decayed += routineDecayed;
    messageCountSinceLastDecay = 0;
  } finally {
    consolidationRunning = false;
  }

  const durationMs = Date.now() - start;
  const result: ConsolidationResult = {
    actions,
    processed: actions.length,
    promoted,
    consolidated,
    archived,
    decayed,
    skipped,
    replayed: replayStats.replayed,
    strengthened: replayStats.strengthened,
    durationMs,
    nextRunIn: DECAY_INTERVAL_MESSAGES,
    algorithms: stats,
  };

  broadcast(
    makeEvent(
      `Consolidation done: ${promoted} promoted, ${consolidated} consolidated, ${archived} archived, ${decayed} decayed (${durationMs}ms)`,
    ),
  );

  return result;
}

export async function onConversationMessage(
  conversationContext?: {
    lastMemories?: string[];
    projectName?: string | null;
    query?: string;
  },
): Promise<void> {
  messageCountSinceLastDecay++;

  if (conversationContext?.lastMemories?.length) {
    // Build temporal access patterns between sequential memories
    for (let i = 0; i < conversationContext.lastMemories.length - 1; i++) {
      buildAccessPattern(
        conversationContext.lastMemories[i],
        conversationContext.lastMemories[i + 1],
      );
    }
    
    // Record conversation sequence
    recordConversationSequence(
      conversationContext.lastMemories[conversationContext.lastMemories.length - 1],
    );
    updateTemporalPattern(
      conversationContext.lastMemories[conversationContext.lastMemories.length - 1],
    );
    
    // Mark recent memories as accessed
    for (const id of conversationContext.lastMemories.slice(-3)) {
      recordAccess(id, conversationContext.query);
    }
    
    // Light replay during conversation (1 cycle)
    // Reinforces pathway weights for conversational context
    await replayMemories(conversationContext.lastMemories, 1);
  }

  if (conversationContext?.query) {
    const predictions = prefetchForQuery(conversationContext.query, 5);
    if (predictions.length > 0) {
      recordAccess(predictions[0], "prefetch");
    }
  }

  if (messageCountSinceLastDecay >= DECAY_INTERVAL_MESSAGES) {
    runQuickDecay();
    messageCountSinceLastDecay = 0;
  }
}

export function processNewMemory(
  content: string,
  projectName: string | null,
  newMemoryId?: string,
): {
  importanceBoost: number;
  noveltyCategory: string;
  noveltyScore: number;
  clusterIds: string[];
  predictedRelated: string[];
  relatedIds: string[];
} {
  const novelty = assessNovelty(content, projectName);

  if (newMemoryId && novelty.isNovel) {
    applyNoveltyBoost(newMemoryId, novelty.noveltyScore);
  }

  if (newMemoryId && novelty.category === "redundant" && novelty.relatedIds.length > 0) {
    applyRedundancyPenalty(novelty.relatedIds.slice(0, 3));
  }

  if (newMemoryId && novelty.category === "contradictory") {
    const contradictions = detectContradictions(content, novelty.relatedIds);
    for (const c of contradictions) {
      if (c.contradictoryIds[0]) {
        tagContradiction(newMemoryId, c.contradictoryIds[0]);
      }
    }
  }

  if (newMemoryId) {
    updateClusterForMemory(newMemoryId, content);
  }

  let clusterIds: string[] = [];
  try {
    const clusters = getAllClusters(5);
    for (const cluster of clusters) {
      if (cluster.memoryIds.length > 0) {
        const sampleId = cluster.memoryIds[0];
        const mem = getMemoryById(sampleId);
        if (mem) {
          const sim = computeNgramOverlap(content, mem.content);
          if (sim > 0.4) {
            clusterIds.push(cluster.clusterId);
          }
        }
      }
    }
  } catch {
    // ignore
  }

  const now = new Date();
  const predictions = predictNext({
    lastN: [],
    projectName,
    hourOfDay: now.getHours(),
    dayOfWeek: now.getDay(),
  });

  return {
    importanceBoost: novelty.noveltyScore > 0.5 ? novelty.noveltyScore * 0.1 : 0,
    noveltyCategory: novelty.category,
    noveltyScore: novelty.noveltyScore,
    clusterIds,
    predictedRelated: predictions.flatMap((p) => p.memoryIds).slice(0, 5),
    relatedIds: novelty.relatedIds,
  };
}

export function applyMemoryRetrievalBoost(
  memoryIds: string[],
  db: SqliteDatabase = openDb(),
): void {
  if (memoryIds.length === 0) return;
  for (const id of memoryIds) {
    recordAccess(id, "retrieval");
    // Additive boost: updateMemoryImportance SETS the absolute value, so
    // passing 0.01 there crushed every retrieved memory to the floor.
    // updateMemoryStrength ADDS (clamped) — retrieval should reward use.
    updateMemoryStrength(id, 0.01, db);
    const related = getRelatedMemories(id, 3);
    applySpreadingActivationBoost(id, related, 0.03);
    strengthenPathway(id, id, db);
  }
}

function runQuickDecay(): void {
  try {
    const db = openDb();
    const t = getCurrentThresholds();
    const rows = db
      .prepare<[], { id: string; importance: number; updated_at: string }>(
        `SELECT id, importance, updated_at FROM memory_points
         WHERE datetime(updated_at) < datetime('now', '-1 days')
         AND summary_id IS NULL
         ORDER BY updated_at ASC LIMIT 50`,
      )
      .all();
    const halfLifeBoostUpdates: Array<{ id: string; delta: number }> = [];
    for (const row of rows) {
      const aDays = (Date.now() - new Date(row.updated_at).getTime()) / 86400000;
      const mem = getMemoryById(row.id);
      if (mem) {
        const factors: ImportanceFactors = {
          baseImportance: row.importance,
          ageDays: aDays,
          citationCount: mem.citation_count,
          projectBoost: inferProjectRelevance(mem.projectName),
          sourceType: mem.sourceType,
          contentLength: mem.content.length,
        };
        const { score } = computeImportance(factors);
        const halfLife = computeMemoryHalfLife(row.importance, 0, mem.citation_count);
        const effectiveDecay = Math.exp(-aDays / halfLife);
        const newImportance = row.importance * effectiveDecay;
        const delta = newImportance - row.importance;
        if (Math.abs(delta) > 0.001) {
          halfLifeBoostUpdates.push({ id: row.id, delta });
        }
      }
    }
    batchUpdateStrength(halfLifeBoostUpdates);
  } catch (err) {
    console.warn("[consolidation] quick decay failed:", err);
  }
}

export function scheduleDecayTick(): { spreadingActivation: NodeJS.Timeout; decayTick: NodeJS.Timeout } {
  const spreadingActivation = setInterval(
    () => {
      try {
        applySpreadingActivation();
        const updates = flushActivationCache();
        if (updates.size > 0) {
          const batch = [...updates.entries()].map(([id, delta]) => ({ id, delta }));
          batchUpdateStrength(batch);
        }
      } catch (err) {
        console.warn("[consolidation] hourly spreading activation failed:", err);
      }
    },
    30 * 60 * 1000,
  );

  const decayTick = setInterval(
    () => {
      try {
        const db = openDb();
        const rows = db
          .prepare<[], { id: string; importance: number; updated_at: string }>(
            `SELECT id, importance, updated_at FROM memory_points
             WHERE datetime(updated_at) < datetime('now', '-1 days')
             AND summary_id IS NULL
             ORDER BY updated_at ASC LIMIT 30`,
          )
          .all();
        const batch: Array<{ id: string; delta: number }> = [];
        for (const row of rows) {
          const aDays = (Date.now() - new Date(row.updated_at).getTime()) / 86400000;
          const mem = getMemoryById(row.id);
          if (mem) {
            const factors: ImportanceFactors = {
              baseImportance: row.importance,
              ageDays: aDays,
              citationCount: mem.citation_count,
              projectBoost: inferProjectRelevance(mem.projectName),
              sourceType: mem.sourceType,
              contentLength: mem.content.length,
            };
            const { score } = computeImportance(factors);
            const halfLife = computeMemoryHalfLife(row.importance, 0, mem.citation_count);
            const effectiveDecay = Math.exp(-aDays / halfLife);
            const newScore = row.importance * effectiveDecay;
            const delta = newScore - row.importance;
            if (Math.abs(delta) > 0.001) {
              batch.push({ id: row.id, delta });
            }
          }
        }
        batchUpdateStrength(batch);
      } catch (err) {
        console.warn("[consolidation] hourly decay tick failed:", err);
      }
    },
    60 * 60 * 1000,
  );

  return { spreadingActivation, decayTick };
}

export function getConsolidationStats(): {
  messageCountSinceLastDecay: number;
  nextDecayIn: number;
  running: boolean;
  thresholds: AdaptiveThresholds;
  clusterStats: ReturnType<typeof getClusterStats>;
  strengthStats: ReturnType<typeof getStrengthStats>;
  thresholdMetrics: ReturnType<typeof getThresholdMetrics>;
} {
  return {
    messageCountSinceLastDecay,
    nextDecayIn: Math.max(0, DECAY_INTERVAL_MESSAGES - messageCountSinceLastDecay),
    running: consolidationRunning,
    thresholds: getCurrentThresholds(),
    clusterStats: getClusterStats(),
    strengthStats: getStrengthStats(),
    thresholdMetrics: getThresholdMetrics(),
  };
}