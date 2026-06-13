// Belief engine — observations become BELIEFS that evolve with evidence.
//
// The brain already distills episodes into semantic facts (memory/sleepCycle),
// tags contradictions at storage time (memory/noveltyDetector), measures
// surprise (reasoning/predictiveProcessing), and takes explicit 👍/👎
// (routes/feedback). What none of that produced is a STANCE: "I hold X to be
// true with confidence C, supported by these memories, contradicted by those."
// This module is that layer:
//
//   formBeliefFromFact()    — sleep-distilled facts become beliefs (dedup by
//                             normalized statement hash; repeats accrue
//                             evidence instead of duplicating).
//   recordContradiction()   — a storage-time contradiction against a memory
//                             that supports a belief lowers its confidence and
//                             marks it `contested`.
//   noteSurprise()          — prediction error softly erodes lexically-related
//                             beliefs (the world didn't match expectations).
//   onAnswerFeedback()      — a 👎 on an answer nudges down beliefs whose
//                             supporting memories were cited; a 👍 nudges up.
//   decayTick()             — stale beliefs drift toward 0.5 (uncertainty) and
//                             eventually retire. Beliefs EVOLVE, never delete.
//
// Beliefs feed BACK into cognition through the global workspace: contested /
// low-confidence beliefs bid for the micro-thought slot (core/workspace.ts),
// so the brain literally re-examines its own beliefs in idle moments. They are
// deliberately NOT injected into the /api/ask prompts (repo rule: no new
// pipeline call sites) — that remains a documented follow-up via the existing
// attend seam.
//
// Persistence: the `beliefs` table (migration 0010). Every method is
// failure-isolated (try/catch + surfaceError) — a belief fault must never
// break sleep, novelty tagging, feedback, or /api/ask. Confidence math is
// exported pure for the hermetic selfcheck.

import { createHash } from "node:crypto";
import { openDb } from "../db/sqlite.js";
import { surfaceError } from "../util/diagnostics.js";
import { tokens } from "../attention/saliency.js";
import { getEventBus, nowIso, type BrainBus } from "./eventBus.js";
import { clampMagnitude, regionsFor } from "../../../shared/cognition.js";

export type BeliefStatus = "active" | "contested" | "weakening" | "retired";

export interface BeliefRecord {
  id: string;
  statement: string;
  confidence: number;
  domain: string | null;
  status: BeliefStatus;
  supportingIds: string[];
  contradictingIds: string[];
  evidenceCount: number;
  formedAt: string;
  lastUpdated: string;
}

export interface BeliefStats {
  total: number;
  active: number;
  contested: number;
  weakening: number;
  retired: number;
  avgConfidence: number;
}

// Confidence dynamics. Asymmetric on purpose: one contradiction hurts more
// than one supporting observation helps (beliefs should be hard to keep, easy
// to question — the opposite ratchet of confirmation bias).
export const INITIAL_CONFIDENCE = 0.6;
export const SUPPORT_GAIN = 0.12;
export const CONTRADICT_HIT = 0.28;
export const SURPRISE_EROSION = 0.06;
export const FEEDBACK_NUDGE = 0.05;
export const CONFIDENCE_FLOOR = 0.02;
export const CONFIDENCE_CEIL = 0.98;
// Status thresholds.
export const WEAKENING_BELOW = 0.45;
export const RETIRE_BELOW = 0.2;
// Decay: with no fresh evidence, confidence drifts toward 0.5 with this
// half-life (an unexercised conviction relaxes back to "unsure").
export const DECAY_HALF_LIFE_DAYS = 45;
// Bounded evidence lists — provenance, not an audit log.
export const MAX_EVIDENCE_IDS = 24;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// -----------------------------------------------------------------------------
// PURE math + normalization (selfcheck-exercisable).
// -----------------------------------------------------------------------------

/** Lowercase, collapse whitespace, strip trailing punctuation — dedup key. */
export function normalizeStatement(statement: string): string {
  return statement.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?\s]+$/u, "");
}

export function statementHash(statement: string): string {
  return createHash("sha1").update(normalizeStatement(statement)).digest("hex");
}

/**
 * One evidence update. Support moves confidence toward the ceiling
 * proportionally to remaining headroom; contradiction removes a (larger)
 * fraction of current confidence. Bounded in [CONFIDENCE_FLOOR, CONFIDENCE_CEIL].
 */
