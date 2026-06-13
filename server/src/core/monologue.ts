// First-person inner monologue emitter.
//
// Turns the current cognitive state into ONE first-person line and emits it
// as a "monologue" CognitionEvent on the internal brain bus, rate-limited.
//
// Design rules:
//   • `composeMonologue` is PURE — deterministic, no side effects, no imports
//     beyond the shared contracts.
//   • `emitMonologue` is the only side-effecting entry point; it never throws.
//   • The rate-gate is module-scoped (a single process-wide counter); tests
//     reset it via the exported `__resetMonologueGate()`.

import { getEventBus } from "./eventBus.js";
import { clampMagnitude, regionsFor } from "../../../shared/cognition.js";
import type { CognitionEvent } from "../../../shared/cognition.js";

// ── Tunables (no CONFIG import) ──────────────────────────────────────────────

/** Minimum milliseconds between emitted monologue events. */
export const MONOLOGUE_MIN_GAP_MS = 5 * 60 * 1000; // 5 minutes

/** [0,1] flash gain for the monologue kind. */
export const MONOLOGUE_MAGNITUDE = 0.4;

// ── Public types ─────────────────────────────────────────────────────────────

export interface MonologueContext {
  stage: number;
  contestedBelief?: string | null;
  activeGoal?: string | null;
  narrativeIdentity?: string | null;
  curiosity?: string | null;
}

// ── Rate-gate state (module-scoped mutable) ──────────────────────────────────

let lastEmitAt = 0;

/** Test helper — resets the rate-gate so successive selfcheck calls don't
 *  interfere with each other. Never call this in production code. */
export function __resetMonologueGate(): void {
  lastEmitAt = 0;
}

// ── Pure composer ─────────────────────────────────────────────────────────────

const MAX_LINE = 200;

function trim(s: string): string {
  return s.length > MAX_LINE ? s.slice(0, MAX_LINE - 1).trimEnd() + "…" : s;
}

/**
 * Pick ONE first-person monologue line from `ctx` by priority.
 * Returns `null` when there is genuinely nothing to say.
 *
 * Priority order:
 *   1. contestedBelief  → "I keep turning over whether "<belief>" really holds."
 *   2. curiosity        → "I wonder <curiosity>" (natural prefix if needed)
 *   3. activeGoal       → "I'm working toward <goal>."
 *   4. narrativeIdentity→ as-is if starts with "I"; else "I am <identity>"
 *   5. stage >= 1       → "I've grown to stage <n> — I can feel how my thinking has changed."
 *   6. else             → null
 */
export function composeMonologue(ctx: MonologueContext): string | null {
  const belief = ctx.contestedBelief?.trim();
  if (belief) {
    return trim(`I keep turning over whether "${belief}" really holds.`);
  }

  const curiosity = ctx.curiosity?.trim();
  if (curiosity) {
    // Avoid double "I wonder I wonder …"
    const lower = curiosity.toLowerCase();
    if (lower.startsWith("i wonder")) {
      return trim(curiosity.charAt(0).toUpperCase() + curiosity.slice(1));
    }
    return trim(`I wonder ${curiosity}`);
  }

  const goal = ctx.activeGoal?.trim();
  if (goal) {
    return trim(`I'm working toward ${goal}.`);
  }

  const identity = ctx.narrativeIdentity?.trim();
  if (identity) {
    if (identity.startsWith("I") || identity.startsWith("i")) {
      return trim(identity);
    }
    return trim(`I am ${identity}`);
  }

  if (ctx.stage >= 1) {
    return trim(
      `I've grown to stage ${ctx.stage} — I can feel how my thinking has changed.`,
    );
  }

  return null;
}

// ── Side-effecting emitter ────────────────────────────────────────────────────

export interface MonologueResult {
  emitted: boolean;
  line: string | null;
  reason?: string;
}

/**
 * Compose a monologue line from `ctx`, apply the rate-gate, and emit a
 * "monologue" CognitionEvent on the brain bus.
 *
 * Options:
 *   `now`   — override `Date.now()` (useful in tests for deterministic timing)
 *   `force` — bypass the rate-gate
 *
 * Never throws.
 */
export function emitMonologue(
  ctx: MonologueContext,
  opts?: { now?: number; force?: boolean },
): MonologueResult {
  const line = composeMonologue(ctx);

  if (line === null) {
    return { emitted: false, line: null, reason: "nothing to say" };
  }

  const now = opts?.now ?? Date.now();

  if (!opts?.force && now - lastEmitAt < MONOLOGUE_MIN_GAP_MS) {
    return { emitted: false, line, reason: "rate-limited" };
  }

  const cognitionEvent: CognitionEvent = {
    kind: "monologue",
    label: line,
    magnitude: clampMagnitude(MONOLOGUE_MAGNITUDE),
    logicalRegions: regionsFor("monologue"),
    reason: "inner-monologue",
    at: new Date(now).toISOString(),
  };

  try {
    getEventBus().emit({ kind: "cognition", event: cognitionEvent, at: cognitionEvent.at });
  } catch {
    return { emitted: false, line, reason: "emit failed" };
  }

  lastEmitAt = now;
  return { emitted: true, line };
}
