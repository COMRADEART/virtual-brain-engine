// The Spinal Cord — the conduit between the BRAIN (cognition: the 7-step
// pipeline, the agentic loop, goals/beliefs) and the BODY (effectors: the
// permissioned action executor). Shared between the Vite frontend and the
// Express server. ZERO runtime deps beyond plain constants (the shared/
// contract) so both sides import it without a build step.
//
// NEUROANATOMY → ARCHITECTURE. A real spinal cord carries motor commands DOWN
// to the muscles (efferent / descending) and sensory signals UP to the brain
// (afferent / ascending), and runs fast local REFLEX ARCS that bypass the
// cortex entirely. This module models exactly that as a COST-GRADED descending
// pathway — spend the least cognition the task needs:
//
//   reflex      — a recognised stimulus fires ONE safe action instantly, no LLM
//                 (the "knee-jerk"; the NanoClaw/NemoClaw minimal loop).
//   program     — a practiced, all-safe action SEQUENCE runs automatically, no
//                 LLM (a central pattern generator; bridges procedural memory).
//   deliberate  — full cortical thinking via the existing agent loop, shaped by
//                 the selected motor-pool PERSONA (the OpenClaw persona-forge).
//
// Above the tracts sits the dispatcher (Hermes): a priority/scheduled task
// queue that drives descending intents and carries afferent feedback back up.
//
// THE SAFETY INVARIANT (enforced server-side, see server/src/spine + executor):
// the spine is a ROUTER, never a privilege. Every effector call still goes
// through executeAction (allowlist + zod + confirm/scope gate + audit). Reflex
// and program tracts fire ONLY safe-tier actions; any confirm-tier intent falls
// through to the deliberate tract where the run's confirm mode gates it.

import type { LogicalRegionId } from "./pipeline";
import type { ActionRiskTier } from "./actions";
import type { AgentConfirmMode } from "./agent";

// ── Tracts (descending pathways, increasing cognitive cost) ──────────────────
export type SpinalTract = "reflex" | "program" | "deliberate";

export const SPINAL_TRACTS: SpinalTract[] = ["reflex", "program", "deliberate"];

// ── Motor pools / personas (OpenClaw persona-forge) ──────────────────────────
// "connector" is the MCP envoy: it biases the deliberate tract toward external
// MCP-server tools (filesystem, git, fetch, …). Like every pool it grants nothing
// — `ceiling` only narrows; the per-action executor gate stays the authority.
export type SpinalPersonaId = "courier" | "scribe" | "mechanic" | "scholar" | "connector" | "reflex";

export const SPINAL_PERSONA_IDS: SpinalPersonaId[] = [
  "courier",
  "scribe",
  "mechanic",
  "scholar",
  "connector",
  "reflex",
];

export interface SpinalPersona {
  id: SpinalPersonaId;
  name: string;
  /** Short human label of the domain this motor pool specialises in. */
  domain: string;
  description: string;
  /** Action ids this pool is biased toward — a HINT for the deliberate tract. */
  preferredActions: string[];
  /**
   * The highest risk tier this persona may drive in the deliberate tract. This
   * is an ADDITIONAL ceiling layered on top of the per-action executor gate —
   * it never grants privilege, only narrows it. "safe" = read-only pool.
   */
  ceiling: ActionRiskTier;
  /** A prompt suffix that flavors the deliberate tract's system prompt. */
  flavor: string;
}

// ── Reflex arcs (NanoClaw/NemoClaw minimal loop) ─────────────────────────────
export interface ReflexArc {
  id: string;
  name: string;
  /** Lowercased trigger substrings; ANY match arms the reflex. */
  triggers: string[];
  /**
   * The action fired when armed. MUST resolve to a SAFE-tier action — a reflex
   * fires with no human confirmation and no LLM, so it can never carry a
   * side-effecting (confirm-tier) command. Re-validated server-side at register
   * time AND fire time.
   */
  actionId: string;
  /**
   * Optional: lift one free-text arg from the intent into this param. The value
   * is the text after the first connector word ("for" / "about" / ":"). When
   * the reflex needs an arg it cannot extract, it declines and the intent falls
   * through to a higher tract.
   */
  argParam?: string;
  description: string;
  builtIn: boolean;
}

