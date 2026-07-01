// Scientific reasoning — the hypothesis lifecycle.
//
// The master vision asks for observation → hypothesis → experiment → evaluation
// → learning. The brain already has the PIECES: the causal world model
// (core/causalMap.ts) accumulates P(effect|cause); the belief engine
// (core/beliefs.ts) holds stances. What was missing is the explicit lifecycle
// that turns an uncertain causal pattern into a HYPOTHESIS, tests it cheaply
// against the ledger, and PROMOTES the supported ones into beliefs.
//
//   formHypothesisFromObservation() — dedup by statement hash; status "open".
//   assess()                        — a CHEAP test: NO new LLM call. Reads the
//                                     causal ledger (predictEffects) or the
//                                     belief engine. Returns support true/false/
//                                     null (inconclusive).
//   test()                          — assess → evaluate (Laplace counters) →
//                                     persist → promote a supported hypothesis
//                                     into a belief → emit a reflection.
//   sleepTick()                     — the loop: retire stale, form hypotheses
//                                     from the most-uncertain causal links, test
//                                     the open ones. Runs during runSleepCycle.
//
// Discipline (the beliefs.ts contract): confidence math is pure + exported;
// every DB touch is failure-isolated; the test is ledger-read-only (no hot-path
// LLM); gated by CONFIG.hypotheses (default OFF). Different table from beliefs,
// so the beliefs selfcheck is unperturbed.

import { ulid } from "ulid";
import { openDb } from "../db/sqlite.js";
import { surfaceError } from "../util/diagnostics.js";
import { tokens } from "../attention/saliency.js";
import { getEventBus, nowIso, type BrainBus } from "./eventBus.js";
import { clampMagnitude, regionsFor } from "../../../shared/cognition.js";
import { statementHash, getBeliefEngine } from "./beliefs.js";
import { predictEffects, getAllCausalLinks, MIN_USABLE_CONFIDENCE } from "./causalMap.js";
import type { Hypothesis, HypothesisStatus, HypothesisStats } from "../../../shared/hypotheses.js";

// Thresholds (exported so the selfcheck pins them).
export const SUPPORTED_AT = 0.7;
export const REFUTED_AT = 0.3;
export const MIN_TEST_OBS = 2; // need at least this many tests to conclude
export const RETIRE_AFTER_DAYS = 30; // an untested/inconclusive hypothesis goes stale
export const SLEEP_FORM_LIMIT = 3; // hypotheses formed per sleep
export const SLEEP_TEST_LIMIT = 8; // hypotheses tested per sleep

// -----------------------------------------------------------------------------
// PURE math — the selfcheck drives these directly (no DB).
// -----------------------------------------------------------------------------

/** Laplace-smoothed P(true) from the support/refute counters. Pure. */
export function evaluateConfidence(supportObs: number, refuteObs: number): number {
  const s = Math.max(0, Math.floor(supportObs));
  const r = Math.max(0, Math.floor(refuteObs));
  return (s + 1) / (s + r + 2);
}

/** Status from the counters. `open` before any test, `supported`/`refuted` once
 *  enough evidence accrues and confidence crosses a threshold. Pure. */
export function statusFor(supportObs: number, refuteObs: number, current: HypothesisStatus): HypothesisStatus {
  if (current === "retired") return "retired";
  const total = Math.max(0, supportObs) + Math.max(0, refuteObs);
  if (total === 0) return "open";
  const conf = evaluateConfidence(supportObs, refuteObs);
  if (total >= MIN_TEST_OBS && conf >= SUPPORTED_AT) return "supported";
  if (total >= MIN_TEST_OBS && conf <= REFUTED_AT) return "refuted";
  return "testing";
}

// -----------------------------------------------------------------------------
// Engine.
// -----------------------------------------------------------------------------

interface HypothesisRow {
  id: string;
  statement: string;
  statement_hash: string;
  status: string;
  support_obs: number;
  refute_obs: number;
  confidence: number;
  source_belief_id: string | null;
  cause_class: string | null;
  effect_class: string | null;
  created_at: string;
  updated_at: string;
}

