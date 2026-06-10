// Central cognitive loop — STAR's unified, persistent BrainState.
//
// The 7-step pipeline already produced attention (saliency), confidence (error
// step) and learning (ranker), and the organism held goals — but nothing tied
// them into a stateful loop: each /api/ask ran once and forgot. This module is
// the seam that closes the loop. The pipeline calls perceive() / attend() /
// recordReasoning(); reasoning output lands in a persistent workspace; and the
// NEXT query's retrieval consumes priorUncertainty() — confidence feeding
// forward. Autonomous thought decays the workspace on a heartbeat (tickDecay).
//
// Design rules (mirror core/organism.ts):
//   - Singleton + KV persistence to the existing organism_state table (key
//     "brain-state-v1"). NO migration — that table is already idempotent.
//   - EVERY DB touch is failure-isolated (surfaceError) so a BrainState fault
//     can never break /api/ask. The loop is a refinement, not a dependency.
//   - decay / cap / the low-confidence rule / item extraction are PURE exported
//     helpers, so the selfcheck exercises them with no DB and no LLM (the same
//     discipline as attention/saliency.ts).

import { ulid } from "ulid";
import { openDb } from "../db/sqlite.js";
import { getEventBus, nowIso, type BrainBus } from "./eventBus.js";
import { surfaceError } from "../util/diagnostics.js";
import { tokens } from "../attention/saliency.js";
import { getPersistentOrganism } from "./organism.js";
import { loadRankerLossHistory, loadRankerState } from "../db/repositories/ranker.js";
import { getFeedbackStats } from "../db/repositories/feedback.js";
import { WARM_AT } from "../reasoning/ranker.js";
import {
  RE_REASON_CONFIDENCE_FLOOR,
  WORKING_CAPACITY,
  WORKING_DECAY_PER_MIN,
  WORKING_FLOOR,
  type AttentionFocus,
  type BrainCycle,
  type BrainLearningMetrics,
  type BrainStateSnapshot,
  type GoalNode,
  type WorkingItem,
} from "../../../shared/brainState.js";

const STATE_KEY = "brain-state-v1";
// Per-conversation states live beside the global one: brain-state-v1:<convId>.
// The singleton used to be last-writer-wins across conversations — two
// concurrent asks corrupted each other's working memory and feed-forward
// broaden signal. Keying by conversation isolates them; the bare key remains
// the global/legacy state (agent runs without a conversation, old rows).
const STATE_KEY_PREFIX = `${STATE_KEY}:`;
// Idle per-conversation states are pruned after this long (the global state
// is never pruned).
export const CONVERSATION_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SNAPSHOT_THROTTLE_MS = 1500;
const MAX_ATTENTION = 8;

