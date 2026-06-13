// Procedural memory — the missing 6th memory layer: WHAT WORKS, as reusable
// procedures.
//
// The brain already has working memory (brainState), short/long-term
// (importance + decay), episodic (episodes.ts) and semantic (sleepCycle.ts)
// layers. What it never kept is skill: action sequences and reasoning
// configurations that SUCCEEDED, stored so they can be retrieved and reused.
// This module is that layer:
//
//   extractProcedures()    — mine the action audit (`action_log`) for
//                            recurring consecutive ok-sequences inside a
//                            10-minute window; a sequence seen ≥2 times
//                            becomes a procedure ("after web-search, the user
//                            usually learns the page"). Runs during sleep
//                            (sleepCycle.ts), like every other consolidation.
//   proceduresFor()        — lexical retrieval: which known procedures look
//                            relevant to this task? The agent loop prepends
//                            the top matches to its plan prompt as hints.
//   recordOutcome()        — Laplace-smoothed success score per procedure;
//                            the agent loop credits procedures whose steps
//                            appear (in order) in a successful run.
//   recordReasoningConfig()— persist a retrieval/reasoning configuration that
//                            worked (source 'reasoning-config').
//
// Persistence: the `procedures` table (migration 0011). The sequence-mining
// core is exported pure for the hermetic selfcheck; every DB method is
// failure-isolated so a procedural fault never breaks sleep or the agent loop.

import { createHash } from "node:crypto";
import { openDb } from "../db/sqlite.js";
import { surfaceError } from "../util/diagnostics.js";
import { tokens } from "../attention/saliency.js";
import { getEventBus, nowIso } from "../core/eventBus.js";
import { clampMagnitude, regionsFor } from "../../../shared/cognition.js";

