// Self-model — measured calibration + a per-domain competence map.
//
// Real metacognition is not "confidence: 0.7"; it's KNOWING what you know.
// Two measured structures, both persisted, both with behavioral consumers:
//
//   calibration — reliability bins of (stated confidence → did the user
//                 actually confirm the answer?). Outcomes come from explicit
//                 👍/👎 (the only honest ground truth this brain has); the
//                 stated confidence for the run is read back from routing_log.
//                 Consumer: calibrateConfidence() corrects the error step's
//                 raw confidence with the measured curve BEFORE it feeds
//                 BrainState (so the feed-forward broaden gate and the
//                 metacognition floor act on calibrated, not claimed,
//                 confidence). Cold bins pass the stated value through — the
//                 correction is structurally a no-op until evidence accrues.
//
//   competence  — per-project EMA of cycle confidence + citation grounding.
//                 Consumer: surfaced via GET /api/brain/selfmodel ("what I'm
//                 good at / where I'm blind"), and weak-domain queries read it
//                 through the same broaden gate (the pipeline broadens
//                 retrieval when competence in the query's domain is low).
//
// Pure math exported for the selfcheck; persistence is one brain_metadata JSON
// row; every reader degrades to identity / empty on a broken store.

import { openDb } from "../db/sqlite.js";
import { surfaceError } from "../util/diagnostics.js";

export interface CalibrationBin {
  n: number;
  correct: number;
}

export interface CompetenceStat {
  /** EMA of error-step confidence for cycles in this domain. */
  confidence: number;
  /** EMA of citation grounding (1 = answer cited memory, 0 = none). */
  grounding: number;
  cycles: number;
  up: number;
  down: number;
}

export interface SelfModelState {
  bins: CalibrationBin[];
  competence: Record<string, CompetenceStat>;
  feedbackObservations: number;
}

export const BIN_COUNT = 5;
// A bin needs this many real outcomes before it corrects anything.
export const MIN_BIN_OBS = 5;
export const COMPETENCE_ALPHA = 0.25;
// Below this competence confidence, the domain counts as WEAK (broaden gate).
export const WEAK_COMPETENCE_FLOOR = 0.4;
export const MIN_COMPETENCE_CYCLES = 3;
// Bound the competence map (single-user brains accumulate odd project names).
const MAX_DOMAINS = 64;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function emptySelfModelState(): SelfModelState {
  return {
    bins: Array.from({ length: BIN_COUNT }, () => ({ n: 0, correct: 0 })),
    competence: {},
    feedbackObservations: 0,
  };
}

// -----------------------------------------------------------------------------
// PURE helpers.
// -----------------------------------------------------------------------------

export function binIndex(confidence: number): number {
  const c = clamp01(confidence);
  return Math.min(BIN_COUNT - 1, Math.floor(c * BIN_COUNT));
}

/** Fold one (stated confidence, real outcome) observation in. Pure. */
export function observeOutcome(state: SelfModelState, confidence: number, good: boolean): SelfModelState {
  const bins = state.bins.map((b) => ({ ...b }));
  const i = binIndex(confidence);
  bins[i] = { n: bins[i].n + 1, correct: bins[i].correct + (good ? 1 : 0) };
  return { ...state, bins, feedbackObservations: state.feedbackObservations + 1 };
}

/**
 * Correct a stated confidence with the measured curve. Laplace-smoothed
 * empirical accuracy, blended toward the stated value by evidence volume —
 * a cold bin returns the stated value EXACTLY (no-regression floor).
 */
export function calibrateConfidence(state: SelfModelState, stated: number): number {
  const bin = state.bins[binIndex(stated)];
  if (!bin || bin.n < MIN_BIN_OBS) return clamp01(stated);
  const empirical = (bin.correct + 1) / (bin.n + 2);
  // Evidence-weighted blend: at MIN_BIN_OBS the empirical curve carries half
  // the weight; it approaches full weight as the bin fills.
  const w = Math.min(1, bin.n / (MIN_BIN_OBS * 2));
  return clamp01((1 - w) * clamp01(stated) + w * empirical);
}

/** Domain key for a cycle. Project name when present, else the global bucket. */
export function domainFor(projectName: string | null | undefined): string {
  const p = (projectName ?? "").trim();
  return p.length > 0 ? p.slice(0, 80) : "(general)";
}