const STATUSES: ReadonlyArray<HypothesisStatus> = ["open", "testing", "supported", "refuted", "retired"];

function rowToHypothesis(row: HypothesisRow): Hypothesis {
  return {
    id: row.id,
    statement: row.statement,
    status: (STATUSES as readonly string[]).includes(row.status) ? (row.status as HypothesisStatus) : "open",
    supportObs: row.support_obs,
    refuteObs: row.refute_obs,
    confidence: row.confidence,
    sourceBeliefId: row.source_belief_id,
    causeClass: row.cause_class,
    effectClass: row.effect_class,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface FormOptions {
  sourceBeliefId?: string | null;
  causeClass?: string | null;
  effectClass?: string | null;
}

export interface SleepTickReport {
  formed: number;
  tested: number;
  supported: number;
  refuted: number;
  retired: number;
}

export class HypothesisEngine {
  constructor(
    private readonly bus: BrainBus = getEventBus(),
    private readonly clock: () => string = nowIso,
  ) {}

  private emit(kind: "reflection", label: string, magnitude: number, reason: string, detail?: string): void {
    try {
      const at = this.clock();
      this.bus.emit({
        kind: "cognition",
        event: {
          kind,
          label: label.slice(0, 160),
          detail: detail?.slice(0, 240),
          magnitude: clampMagnitude(magnitude),
          logicalRegions: regionsFor(kind),
          reason,
          at,
        },
        at,
      });
    } catch (err) {
      surfaceError("hypotheses.emit", err);
    }
  }

  byId(id: string): Hypothesis | null {
    try {
      const row = openDb().prepare("SELECT * FROM hypotheses WHERE id = ?").get(id) as HypothesisRow | undefined;
      return row ? rowToHypothesis(row) : null;
    } catch (err) {
      surfaceError("hypotheses.byId", err);
      return null;
    }
  }

  private byHash(hash: string): Hypothesis | null {
    const row = openDb().prepare("SELECT * FROM hypotheses WHERE statement_hash = ?").get(hash) as
      | HypothesisRow
      | undefined;
    return row ? rowToHypothesis(row) : null;
  }

  /** Form a hypothesis (dedup by statement hash). Returns it (existing or new). */
  formHypothesisFromObservation(statement: string, opts: FormOptions = {}): Hypothesis | null {
    try {
      const trimmed = statement.trim();
      if (trimmed.length < 8) return null;
      const hash = statementHash(trimmed);
      const existing = this.byHash(hash);
      if (existing) return existing;
      const now = this.clock();
      const h: Hypothesis = {
        id: `hyp-${ulid()}`,
        statement: trimmed,
        status: "open",
        supportObs: 0,
        refuteObs: 0,
        confidence: evaluateConfidence(0, 0),
        sourceBeliefId: opts.sourceBeliefId ?? null,
        causeClass: opts.causeClass ?? null,
        effectClass: opts.effectClass ?? null,
        createdAt: now,
        updatedAt: now,
      };
      openDb()
        .prepare(
          `INSERT INTO hypotheses (id, statement, statement_hash, status, support_obs, refute_obs,
             confidence, source_belief_id, cause_class, effect_class, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(h.id, h.statement, hash, h.status, 0, 0, h.confidence, h.sourceBeliefId, h.causeClass, h.effectClass, now, now);
      this.emit("reflection", `New hypothesis: ${h.statement}`, 0.4, "hypothesis:form");
      return h;
    } catch (err) {
      surfaceError("hypotheses.form", err);
      return null;
    }
  }

  /** A CHEAP test — ledger reads only, NO LLM. Returns support true/false/null. */
  private assess(h: Hypothesis): { support: boolean | null; basis: string } {
    // Causal hypothesis: read the empirical P(effect|cause).
    if (h.causeClass && h.effectClass) {
      const forecast = predictEffects(h.causeClass);
      const link = forecast.effects.find((e) => e.effectClass === h.effectClass);
      if (link && link.confidence >= MIN_USABLE_CONFIDENCE) {
        return { support: link.strength >= 0.5, basis: `P(${h.effectClass}|${h.causeClass})=${link.strength.toFixed(2)}` };
      }
      return { support: null, basis: "insufficient causal evidence" };
    }
    // Belief-derived hypothesis: read the source belief.
    if (h.sourceBeliefId) {
      const b = getBeliefEngine().byId(h.sourceBeliefId);
      if (b && b.status !== "retired") {
        if (b.status === "active" && b.confidence >= 0.6) return { support: true, basis: `belief confidence ${b.confidence.toFixed(2)}` };
        if (b.status === "contested" || b.confidence < 0.4) return { support: false, basis: `belief ${b.status} (${b.confidence.toFixed(2)})` };
      }
      return { support: null, basis: "belief inconclusive" };
    }
    // Lexical fallback: is there a high-confidence belief that matches the statement?
    const top = getBeliefEngine().topBeliefsFor(new Set(tokens(h.statement)), 1)[0];
    if (top) {
      if (top.confidence >= 0.6) return { support: true, basis: `related belief (${top.confidence.toFixed(2)})` };
      if (top.confidence < 0.4) return { support: false, basis: `related belief weak (${top.confidence.toFixed(2)})` };
    }
    return { support: null, basis: "no cheap evidence" };
  }

  /** Run one cheap test on a hypothesis, persist the outcome, promote if supported. */
  test(id: string): { hypothesis: Hypothesis | null; support: boolean | null; basis: string } {
    try {
      const h = this.byId(id);
      if (!h || h.status === "retired" || h.status === "supported") {
        return { hypothesis: h, support: null, basis: "not testable" };
      }
      const { support, basis } = this.assess(h);
      let supportObs = h.supportObs;
      let refuteObs = h.refuteObs;
      if (support === true) supportObs += 1;
      else if (support === false) refuteObs += 1;
      const confidence = evaluateConfidence(supportObs, refuteObs);
      const status = statusFor(supportObs, refuteObs, h.status);
      const now = this.clock();
      openDb()
        .prepare(
          `UPDATE hypotheses SET support_obs = ?, refute_obs = ?, confidence = ?, status = ?, updated_at = ? WHERE id = ?`,
        )
        .run(supportObs, refuteObs, confidence, status, now, id);
      const updated: Hypothesis = { ...h, supportObs, refuteObs, confidence, status, updatedAt: now };
      if (status === "supported") {
        // PROMOTE into a belief — the supported hypothesis becomes a stance.
        // (The early-return guard above already excludes an already-supported h.)
        try {
          getBeliefEngine().formBeliefFromFact(h.statement, []);
        } catch (err) {
          surfaceError("hypotheses.promote", err);
        }
        this.emit("reflection", `Hypothesis supported → belief: ${h.statement}`, 0.7, "hypothesis:supported", basis);
      } else if (status === "refuted" && h.status !== "refuted") {
        this.emit("reflection", `Hypothesis refuted: ${h.statement}`, 0.6, "hypothesis:refuted", basis);
      }
      return { hypothesis: updated, support, basis };
    } catch (err) {
      surfaceError("hypotheses.test", err);
      return { hypothesis: null, support: null, basis: "test failed" };
    }
  }

  /** Stale-hypothesis retirement (status only; rows are never deleted). */
  decayTick(now: Date = new Date()): { retired: number } {
    try {
      const rows = openDb()
        .prepare(`SELECT * FROM hypotheses WHERE status IN ('open', 'testing')`)
        .all() as HypothesisRow[];
      let retired = 0;
      for (const row of rows) {
        const last = Date.parse(row.updated_at);
        const elapsedDays = Number.isFinite(last) ? (now.getTime() - last) / 86_400_000 : 0;
        if (elapsedDays > RETIRE_AFTER_DAYS) {
          openDb().prepare(`UPDATE hypotheses SET status = 'retired', updated_at = ? WHERE id = ?`).run(now.toISOString(), row.id);
          retired += 1;
        }
      }
      return { retired };
    } catch (err) {
      surfaceError("hypotheses.decay", err);
      return { retired: 0 };
    }
  }

  /**
   * The sleep-cadence loop: retire stale hypotheses, form new ones from the
   * most-uncertain causal links (the curiosity frontier), then test the open
   * ones against the (freshly updated) ledger. Failure-isolated throughout.
   */
  sleepTick(now: Date = new Date()): SleepTickReport {
    const report: SleepTickReport = { formed: 0, tested: 0, supported: 0, refuted: 0, retired: 0 };
    report.retired = this.decayTick(now).retired;
    // Form from the least-confident causal links that have at least one observation.
    try {
      const frontier = getAllCausalLinks()
        .filter((l) => l.observations >= 1 && l.confidence < 0.9)
        .slice(0, SLEEP_FORM_LIMIT);
      for (const link of frontier) {
        const statement = `Performing "${link.causeClass}" tends to cause "${link.effectClass}".`;
        const formed = this.formHypothesisFromObservation(statement, {
          causeClass: link.causeClass,
          effectClass: link.effectClass,
        });
        if (formed && formed.createdAt === formed.updatedAt) report.formed += 1;
      }
    } catch (err) {
      surfaceError("hypotheses.sleepForm", err);
    }
    // Test the open / testing hypotheses.
    try {
      const open = openDb()
        .prepare(`SELECT id FROM hypotheses WHERE status IN ('open', 'testing') ORDER BY updated_at ASC LIMIT ?`)
        .all(SLEEP_TEST_LIMIT) as Array<{ id: string }>;
      for (const { id } of open) {
        const r = this.test(id);
        report.tested += 1;
        if (r.hypothesis?.status === "supported") report.supported += 1;
        else if (r.hypothesis?.status === "refuted") report.refuted += 1;
      }
    } catch (err) {
      surfaceError("hypotheses.sleepTest", err);
    }
    return report;
  }

  listHypotheses(filter: { status?: HypothesisStatus; limit?: number } = {}): Hypothesis[] {
    try {
      const limit = Math.min(200, Math.max(1, filter.limit ?? 50));
      const rows = filter.status
        ? (openDb().prepare(`SELECT * FROM hypotheses WHERE status = ? ORDER BY updated_at DESC LIMIT ?`).all(filter.status, limit) as HypothesisRow[])
        : (openDb().prepare(`SELECT * FROM hypotheses ORDER BY updated_at DESC LIMIT ?`).all(limit) as HypothesisRow[]);
      return rows.map(rowToHypothesis);
    } catch (err) {
      surfaceError("hypotheses.list", err);
      return [];
    }
  }

  hypothesisStats(): HypothesisStats {
    try {
      const rows = openDb()
        .prepare(`SELECT status, COUNT(*) AS n, AVG(confidence) AS avg_conf FROM hypotheses GROUP BY status`)
        .all() as Array<{ status: string; n: number; avg_conf: number }>;
      const stats: HypothesisStats = { total: 0, open: 0, testing: 0, supported: 0, refuted: 0, retired: 0, avgConfidence: 0 };
      let confSum = 0;
      for (const r of rows) {
        stats.total += r.n;
        confSum += (r.avg_conf ?? 0) * r.n;
        if (r.status === "open") stats.open = r.n;
        else if (r.status === "testing") stats.testing = r.n;
        else if (r.status === "supported") stats.supported = r.n;
        else if (r.status === "refuted") stats.refuted = r.n;
        else if (r.status === "retired") stats.retired = r.n;
      }
      stats.avgConfidence = stats.total > 0 ? confSum / stats.total : 0;
      return stats;
    } catch (err) {
      surfaceError("hypotheses.stats", err);
      return { total: 0, open: 0, testing: 0, supported: 0, refuted: 0, retired: 0, avgConfidence: 0 };
    }
  }
}

let singleton: HypothesisEngine | null = null;

export function getHypothesisEngine(): HypothesisEngine {
  if (!singleton) singleton = new HypothesisEngine();
  return singleton;
}

/** Test hooks — a fresh instance on a private bus / injected clock. */
export function __resetHypothesisEngineForTests(): void {
  singleton = null;
}
export function __createHypothesisEngineForTests(bus: BrainBus, clock?: () => string): HypothesisEngine {
  return new HypothesisEngine(bus, clock);
}