export function stateKeyFor(conversationId?: string): string {
  return conversationId ? `${STATE_KEY_PREFIX}${conversationId}` : STATE_KEY;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// -----------------------------------------------------------------------------
// PURE helpers — no DB, no clock dependency beyond explicit args. The selfcheck
// drives these directly.
// -----------------------------------------------------------------------------

/** Decay working-memory activation by elapsed time; evict below the floor. */
export function decayWorking(
  items: ReadonlyArray<WorkingItem>,
  dtMs: number,
  floor = WORKING_FLOOR,
): WorkingItem[] {
  const minutes = Math.max(0, dtMs) / 60_000;
  // Compounding loss: WORKING_DECAY_PER_MIN of activation lost each minute.
  const factor = Math.pow(1 - WORKING_DECAY_PER_MIN, minutes);
  return items
    .map((it) => ({ ...it, activation: clamp01(it.activation * factor) }))
    .filter((it) => it.activation >= floor);
}

/** Keep the top-`cap` items by activation (most-active retained). */
export function capWorking(items: ReadonlyArray<WorkingItem>, cap = WORKING_CAPACITY): WorkingItem[] {
  if (items.length <= cap) return [...items];
  return [...items].sort((a, b) => b.activation - a.activation).slice(0, cap);
}

/**
 * Deferred-metacognition rule. Returns true when last confidence is below the
 * floor AND we have not already flagged this cycle — so it fires at most once
 * per cycle and is structurally incapable of looping.
 */
export function shouldReReason(confidence: number, alreadyFlagged: boolean): boolean {
  return confidence < RE_REASON_CONFIDENCE_FLOOR && !alreadyFlagged;
}

/**
 * BEHAVIORAL feed-forward gate. When the prior cycle was globally uncertain, the
 * next cycle should BROADEN retrieval (force multi-query expansion) rather than
 * narrow on the prior framing. This is the lever that actually changes WHAT is
 * retrieved — feeding the same scalar into saliency's uncertainty term only
 * shifts every candidate's score by an identical constant, which can't reorder a
 * monotonic blend (it's a UI/score signal, not a retrieval change). The floor
 * corresponds to a prior-cycle confidence of <= 0.4.
 */
export const BROADEN_UNCERTAINTY_FLOOR = 0.6;
export function shouldBroadenRetrieval(priorUncertainty: number): boolean {
  return Number.isFinite(priorUncertainty) && priorUncertainty >= BROADEN_UNCERTAINTY_FLOOR;
}

/** Extract up to `max` working items from a prompt via the saliency tokenizer. */
export function extractWorkingItems(prompt: string, max = 3): WorkingItem[] {
  const at = nowIso();
  const head: WorkingItem = {
    id: `wm-${ulid()}`,
    label: prompt.trim().slice(0, 80) || "(empty)",
    kind: "query",
    activation: 1,
    at,
  };
  const facts: WorkingItem[] = [];
  const seen = new Set<string>();
  for (const t of tokens(prompt)) {
    if (seen.has(t)) continue;
    seen.add(t);
    if (facts.length >= Math.max(0, max - 1)) break;
    facts.push({ id: `wm-${ulid()}`, label: t, kind: "fact", activation: 0.8, at });
  }
  return [head, ...facts];
}

// -----------------------------------------------------------------------------
// Persisted slice. Goals + learning are NOT persisted here — they're derived
// live at snapshot() time from their own subsystems (single source of truth).
// -----------------------------------------------------------------------------

interface PersistedBrainState {
  workingMemory: WorkingItem[];
  attention: AttentionFocus[];
  confidence: number;
  lastCycle: BrainCycle | null;
  cycles: number;
  updatedAt: string;
}

function defaultState(): PersistedBrainState {
  return {
    workingMemory: [],
    attention: [],
    confidence: 0,
    lastCycle: null,
    cycles: 0,
    updatedAt: nowIso(),
  };
}

/** Feed-forward uncertainty: 0 until a real cycle has closed, else 1 - confidence. */
function uncertaintyOf(state: PersistedBrainState): number {
  return state.lastCycle ? clamp01(1 - state.confidence) : 0;
}

class CognitiveLoop {
  // Within-cycle guard so shouldReReason() flags at most once per cycle even if
  // recordReasoning is (defensively) called twice for one run. Keyed by
  // conversation so concurrent asks can't consume each other's flag.
  private flaggedLowConf = new Set<string>();
  private lastSnapshotAt = 0;
  // The key written most recently IN THIS PROCESS. `updated_at` ties at
  // millisecond resolution, so the DB ordering alone can't break same-ms
  // writes; this does. Falls back to the DB ordering on a fresh boot.
  private lastActiveKey: string | null = null;

  // `clock` is injectable so the selfcheck can drive the snapshot-emit throttle
  // deterministically; production uses the wall clock.
  constructor(
    private readonly bus: BrainBus,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  private read(key: string): PersistedBrainState {
    try {
      const row = openDb()
        .prepare<[string], { value: string }>(`SELECT value FROM organism_state WHERE key = ?`)
        .get(key);
      if (!row) return defaultState();
      const parsed = JSON.parse(row.value) as Partial<PersistedBrainState>;
      return { ...defaultState(), ...parsed };
    } catch (err) {
      surfaceError("brainState.read", err);
      return defaultState();
    }
  }

  /** The most recently updated state across the global + all conversation keys. */
  private readLatest(): PersistedBrainState {
    if (this.lastActiveKey) return this.read(this.lastActiveKey);
    try {
      const row = openDb()
        .prepare<[string, string], { value: string }>(
          `SELECT value FROM organism_state
           WHERE key = ? OR key LIKE ?
           ORDER BY updated_at DESC LIMIT 1`,
        )
        .get(STATE_KEY, `${STATE_KEY_PREFIX}%`);
      if (!row) return defaultState();
      const parsed = JSON.parse(row.value) as Partial<PersistedBrainState>;
      return { ...defaultState(), ...parsed };
    } catch (err) {
      surfaceError("brainState.readLatest", err);
      return defaultState();
    }
  }

  private write(key: string, state: PersistedBrainState): void {
    try {
      const value = JSON.stringify({ ...state, updatedAt: nowIso() });
      openDb()
        .prepare(
          `INSERT INTO organism_state (key, value, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(key, value, nowIso());
    } catch (err) {
      surfaceError("brainState.write", err);
    }
  }

  /** Mark a key as the brain's current focus (user-activity paths only — the
   *  decay heartbeat must not hijack "most recently active"). */
  private touch(key: string): void {
    this.lastActiveKey = key;
  }

  /** Loop entry — the brain perceives a new prompt: refresh the workspace. */
  perceive(prompt: string, conversationId?: string): void {
    const key = stateKeyFor(conversationId);
    this.flaggedLowConf.delete(key);
    this.touch(key);
    try {
      const state = this.read(key);
      const merged = capWorking([...extractWorkingItems(prompt), ...state.workingMemory]);
      this.write(key, { ...state, workingMemory: merged });
    } catch (err) {
      surfaceError("brainState.perceive", err);
    }
  }

  /** Record the attention map from the retrieval's saliency breakdowns. */
  attend(focuses: ReadonlyArray<AttentionFocus>, conversationId?: string): void {
    const key = stateKeyFor(conversationId);
    this.touch(key);
    try {
      const state = this.read(key);
      const top = [...focuses].sort((a, b) => b.score - a.score).slice(0, MAX_ATTENTION);
      this.write(key, { ...state, attention: top });
      this.emitSnapshot(conversationId);
    } catch (err) {
      surfaceError("brainState.attend", err);
    }
  }

  /**
   * Close the cycle. Persists confidence + cited count and, when confidence is
   * below the floor, pushes an "open-question" working item — DEFERRED
   * metacognition. The unresolved query then raises priorUncertainty() so the
   * NEXT cycle attends broader, instead of re-running steps in this SSE stream.
   */
  recordReasoning(
    input: { prompt: string; confidence: number; citedCount: number },
    conversationId?: string,
  ): {
    lowConfidence: boolean;
  } {
    const key = stateKeyFor(conversationId);
    this.touch(key);
    const lowConfidence = shouldReReason(input.confidence, this.flaggedLowConf.has(key));
    try {
      const state = this.read(key);
      let wm = state.workingMemory;
      if (lowConfidence) {
        this.flaggedLowConf.add(key);
        wm = capWorking([
          {
            id: `wm-${ulid()}`,
            label: input.prompt.trim().slice(0, 80) || "(open question)",
            kind: "open-question",
            activation: 1,
            at: nowIso(),
          },
          ...wm,
        ]);
      }
      const cycle: BrainCycle = {
        prompt: input.prompt.slice(0, 120),
        citedCount: Math.max(0, Math.floor(input.citedCount)),
        confidence: clamp01(input.confidence),
        lowConfidence,
        at: nowIso(),
      };
      this.write(key, {
        ...state,
        workingMemory: wm,
        confidence: clamp01(input.confidence),
        lastCycle: cycle,
        cycles: state.cycles + 1,
      });
      this.emitSnapshot(conversationId);
    } catch (err) {
      surfaceError("brainState.recordReasoning", err);
    }
    return { lowConfidence };
  }

  /**
   * 1 - last confidence — the feed-forward signal. Drives `shouldBroadenRetrieval`
   * (the BEHAVIORAL lever: a low-confidence prior cycle forces multi-query
   * expansion next cycle) and is also surfaced as saliency's uncertainty term
   * (a UI/score signal). Returns 0 (neutral) until a cycle has actually closed —
   * a cold brain must NOT assume maximal uncertainty on its first-ever query.
   */
  priorUncertainty(conversationId?: string): number {
    try {
      return uncertaintyOf(this.read(stateKeyFor(conversationId)));
    } catch (err) {
      surfaceError("brainState.priorUncertainty", err);
      return 0;
    }
  }

  /**
   * Autonomous-thought heartbeat: decay EVERY workspace (global + each
   * conversation), persist, broadcast — and prune conversation states idle
   * past the TTL so the KV table stays bounded.
   */
  tickDecay(dtMs: number): void {
    try {
      const db = openDb();
      const rows = db
        .prepare<[string, string], { key: string; updated_at: string }>(
          `SELECT key, updated_at FROM organism_state WHERE key = ? OR key LIKE ?`,
        )
        .all(STATE_KEY, `${STATE_KEY_PREFIX}%`);
      const now = this.clock();
      for (const row of rows) {
        if (
          row.key !== STATE_KEY &&
          now - Date.parse(row.updated_at) > CONVERSATION_STATE_TTL_MS
        ) {
          db.prepare(`DELETE FROM organism_state WHERE key = ?`).run(row.key);
          this.flaggedLowConf.delete(row.key);
          if (this.lastActiveKey === row.key) this.lastActiveKey = null;
          continue;
        }
        const state = this.read(row.key);
        if (state.workingMemory.length === 0) continue;
        const decayed = decayWorking(state.workingMemory, dtMs);
        this.write(row.key, { ...state, workingMemory: decayed });
      }
      this.emitSnapshot();
    } catch (err) {
      surfaceError("brainState.tickDecay", err);
    }
  }

  private learningMetrics(): BrainLearningMetrics {
    try {
      const s = loadRankerState();
      const trainedCount = s?.trainedCount ?? 0;
      const history = loadRankerLossHistory(1);
      const fb = getFeedbackStats();
      return {
        rankerWarm: trainedCount >= WARM_AT,
        rankerAlpha: Math.min(1, trainedCount / WARM_AT),
        trainedCount,
        lossLast: history.at(-1)?.loss ?? null,
        feedbackUp: fb.up,
        feedbackDown: fb.down,
      };
    } catch (err) {
      surfaceError("brainState.learningMetrics", err);
      return { rankerWarm: false, rankerAlpha: 0, trainedCount: 0, lossLast: null, feedbackUp: 0, feedbackDown: 0 };
    }
  }

  private goals(): GoalNode[] {
    try {
      // Reuse the organism's active-goal titles (the same seam saliency reads).
      // Priority decays with list position — the organism already returns them
      // in salience order.
      return getPersistentOrganism()
        .getActiveGoalTitles(8)
        .map((title, i) => ({ title, status: "active", priority: Math.max(0, 100 - i * 8) }));
    } catch (err) {
      surfaceError("brainState.goals", err);
      return [];
    }
  }

  /**
   * With a conversationId: that conversation's exact state. Without: the most
   * recently active state across all conversations (what the panel shows —
   * "what the brain is focused on right now").
   */
  snapshot(conversationId?: string): BrainStateSnapshot {
    const state = conversationId ? this.read(stateKeyFor(conversationId)) : this.readLatest();
    return {
      attention: state.attention,
      workingMemory: state.workingMemory,
      goals: this.goals(),
      confidence: state.confidence,
      priorUncertainty: uncertaintyOf(state),
      learning: this.learningMetrics(),
      lastCycle: state.lastCycle,
      cycles: state.cycles,
      updatedAt: state.updatedAt,
    };
  }

  private emitSnapshot(conversationId?: string): void {
    const now = this.clock();
    if (now - this.lastSnapshotAt < SNAPSHOT_THROTTLE_MS) return;
    this.lastSnapshotAt = now;
    try {
      this.bus.emit({ kind: "brain-state", snapshot: this.snapshot(conversationId), at: nowIso() });
    } catch (err) {
      surfaceError("brainState.emitSnapshot", err);
    }
  }
}

export type { CognitiveLoop };

let singleton: CognitiveLoop | null = null;

export function createBrainState(bus: BrainBus = getEventBus()): CognitiveLoop {
  if (!singleton) {
    singleton = new CognitiveLoop(bus);
  }
  return singleton;
}

export function getBrainState(): CognitiveLoop {
  return createBrainState(getEventBus());
}

/** Test-only: drop the singleton so a selfcheck can rehydrate from a fresh DB. */
export function __resetBrainStateForTests(): void {
  singleton = null;
}

/**
 * Test-only: a fresh (non-singleton) loop with an injectable clock, so the
 * selfcheck can drive the snapshot-emit throttle deterministically. Shares the
 * same DB as the singleton — clear `organism_state` first for a clean slate.
 */
export function __createBrainStateForTests(bus: BrainBus, clock?: () => number): CognitiveLoop {
  return clock ? new CognitiveLoop(bus, clock) : new CognitiveLoop(bus);
}