/** Fold one reasoning cycle into the competence map. Pure. */
export function observeCycle(
  state: SelfModelState,
  input: { projectName: string | null | undefined; confidence: number; cited: boolean },
): SelfModelState {
  const key = domainFor(input.projectName);
  const prev = state.competence[key];
  const next: CompetenceStat = prev
    ? {
        confidence: clamp01(prev.confidence + COMPETENCE_ALPHA * (clamp01(input.confidence) - prev.confidence)),
        grounding: clamp01(prev.grounding + COMPETENCE_ALPHA * ((input.cited ? 1 : 0) - prev.grounding)),
        cycles: prev.cycles + 1,
        up: prev.up,
        down: prev.down,
      }
    : { confidence: clamp01(input.confidence), grounding: input.cited ? 1 : 0, cycles: 1, up: 0, down: 0 };
  const competence = { ...state.competence, [key]: next };
  // Bound the map: drop the least-exercised domain beyond the cap.
  const keys = Object.keys(competence);
  if (keys.length > MAX_DOMAINS) {
    const weakest = keys.reduce((a, b) => (competence[a].cycles <= competence[b].cycles ? a : b));
    delete competence[weakest];
  }
  return { ...state, competence };
}

/** Fold a 👍/👎 into the cycle's domain (competence channel). Pure. */
export function observeDomainFeedback(state: SelfModelState, projectName: string | null | undefined, rating: 1 | -1): SelfModelState {
  const key = domainFor(projectName);
  const prev = state.competence[key] ?? { confidence: 0.5, grounding: 0, cycles: 0, up: 0, down: 0 };
  return {
    ...state,
    competence: {
      ...state.competence,
      [key]: { ...prev, up: prev.up + (rating > 0 ? 1 : 0), down: prev.down + (rating < 0 ? 1 : 0) },
    },
  };
}

/** Is this domain measured-weak? Cold domains are NOT weak (no prior). */
export function isWeakDomain(state: SelfModelState, projectName: string | null | undefined): boolean {
  const stat = state.competence[domainFor(projectName)];
  if (!stat || stat.cycles < MIN_COMPETENCE_CYCLES) return false;
  return stat.confidence < WEAK_COMPETENCE_FLOOR;
}

// -----------------------------------------------------------------------------
// Persistence + run-confidence lookup. Failure-isolated.
// -----------------------------------------------------------------------------

const META_KEY = "self-model-v1";

export function loadSelfModelState(): SelfModelState {
  try {
    const row = openDb()
      .prepare("SELECT value FROM brain_metadata WHERE key = ?")
      .get(META_KEY) as { value: string } | undefined;
    if (row) {
      const parsed = JSON.parse(row.value) as Partial<SelfModelState>;
      if (Array.isArray(parsed.bins) && parsed.bins.length === BIN_COUNT && parsed.competence) {
        return parsed as SelfModelState;
      }
    }
  } catch (err) {
    surfaceError("selfModel.load", err);
  }
  return emptySelfModelState();
}

export function saveSelfModelState(state: SelfModelState): void {
  try {
    openDb()
      .prepare(
        "INSERT INTO brain_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(META_KEY, JSON.stringify(state));
  } catch (err) {
    surfaceError("selfModel.save", err);
  }
}

/**
 * The stated confidence the pipeline logged for a run (routing_log). null when
 * the run is unknown/pruned — feedback on it then skips calibration honestly.
 */
export function confidenceForRun(runId: string): number | null {
  try {
    const row = openDb()
      .prepare("SELECT confidence FROM routing_log WHERE run_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(runId) as { confidence: number } | undefined;
    return typeof row?.confidence === "number" ? clamp01(row.confidence) : null;
  } catch (err) {
    surfaceError("selfModel.confidenceForRun", err);
    return null;
  }
}

/** Reliability summary for the status surface. */
export function calibrationSummary(state: SelfModelState): Array<{
  range: string;
  n: number;
  empirical: number | null;
}> {
  return state.bins.map((b, i) => ({
    range: `${(i / BIN_COUNT).toFixed(1)}–${((i + 1) / BIN_COUNT).toFixed(1)}`,
    n: b.n,
    empirical: b.n > 0 ? Number(((b.correct + 1) / (b.n + 2)).toFixed(3)) : null,
  }));
}