export function updateConfidence(
  prev: number,
  polarity: "support" | "contradict",
  weight = 1,
): number {
  const p = clamp01(prev);
  const w = clamp01(weight);
  const next =
    polarity === "support" ? p + SUPPORT_GAIN * w * (1 - p) : p - CONTRADICT_HIT * w * p;
  return Math.min(CONFIDENCE_CEIL, Math.max(CONFIDENCE_FLOOR, next));
}

/** Stale-belief drift toward 0.5 (uncertainty) by elapsed days. Pure. */
export function decayConfidence(prev: number, elapsedDays: number): number {
  if (!Number.isFinite(elapsedDays) || elapsedDays <= 0) return clamp01(prev);
  const keep = Math.pow(0.5, elapsedDays / DECAY_HALF_LIFE_DAYS);
  return clamp01(0.5 + (clamp01(prev) - 0.5) * keep);
}

/** Status from confidence — `contested` is sticky until support recovers it. */
export function statusFor(confidence: number, currentStatus: BeliefStatus): BeliefStatus {
  if (confidence < RETIRE_BELOW) return "retired";
  if (currentStatus === "retired") {
    // Revival: fresh evidence can pull a retired belief back.
    return confidence < WEAKENING_BELOW ? "weakening" : "active";
  }
  if (confidence < WEAKENING_BELOW) return "weakening";
  if (currentStatus === "contested") {
    // Contested clears only once confidence has genuinely recovered.
    return confidence >= INITIAL_CONFIDENCE ? "active" : "contested";
  }
  return "active";
}

/** Token-overlap relevance of a query against a belief statement. Pure. */
export function lexicalMatch(queryTokens: ReadonlySet<string>, statement: string): number {
  if (queryTokens.size === 0) return 0;
  const st = new Set(tokens(statement));
  if (st.size === 0) return 0;
  let inter = 0;
  for (const t of st) if (queryTokens.has(t)) inter += 1;
  return inter / Math.min(queryTokens.size, st.size);
}

// -----------------------------------------------------------------------------
// Engine.
// -----------------------------------------------------------------------------

interface BeliefRow {
  id: string;
  statement: string;
  statement_hash: string;
  confidence: number;
  domain: string | null;
  status: string;
  supporting_ids: string;
  contradicting_ids: string;
  evidence_count: number;
  formed_at: string;
  last_updated: string;
}

