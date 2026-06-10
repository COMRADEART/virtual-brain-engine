// Embodiment — close the action → consequence loop.
//
// The computer is this brain's body, but until now actions executed and the
// brain never OBSERVED what happened: the causal world model (core/causalMap)
// learned only from imagination.reflect()'s taxonomic labels. This module
// feeds it real motor experience instead — for every executed action the
// executor records the observed outcome, so `imagination.imagine()` and the
// curiosity frontier start predicting from what actually happened.
//
// Effect classes recorded per attempt (every class every observation — the
// causalMap contract that keeps the per-effect probabilities honest):
//   success / failure   — did the handler succeed?
//   state-changed       — did the probed world state actually change? For
//                         path-bearing actions we stat the file before/after;
//                         for learn/research/note actions we count memories.
//                         null probes (unprobeable actions) skip this class
//                         rather than record a fake "no".
//
// Bounded (one stat / one COUNT per probe), failure-isolated (a probe or
// ledger fault never affects the action result), and synchronous-cheap.

import { promises as fs } from "node:fs";
import { recordObservation } from "../core/causalMap.js";
import { getMemoryCount } from "../db/repositories/memory.js";
import { surfaceError } from "../util/diagnostics.js";

export interface StateProbe {
  kind: "fs" | "memory";
  /** Comparable fingerprint of the probed state. */
  fingerprint: string;
}

export const CAUSAL_SOURCE = "action-executor";

// Actions whose args carry a filesystem path worth probing.
const FS_PROBE_ACTIONS = new Set(["write-file", "read-file", "list-directory", "git-write-file"]);
// Actions that add memories when they work.
const MEMORY_PROBE_ACTIONS = new Set([
  "create-note",
  "learn-url",
  "research-web",
  "github-learn",
]);

/**
 * Probe the slice of world state this action is about to touch. Returns null
 * when the action has no cheap observable (most safe reads) — the
 * state-changed effect is then skipped, never faked.
 */
export async function probeState(actionId: string, args: Record<string, unknown>): Promise<StateProbe | null> {
  try {
    if (FS_PROBE_ACTIONS.has(actionId) && typeof args.path === "string") {
      try {
        const st = await fs.stat(args.path);
        return { kind: "fs", fingerprint: `${st.size}:${st.mtimeMs}` };
      } catch {
        return { kind: "fs", fingerprint: "absent" };
      }
    }
    if (MEMORY_PROBE_ACTIONS.has(actionId)) {
      return { kind: "memory", fingerprint: String(getMemoryCount()) };
    }
  } catch (err) {
    surfaceError("consequences.probeState", err);
  }
  return null;
}

/** Pure: did the probed state change between the two observations? */
export function stateChanged(before: StateProbe | null, after: StateProbe | null): boolean | null {
  if (!before || !after || before.kind !== after.kind) return null;
  return before.fingerprint !== after.fingerprint;
}

/**
 * Record the observed outcome of one executed action into the causal ledger.
 * Never throws. Returns the number of effect observations written.
 */
export function recordActionOutcome(input: {
  actionId: string;
  ok: boolean;
  before: StateProbe | null;
  after: StateProbe | null;
}): number {
  const cause = `action:${input.actionId}`;
  let written = 0;
  try {
    recordObservation({ causeClass: cause, effectClass: "success", occurred: input.ok, source: CAUSAL_SOURCE });
    written += 1;
    recordObservation({ causeClass: cause, effectClass: "failure", occurred: !input.ok, source: CAUSAL_SOURCE });
    written += 1;
    const changed = stateChanged(input.before, input.after);
    if (changed !== null) {
      recordObservation({ causeClass: cause, effectClass: "state-changed", occurred: changed, source: CAUSAL_SOURCE });
      written += 1;
    }
  } catch (err) {
    surfaceError("consequences.recordActionOutcome", err);
  }
  return written;
}