// ── Motor commands (one descending intent through the cord) ──────────────────
export type MotorCommandStatus =
  | "queued" // waiting in the dispatcher queue
  | "reflex" // fired as a reflex
  | "program" // ran as a motor program
  | "deliberate" // handed to the deliberate tract
  | "done" // completed (afferent feedback recorded)
  | "blocked" // could not complete (permission / capability)
  | "rejected"; // refused before routing (empty intent, etc.)

export interface MotorCommand {
  id: string;
  intent: string;
  /** Where the descending drive came from: "route" | "queue" | "goal" | ... */
  origin: string;
  personaId: SpinalPersonaId;
  /** The tract chosen by the dispatcher; null until routed. */
  tract: SpinalTract | null;
  status: MotorCommandStatus;
  /** Higher runs sooner out of the queue. */
  priority: number;
  createdAt: string;
  /** ISO time a queued task becomes due; absent = immediately due. */
  scheduledFor?: string;
  /** Afferent: a truncated summary of what came back up. */
  summary?: string;
  ok?: boolean;
}

// ── Dispatch request (the main descending entrypoint) ────────────────────────
export interface SpineDispatchRequest {
  intent: string;
  personaId?: SpinalPersonaId; // auto-routed by keyword when omitted
  /** Confirm policy for the deliberate tract (reused from the agent loop). */
  mode?: AgentConfirmMode;
  /** Risk ceiling the user granted for this run (scope mode). */
  scope?: ActionRiskTier[];
  priority?: number;
  origin?: string;
}

// ── Status surface (GET /api/spine/state) ────────────────────────────────────
export interface SpineSnapshot {
  queueDepth: number;
  /** Queued, not yet run, soonest/highest-priority first. */
  pending: MotorCommand[];
  /** Last N executed commands, newest first. */
  recent: MotorCommand[];
  reflexes: ReflexArc[];
  personas: SpinalPersona[];
  tractCounts: Record<SpinalTract, number>;
  lastDispatchAt: string | null;
}

// ── Bus event (rides BrainBusMessage as { type: "spine" }) ───────────────────
export type SpineEventKind =
  | "command-queued"
  | "reflex-fired"
  | "program-run"
  | "dispatched" // deliberate tract started
  | "feedback"; // afferent — an outcome travelled back up

export interface SpineEvent {
  kind: SpineEventKind;
  tract: SpinalTract | null;
  personaId: SpinalPersonaId;
  /** Truncated intent text. */
  intent: string;
  actionId?: string;
  ok?: boolean;
  /** Truncated detail. */
  detail?: string;
  /** Existing cortices that co-flash with the spine column. */
  logicalRegions: LogicalRegionId[];
  at: string;
}

/**
 * Tract → the existing logical cortices that flash ALONGSIDE the spine column.
 * Pure data — adding a tract never touches the anatomical/logical region model.
 *   reflex      → response-center   (a fast motor-out blink)
 *   program     → learning-feedback (practiced sequence: cerebellum/basal-ganglia)
 *   deliberate  → reasoning + response (full cortical control)
 */
export function regionsForTract(tract: SpinalTract): LogicalRegionId[] {
  switch (tract) {
    case "reflex":
      return ["response-center"];
    case "program":
      return ["learning-feedback-center"];
    case "deliberate":
      return ["reasoning-cortex", "response-center"];
  }
}

/** Clamp a priority into a sane band so the queue ordering stays stable. */
export function clampPriority(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < -100 ? -100 : v > 100 ? 100 : Math.round(v);
}
