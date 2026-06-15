// Motor programs — central pattern generators (CPGs).
//
// A real spinal cord runs rhythmic motor PROGRAMS — walking, breathing — as
// fixed action sequences that fire automatically, without the cortex deciding
// each step. This is the brain's analogue: a PRACTICED procedure (mined into
// procedural memory from the action audit) whose every step is a safe-tier
// no-argument action can run as a program — the whole sequence fires through
// the executor with NO LLM round-trips, the way a well-drilled routine becomes
// automatic.
//
// SAFETY. A program runs unattended, so — like a reflex — every step must be
// SAFE-tier (re-derived from the registry per step) AND accept empty args (so
// the program can supply them without a model). Any step that is confirm-tier
// or needs an argument we can't supply makes the procedure INELIGIBLE as a
// program; the dispatcher then routes the intent to the deliberate tract, where
// the procedure still rides along as a strong "known-good sequence" hint and
// each step is gated normally.
//
// This module is the PURE selection + eligibility layer; cord.ts owns the
// execution (it has the executor, the emit, and the afferent-feedback path).

import { getActionDef, validateArgs } from "../actions/registry.js";
import { proceduresFor, type ProcedureRecord } from "../memory/procedural.js";
import { surfaceError } from "../util/diagnostics.js";

// A procedure is only auto-run as a program when it is both well-practiced and
// confidently relevant — otherwise the safer deliberate tract handles it.
export const PROGRAM_MIN_SCORE = 0.6; // Laplace success score floor

export interface MotorProgram {
  procedureId: string;
  title: string;
  steps: string[];
  /** Pre-derived empty args per step (all program steps take {} — see below). */
  source: "procedural";
}

/**
 * Is `actionId` runnable as one unattended program step? It must be a safe-tier
 * action whose schema accepts empty args (nothing required). Pure given the
 * registry. NOTE: validateArgs returns ok for a schema with only optional
 * fields, which is exactly the "no required args" test we want.
 */
export function isProgramStep(actionId: string): boolean {
  const def = getActionDef(actionId);
  if (!def || def.risk !== "safe") return false;
  if (def.surface !== "server") return false; // os-surface needs the Tauri client
  const v = validateArgs(def.id, {});
  return v.ok === true;
}

/** Every step of the procedure is an unattended-runnable safe step. */
export function canRunAsProgram(steps: ReadonlyArray<string>): boolean {
  return steps.length > 0 && steps.every(isProgramStep);
}

/**
 * Select a runnable motor program for an intent, or null. Pulls the best
 * procedural match; returns it as a program only when it clears the score floor
 * AND every step is unattended-safe. Failure-isolated (a procedural fault → no
 * program, never a throw).
 */
export function selectProgram(intent: string): MotorProgram | null {
  try {
    const candidates = proceduresFor(intent, 3);
    for (const proc of candidates) {
      if (proc.source !== "action-sequence") continue;
      if (proc.score < PROGRAM_MIN_SCORE) continue;
      if (!canRunAsProgram(proc.steps)) continue;
      return {
        procedureId: proc.id,
        title: proc.title,
        steps: proc.steps,
        source: "procedural",
      };
    }
    return null;
  } catch (err) {
    surfaceError("spine.motorPrograms.select", err);
    return null;
  }
}

/**
 * The best procedural match for an intent, regardless of program-eligibility —
 * used by the deliberate tract to inject a "known-good sequence" hint even when
 * the procedure can't run unattended. Returns null when there's no good match.
 */
export function bestProcedureHint(intent: string): ProcedureRecord | null {
  try {
    return proceduresFor(intent, 1)[0] ?? null;
  } catch (err) {
    surfaceError("spine.motorPrograms.hint", err);
    return null;
  }
}