export interface ProcedureRecord {
  id: string;
  title: string;
  triggerClass: string;
  steps: string[];
  source: "action-sequence" | "reasoning-config";
  successCount: number;
  failureCount: number;
  score: number;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface MinedSequence {
  steps: string[];
  occurrences: number;
}

// Mining bounds.
export const SEQUENCE_WINDOW_MS = 10 * 60_000; // steps belong together within 10 min
export const MIN_SEQ_LEN = 2;
export const MAX_SEQ_LEN = 5;
export const MIN_OCCURRENCES = 2;
export const SCAN_LIMIT = 600;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function laplaceScore(success: number, failure: number): number {
  return clamp01((success + 1) / (success + failure + 2));
}

// -----------------------------------------------------------------------------
// PURE sequence mining (selfcheck-exercisable).
// -----------------------------------------------------------------------------

export interface ActionLogEntry {
  actionId: string;
  ok: boolean;
  createdAt: string; // ISO
}

/**
 * Mine recurring consecutive ok-sequences. Entries must be time-ascending.
 * A "run" of consecutive ok actions breaks on a failure or a gap larger than
 * SEQUENCE_WINDOW_MS; every contiguous sub-sequence of length MIN..MAX inside
 * a run is a candidate; candidates seen ≥ MIN_OCCURRENCES are returned,
 * longest + most frequent first. Self-loops (a→a) are skipped — repeating the
 * same action is not a skill.
 */
export function mineSequences(entries: ReadonlyArray<ActionLogEntry>): MinedSequence[] {
  // Split into runs of consecutive successes within the window.
  const runs: string[][] = [];
  let current: string[] = [];
  let lastAt = Number.NEGATIVE_INFINITY;
  for (const e of entries) {
    const at = Date.parse(e.createdAt);
    const gap = Number.isFinite(at) ? at - lastAt : Number.POSITIVE_INFINITY;
    if (!e.ok || gap > SEQUENCE_WINDOW_MS) {
      if (current.length >= MIN_SEQ_LEN) runs.push(current);
      current = [];
    }
    if (e.ok) {
      current.push(e.actionId);
      lastAt = Number.isFinite(at) ? at : lastAt;
    }
  }
  if (current.length >= MIN_SEQ_LEN) runs.push(current);

  const counts = new Map<string, { steps: string[]; occurrences: number }>();
  for (const run of runs) {
    // Track which keys this run already contributed, so one long run doesn't
    // count the same sub-sequence twice.
    const seenInRun = new Set<string>();
    for (let len = MIN_SEQ_LEN; len <= MAX_SEQ_LEN; len += 1) {
      for (let i = 0; i + len <= run.length; i += 1) {
        const steps = run.slice(i, i + len);
        if (new Set(steps).size === 1) continue; // pure self-loop
        const key = steps.join("→");
        if (seenInRun.has(key)) continue;
        seenInRun.add(key);
        const entry = counts.get(key);
        if (entry) entry.occurrences += 1;
        else counts.set(key, { steps, occurrences: 1 });
      }
    }
  }

  return [...counts.values()]
    .filter((c) => c.occurrences >= MIN_OCCURRENCES)
    .sort(
      (a, b) =>
        b.steps.length - a.steps.length ||
        b.occurrences - a.occurrences ||
        a.steps.join("→").localeCompare(b.steps.join("→")),
    );
}

/** Is `steps` an ordered (not necessarily contiguous) subsequence of `executed`? */
export function isOrderedSubsequence(
  steps: ReadonlyArray<string>,
  executed: ReadonlyArray<string>,
): boolean {
  if (steps.length === 0) return false;
  let i = 0;
  for (const e of executed) {
    if (e === steps[i]) i += 1;
    if (i === steps.length) return true;
  }
  return false;
}

/** Token-overlap relevance of a task against a procedure. Pure. */
export function procedureMatch(taskTokens: ReadonlySet<string>, proc: ProcedureRecord): number {
  if (taskTokens.size === 0) return 0;
  const pt = new Set<string>([...tokens(proc.title), ...proc.steps.flatMap((s) => tokens(s.replace(/-/g, " ")))]);
  if (pt.size === 0) return 0;
  let inter = 0;
  for (const t of pt) if (taskTokens.has(t)) inter += 1;
  return inter / Math.min(taskTokens.size, pt.size);
}

/** Assemble the agent loop's "Known procedures" prompt block. Pure. */
export function proceduresPromptBlock(procs: ReadonlyArray<ProcedureRecord>): string {
  if (procs.length === 0) return "";
  const lines = procs.map(
    (p) =>
      `- ${p.steps.join(" → ")} (worked ${p.successCount}×, score ${(p.score * 100).toFixed(0)}%)`,
  );
  return [
    "Known procedures (tool sequences that worked before — hints, not orders):",
    ...lines,
  ].join("\n");
}

// -----------------------------------------------------------------------------
// DB layer — every method failure-isolated.
// -----------------------------------------------------------------------------

interface ProcedureRow {
  id: string;
  title: string;
  trigger_class: string;
  steps_json: string;
  source: string;
  success_count: number;
  failure_count: number;
  score: number;
  last_used_at: string | null;
  created_at: string;
}

function rowToRecord(row: ProcedureRow): ProcedureRecord {
  let steps: string[];
  try {
    const v = JSON.parse(row.steps_json) as unknown;
    steps = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    steps = [];
  }
  return {
    id: row.id,
    title: row.title,
    triggerClass: row.trigger_class,
    steps,
    source: row.source === "reasoning-config" ? "reasoning-config" : "action-sequence",
    successCount: row.success_count,
    failureCount: row.failure_count,
    score: row.score,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}

function emitProcedureLearned(title: string, detail: string): void {
  try {
    getEventBus().emit({
      kind: "cognition",
      event: {
        kind: "procedure-learned",
        label: `Learned a procedure: ${title}`.slice(0, 160),
        detail: detail.slice(0, 240),
        magnitude: clampMagnitude(0.7),
        logicalRegions: regionsFor("procedure-learned"),
        reason: "procedural-memory:extract",
        at: nowIso(),
      },
      at: nowIso(),
    });
  } catch (err) {
    surfaceError("procedural.emit", err);
  }
}

/**
 * Mine the action audit and persist new procedures. Existing procedures get
 * their occurrence credit as successes (the audit only shows ok runs).
 * Returns the number of NEW procedures learned.
 */
export function extractProcedures(): number {
  try {
    const rows = openDb()
      .prepare<[number], { action_id: string; ok: number; created_at: string }>(
        `SELECT action_id, ok, created_at FROM action_log ORDER BY created_at ASC LIMIT ?`,
      )
      .all(SCAN_LIMIT);
    const mined = mineSequences(
      rows.map((r) => ({ actionId: r.action_id, ok: r.ok === 1, createdAt: r.created_at })),
    );
    let learned = 0;
    const db = openDb();
    for (const seq of mined.slice(0, 12)) {
      const id = `proc-${createHash("sha1").update(seq.steps.join("→")).digest("hex").slice(0, 12)}`;
      const existing = db
        .prepare("SELECT success_count, failure_count FROM procedures WHERE id = ?")
        .get(id) as { success_count: number; failure_count: number } | undefined;
      if (existing) {
        // Re-mining the same sequence refreshes its success evidence: the
        // audit now shows at least `occurrences` successful runs.
        const success = Math.max(existing.success_count, seq.occurrences);
        db.prepare(`UPDATE procedures SET success_count = ?, score = ? WHERE id = ?`).run(
          success,
          laplaceScore(success, existing.failure_count),
          id,
        );
        continue;
      }
      const title = seq.steps.join(" → ");
      db.prepare(
        `INSERT INTO procedures (id, title, trigger_class, steps_json, source,
           success_count, failure_count, score, last_used_at, created_at)
         VALUES (?, ?, ?, ?, 'action-sequence', ?, 0, ?, NULL, ?)`,
      ).run(
        id,
        title,
        seq.steps[0],
        JSON.stringify(seq.steps),
        seq.occurrences,
        laplaceScore(seq.occurrences, 0),
        nowIso(),
      );
      learned += 1;
      emitProcedureLearned(title, `seen ${seq.occurrences}× in the action audit`);
    }
    return learned;
  } catch (err) {
    surfaceError("procedural.extract", err);
    return 0;
  }
}

/** Credit/blame a procedure after a run that used (or matched) it. */
export function recordOutcome(procedureId: string, ok: boolean): void {
  try {
    const db = openDb();
    const row = db.prepare("SELECT success_count, failure_count FROM procedures WHERE id = ?").get(procedureId) as
      | { success_count: number; failure_count: number }
      | undefined;
    if (!row) return;
    const success = row.success_count + (ok ? 1 : 0);
    const failure = row.failure_count + (ok ? 0 : 1);
    db.prepare(
      `UPDATE procedures SET success_count = ?, failure_count = ?, score = ?, last_used_at = ? WHERE id = ?`,
    ).run(success, failure, laplaceScore(success, failure), nowIso(), procedureId);
  } catch (err) {
    surfaceError("procedural.recordOutcome", err);
  }
}

/** Procedures lexically relevant to a task, best score×match first. */
export function proceduresFor(task: string, limit = 3): ProcedureRecord[] {
  try {
    const taskTokens = new Set(tokens(task));
    const rows = openDb()
      .prepare(`SELECT * FROM procedures ORDER BY score DESC, success_count DESC LIMIT 100`)
      .all() as ProcedureRow[];
    return rows
      .map(rowToRecord)
      .map((p) => ({ p, match: procedureMatch(taskTokens, p) }))
      .filter((x) => x.match > 0)
      .sort((a, b) => b.match * b.p.score - a.match * a.p.score)
      .slice(0, Math.max(1, limit))
      .map((x) => x.p);
  } catch (err) {
    surfaceError("procedural.for", err);
    return [];
  }
}

export function listProcedures(limit = 50): ProcedureRecord[] {
  try {
    const rows = openDb()
      .prepare(`SELECT * FROM procedures ORDER BY score DESC, success_count DESC LIMIT ?`)
      .all(Math.min(200, Math.max(1, limit))) as ProcedureRow[];
    return rows.map(rowToRecord);
  } catch (err) {
    surfaceError("procedural.list", err);
    return [];
  }
}

/**
 * After a successful agent run: every stored procedure whose steps appear in
 * order in the run's executed actions gets a success credit. Returns the
 * number of procedures credited.
 */
export function creditMatchingProcedures(executedActionIds: ReadonlyArray<string>): number {
  try {
    if (executedActionIds.length === 0) return 0;
    let credited = 0;
    for (const proc of listProcedures(100)) {
      if (proc.source !== "action-sequence") continue;
      if (isOrderedSubsequence(proc.steps, executedActionIds)) {
        recordOutcome(proc.id, true);
        credited += 1;
      }
    }
    return credited;
  } catch (err) {
    surfaceError("procedural.credit", err);
    return 0;
  }
}

/** Persist a reasoning/retrieval configuration that worked (or didn't). */
export function recordReasoningConfig(label: string, config: Record<string, unknown>, ok: boolean): void {
  try {
    const id = `proc-${createHash("sha1").update(`config:${label}`).digest("hex").slice(0, 12)}`;
    const db = openDb();
    const row = db.prepare("SELECT success_count, failure_count FROM procedures WHERE id = ?").get(id) as
      | { success_count: number; failure_count: number }
      | undefined;
    if (row) {
      recordOutcome(id, ok);
      return;
    }
    db.prepare(
      `INSERT INTO procedures (id, title, trigger_class, steps_json, source,
         success_count, failure_count, score, last_used_at, created_at)
       VALUES (?, ?, ?, ?, 'reasoning-config', ?, ?, ?, ?, ?)`,
    ).run(
      id,
      label.slice(0, 120),
      "reasoning",
      JSON.stringify([JSON.stringify(config).slice(0, 600)]),
      ok ? 1 : 0,
      ok ? 0 : 1,
      laplaceScore(ok ? 1 : 0, ok ? 0 : 1),
      nowIso(),
      nowIso(),
    );
  } catch (err) {
    surfaceError("procedural.recordConfig", err);
  }
}