function parseIds(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function rowToRecord(row: BeliefRow): BeliefRecord {
  return {
    id: row.id,
    statement: row.statement,
    confidence: row.confidence,
    domain: row.domain,
    status: (["active", "contested", "weakening", "retired"] as const).includes(
      row.status as BeliefStatus,
    )
      ? (row.status as BeliefStatus)
      : "active",
    supportingIds: parseIds(row.supporting_ids),
    contradictingIds: parseIds(row.contradicting_ids),
    evidenceCount: row.evidence_count,
    formedAt: row.formed_at,
    lastUpdated: row.last_updated,
  };
}

export class BeliefEngine {
  constructor(
    private readonly bus: BrainBus = getEventBus(),
    private readonly clock: () => string = nowIso,
  ) {}

  private emitCognition(
    kind: "belief-formed" | "belief-update",
    label: string,
    magnitude: number,
    reason: string,
    detail?: string,
  ): void {
    try {
      this.bus.emit({
        kind: "cognition",
        event: {
          kind,
          label: label.slice(0, 160),
          detail: detail?.slice(0, 240),
          magnitude: clampMagnitude(magnitude),
          logicalRegions: regionsFor(kind),
          reason,
          at: this.clock(),
        },
        at: this.clock(),
      });
    } catch (err) {
      surfaceError("beliefs.emit", err);
    }
  }

  private writeBack(belief: BeliefRecord): void {
    openDb()
      .prepare(
        `UPDATE beliefs SET confidence = ?, status = ?, supporting_ids = ?,
           contradicting_ids = ?, evidence_count = ?, last_updated = ?
         WHERE id = ?`,
      )
      .run(
        belief.confidence,
        belief.status,
        JSON.stringify(belief.supportingIds.slice(-MAX_EVIDENCE_IDS)),
        JSON.stringify(belief.contradictingIds.slice(-MAX_EVIDENCE_IDS)),
        belief.evidenceCount,
        belief.lastUpdated,
        belief.id,
      );
  }

  private byHash(hash: string): BeliefRecord | null {
    const row = openDb()
      .prepare("SELECT * FROM beliefs WHERE statement_hash = ?")
      .get(hash) as BeliefRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  byId(id: string): BeliefRecord | null {
    try {
      const row = openDb().prepare("SELECT * FROM beliefs WHERE id = ?").get(id) as
        | BeliefRow
        | undefined;
      return row ? rowToRecord(row) : null;
    } catch (err) {
      surfaceError("beliefs.byId", err);
      return null;
    }
  }

  /**
   * A distilled fact (or any observation worth holding) becomes a belief.
   * Duplicate statements accrue evidence instead of duplicating rows.
   */
  formBeliefFromFact(
    statement: string,
    supportingMemoryIds: ReadonlyArray<string>,
    domain?: string | null,
  ): BeliefRecord | null {
    try {
      const trimmed = statement.trim();
      if (trimmed.length < 8) return null;
      const hash = statementHash(trimmed);
      const existing = this.byHash(hash);
      const now = this.clock();
      if (existing) {
        let conf = existing.confidence;
        const supporting = [...existing.supportingIds];
        let fresh = 0;
        for (const id of supportingMemoryIds) {
          if (!supporting.includes(id)) {
            supporting.push(id);
            conf = updateConfidence(conf, "support");
            fresh += 1;
          }
        }
        // Re-distilling the same fact IS evidence even when the episode ids
        // overlap — one gentle reinforcement so repetition still counts.
        if (fresh === 0) conf = updateConfidence(conf, "support", 0.5);
        const updated: BeliefRecord = {
          ...existing,
          confidence: conf,
          status: statusFor(conf, existing.status),
          supportingIds: supporting,
          evidenceCount: existing.evidenceCount + Math.max(1, fresh),
          lastUpdated: now,
        };
        this.writeBack(updated);
        this.emitCognition(
          "belief-update",
          `Belief reinforced: ${updated.statement}`,
          conf,
          "belief-engine:reinforce",
          `confidence ${existing.confidence.toFixed(2)} → ${conf.toFixed(2)}`,
        );
        return updated;
      }
      const belief: BeliefRecord = {
        id: `belief-${hash.slice(0, 12)}`,
        statement: trimmed,
        confidence: INITIAL_CONFIDENCE,
        domain: domain ?? null,
        status: "active",
        supportingIds: [...new Set(supportingMemoryIds)],
        contradictingIds: [],
        evidenceCount: Math.max(1, supportingMemoryIds.length),
        formedAt: now,
        lastUpdated: now,
      };
      openDb()
        .prepare(
          `INSERT INTO beliefs (id, statement, statement_hash, confidence, domain, status,
             supporting_ids, contradicting_ids, evidence_count, formed_at, last_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          belief.id,
          belief.statement,
          hash,
          belief.confidence,
          belief.domain,
          belief.status,
          JSON.stringify(belief.supportingIds.slice(-MAX_EVIDENCE_IDS)),
          "[]",
          belief.evidenceCount,
          belief.formedAt,
          belief.lastUpdated,
        );
      this.emitCognition(
        "belief-formed",
        `New belief: ${belief.statement}`,
        belief.confidence,
        "belief-engine:form",
      );
      return belief;
    } catch (err) {
      surfaceError("beliefs.form", err);
      return null;
    }
  }

  /** Attach one piece of evidence to a known belief. */
  addEvidence(beliefId: string, memoryId: string, polarity: "support" | "contradict"): void {
    try {
      const belief = this.byId(beliefId);
      if (!belief) return;
      const list = polarity === "support" ? belief.supportingIds : belief.contradictingIds;
      if (!list.includes(memoryId)) list.push(memoryId);
      const conf = updateConfidence(belief.confidence, polarity);
      const status =
        polarity === "contradict" && conf >= RETIRE_BELOW
          ? "contested"
          : statusFor(conf, belief.status);
      this.writeBack({
        ...belief,
        confidence: conf,
        status,
        evidenceCount: belief.evidenceCount + 1,
        lastUpdated: this.clock(),
      });
      this.emitCognition(
        "belief-update",
        `Belief ${polarity === "support" ? "supported" : "challenged"}: ${belief.statement}`,
        polarity === "contradict" ? 1 - conf : conf,
        `belief-engine:${polarity}`,
      );
    } catch (err) {
      surfaceError("beliefs.addEvidence", err);
    }
  }

  /**
   * Storage-time contradiction seam (memory/noveltyDetector.tagContradiction):
   * a new memory contradicts an old one — every belief leaning on EITHER
   * memory takes a confidence hit and turns `contested`. Returns the number
   * of beliefs affected.
   */
  recordContradiction(memoryId: string, contradictsMemoryId: string): number {
    try {
      const rows = openDb()
        .prepare(
          `SELECT * FROM beliefs
           WHERE status != 'retired'
             AND (supporting_ids LIKE ? OR supporting_ids LIKE ?)`,
        )
        .all(`%"${memoryId}"%`, `%"${contradictsMemoryId}"%`) as BeliefRow[];
      let affected = 0;
      for (const row of rows) {
        const belief = rowToRecord(row);
        const conf = updateConfidence(belief.confidence, "contradict");
        const contradicting = [...belief.contradictingIds];
        if (!contradicting.includes(memoryId)) contradicting.push(memoryId);
        this.writeBack({
          ...belief,
          confidence: conf,
          status: conf < RETIRE_BELOW ? "retired" : "contested",
          contradictingIds: contradicting,
          evidenceCount: belief.evidenceCount + 1,
          lastUpdated: this.clock(),
        });
        this.emitCognition(
          "belief-update",
          `Belief contested: ${belief.statement}`,
          1 - conf,
          "belief-engine:contradiction",
          `confidence ${belief.confidence.toFixed(2)} → ${conf.toFixed(2)}`,
        );
        affected += 1;
      }
      return affected;
    } catch (err) {
      surfaceError("beliefs.recordContradiction", err);
      return 0;
    }
  }

  /**
   * Predictive-processing seam: reality diverged from expectation around this
   * query — softly erode the (few) most lexically-related beliefs. Returns the
   * number eroded. Quiet: no cognition event per call (surprise is frequent).
   */
  noteSurprise(query: string, surprise: number): number {
    try {
      const s = clamp01(surprise);
      if (s <= 0) return 0;
      const qt = new Set(tokens(query));
      if (qt.size === 0) return 0;
      const rows = openDb()
        .prepare(`SELECT * FROM beliefs WHERE status != 'retired' ORDER BY last_updated DESC LIMIT 200`)
        .all() as BeliefRow[];
      const scored = rows
        .map((row) => ({ row, match: lexicalMatch(qt, row.statement) }))
        .filter((x) => x.match >= 0.34)
        .sort((a, b) => b.match - a.match)
        .slice(0, 3);
      for (const { row, match } of scored) {
        const belief = rowToRecord(row);
        const conf = Math.min(
          CONFIDENCE_CEIL,
          Math.max(CONFIDENCE_FLOOR, belief.confidence - SURPRISE_EROSION * s * match),
        );
        this.writeBack({
          ...belief,
          confidence: conf,
          status: statusFor(conf, belief.status),
          lastUpdated: this.clock(),
        });
      }
      return scored.length;
    } catch (err) {
      surfaceError("beliefs.noteSurprise", err);
      return 0;
    }
  }

  /**
   * Explicit-feedback seam (routes/feedback.ts): the user judged an answer
   * whose citations included these memories. Nudge beliefs that lean on them.
   */
  onAnswerFeedback(citedMemoryIds: Iterable<string>, rating: 1 | -1): number {
    try {
      const ids = [...citedMemoryIds];
      if (ids.length === 0) return 0;
      const seen = new Set<string>();
      let affected = 0;
      for (const memId of ids.slice(0, 12)) {
        const rows = openDb()
          .prepare(`SELECT * FROM beliefs WHERE status != 'retired' AND supporting_ids LIKE ?`)
          .all(`%"${memId}"%`) as BeliefRow[];
        for (const row of rows) {
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          const belief = rowToRecord(row);
          const delta = rating > 0 ? FEEDBACK_NUDGE : -FEEDBACK_NUDGE;
          const conf = Math.min(
            CONFIDENCE_CEIL,
            Math.max(CONFIDENCE_FLOOR, belief.confidence + delta),
          );
          this.writeBack({
            ...belief,
            confidence: conf,
            status: statusFor(conf, belief.status),
            lastUpdated: this.clock(),
          });
          affected += 1;
        }
      }
      return affected;
    } catch (err) {
      surfaceError("beliefs.onAnswerFeedback", err);
      return 0;
    }
  }

  /**
   * Sleep-cadence decay: confidence drifts toward 0.5 with no fresh evidence;
   * deep-eroded beliefs retire (status only — rows are never deleted).
   */
  decayTick(now: Date = new Date()): { decayed: number; retired: number } {
    try {
      const rows = openDb()
        .prepare(`SELECT * FROM beliefs WHERE status != 'retired'`)
        .all() as BeliefRow[];
      let decayed = 0;
      let retired = 0;
      for (const row of rows) {
        const belief = rowToRecord(row);
        const last = Date.parse(belief.lastUpdated);
        const elapsedDays = Number.isFinite(last)
          ? Math.max(0, (now.getTime() - last) / 86_400_000)
          : 0;
        if (elapsedDays < 1) continue;
        const conf = decayConfidence(belief.confidence, elapsedDays);
        if (Math.abs(conf - belief.confidence) < 1e-6) continue;
        const status = statusFor(conf, belief.status);
        this.writeBack({ ...belief, confidence: conf, status, lastUpdated: now.toISOString() });
        decayed += 1;
        if (status === "retired") retired += 1;
      }
      return { decayed, retired };
    } catch (err) {
      surfaceError("beliefs.decayTick", err);
      return { decayed: 0, retired: 0 };
    }
  }

  listBeliefs(filter: { status?: BeliefStatus; limit?: number } = {}): BeliefRecord[] {
    try {
      const limit = Math.min(200, Math.max(1, filter.limit ?? 50));
      const rows = filter.status
        ? (openDb()
            .prepare(`SELECT * FROM beliefs WHERE status = ? ORDER BY last_updated DESC LIMIT ?`)
            .all(filter.status, limit) as BeliefRow[])
        : (openDb()
            .prepare(`SELECT * FROM beliefs ORDER BY last_updated DESC LIMIT ?`)
            .all(limit) as BeliefRow[]);
      return rows.map(rowToRecord);
    } catch (err) {
      surfaceError("beliefs.list", err);
      return [];
    }
  }

  beliefStats(): BeliefStats {
    try {
      const rows = openDb()
        .prepare(
          `SELECT status, COUNT(*) AS n, AVG(confidence) AS avg_conf FROM beliefs GROUP BY status`,
        )
        .all() as Array<{ status: string; n: number; avg_conf: number }>;
      const stats: BeliefStats = {
        total: 0,
        active: 0,
        contested: 0,
        weakening: 0,
        retired: 0,
        avgConfidence: 0,
      };
      let confSum = 0;
      for (const r of rows) {
        stats.total += r.n;
        confSum += r.avg_conf * r.n;
        if (r.status === "active") stats.active = r.n;
        else if (r.status === "contested") stats.contested = r.n;
        else if (r.status === "weakening") stats.weakening = r.n;
        else if (r.status === "retired") stats.retired = r.n;
      }
      stats.avgConfidence = stats.total > 0 ? confSum / stats.total : 0;
      return stats;
    } catch (err) {
      surfaceError("beliefs.stats", err);
      return { total: 0, active: 0, contested: 0, weakening: 0, retired: 0, avgConfidence: 0 };
    }
  }

  /**
   * Workspace seam: beliefs most worth re-examining — contested first, then
   * low-confidence non-retired, freshest first.
   */
  reExaminationCandidates(limit = 2): BeliefRecord[] {
    try {
      const rows = openDb()
        .prepare(
          `SELECT * FROM beliefs
           WHERE status IN ('contested', 'weakening')
           ORDER BY CASE status WHEN 'contested' THEN 0 ELSE 1 END, last_updated DESC
           LIMIT ?`,
        )
        .all(Math.min(8, Math.max(1, limit))) as BeliefRow[];
      return rows.map(rowToRecord);
    } catch (err) {
      surfaceError("beliefs.reExamination", err);
      return [];
    }
  }

  /** Beliefs lexically relevant to a token set, best matches first. */
  topBeliefsFor(queryTokens: ReadonlySet<string>, limit = 3): BeliefRecord[] {
    try {
      const rows = openDb()
        .prepare(`SELECT * FROM beliefs WHERE status != 'retired' ORDER BY confidence DESC LIMIT 200`)
        .all() as BeliefRow[];
      return rows
        .map((row) => ({ row, match: lexicalMatch(queryTokens, row.statement) }))
        .filter((x) => x.match > 0)
        .sort((a, b) => b.match - a.match || b.row.confidence - a.row.confidence)
        .slice(0, Math.max(1, limit))
        .map((x) => rowToRecord(x.row));
    } catch (err) {
      surfaceError("beliefs.topFor", err);
      return [];
    }
  }
}

let singleton: BeliefEngine | null = null;

export function getBeliefEngine(): BeliefEngine {
  if (!singleton) singleton = new BeliefEngine();
  return singleton;
}

/** Selfcheck hooks — fresh instances on a private bus / injected clock. */
export function __resetBeliefEngineForTests(): void {
  singleton = null;
}
export function __createBeliefEngineForTests(bus: BrainBus, clock?: () => string): BeliefEngine {
  return new BeliefEngine(bus, clock);
}
