// Phase 4 — learning from USE. The feedback-signal application logic (shared by
// the routes and the selfcheck) plus the usage summary aggregation.
//
// The memory-feedback path is the live self-improvement loop: a 👍/👎 on a
// surfaced memory nudges its importance, and importance is a feature the learned
// ranker reads (reasoning/ranker.featureInput) — so user verdicts directly shape
// future retrieval. Action feedback is recorded as resolver-training data.

import { getMemoryPoint } from "../db/repositories/memory.js";
import { updateMemoryImportance } from "../memory/memoryLifecycle.js";
import { actionLogStats } from "../db/repositories/actions.js";
import { totalIngested } from "../db/repositories/ingest.js";
import { recordUsageFeedback, usageFeedbackStats } from "../db/repositories/usageFeedback.js";
import type { UsageSummary } from "../../../shared/learning.js";

// Matches the answer-feedback nudge in routes/feedback.ts — one verdict is a
// weak signal and must never dominate.
const MEMORY_IMPORTANCE_DELTA = 0.05;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

// Returns the memory's new importance, or null if the memory doesn't exist.
export function applyMemoryFeedback(memoryId: string, rating: 1 | -1): { importance: number } | null {
  const mem = getMemoryPoint(memoryId);
  if (!mem) {
    return null;
  }
  const importance = clamp01(mem.importance + rating * MEMORY_IMPORTANCE_DELTA);
  updateMemoryImportance(memoryId, importance);
  recordUsageFeedback("memory", memoryId, rating);
  return { importance };
}

export function applyActionFeedback(actionId: string, rating: 1 | -1): void {
  recordUsageFeedback("action", actionId, rating);
}

export function getUsageSummary(): UsageSummary {
  const a = actionLogStats();
  const fb = usageFeedbackStats();
  return {
    actions: {
      total: a.total,
      ok: a.ok,
      successRate: a.total > 0 ? a.ok / a.total : 0,
    },
    ingest: { totalIngested: totalIngested() },
    memoryFeedback: fb.memory,
    actionFeedback: fb.action,
  };
}
