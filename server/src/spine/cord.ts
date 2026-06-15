// The spinal cord — the dispatcher (Hermes) that carries descending intents from
// the brain down to the body and afferent feedback back up.
//
// Every descending intent becomes a MotorCommand and is routed down a
// cost-graded pathway, spending the least cognition the task needs:
//
//   1. REFLEX     — a recognised stimulus fires ONE safe action instantly, no
//                   LLM (reflexes.ts). The knee-jerk.
//   2. PROGRAM    — a practiced all-safe action SEQUENCE runs automatically, no
//                   LLM (motorPrograms.ts, bridging procedural memory). The CPG.
//   3. DELIBERATE — full cortical thinking via the existing agent loop, shaped
//                   by the selected motor-pool persona (personas.ts).
//
// Above the tracts: a priority/scheduled task QUEUE (Hermes) so the brain can
// queue descending drives (e.g. a goal's next action) and the cord works them
// off on a tick, broadcasting afferent feedback as each completes.
//
// SAFETY INVARIANT. The cord is a ROUTER, never a privilege. Reflex + program
// tracts fire ONLY safe-tier actions — re-derived from the registry at fire time
// — and even those go through executeAction (so they're audited). Any confirm-
// tier intent can ONLY reach an effector via the deliberate tract, where the
// run's confirm mode (ask / scope / safe-only) gates it exactly as the agent
// loop does. The executor stays the single neuromuscular chokepoint.

import { ulid } from "ulid";
import { broadcast } from "../ws/brainBus.js";
import { surfaceError } from "../util/diagnostics.js";
import { executeAction } from "../actions/executor.js";
import { matchReflex, isReflexEligible, listReflexes } from "./reflexes.js";
import { selectProgram, bestProcedureHint } from "./motorPrograms.js";
import {
  pickPersona,
  getPersona,
  isPersonaId,
  listPersonas,
  personaDirective,
} from "./personas.js";
import { recordOutcome, proceduresPromptBlock } from "../memory/procedural.js";
import { startAgentRun, runAgentLoop } from "../reasoning/agentLoop.js";
import type { AgentConfirmMode, AgentEvent } from "../../../shared/agent.js";
import type { PipelineEvent } from "../../../shared/pipeline.js";
import type { ActionRiskTier } from "../../../shared/actions.js";
import {
  clampPriority,
  regionsForTract,
  type MotorCommand,
  type SpineDispatchRequest,
  type SpineEvent,
  type SpineEventKind,
  type SpineSnapshot,
  type SpinalPersona,
  type SpinalTract,
} from "../../../shared/spine.js";

// A frame on the /api/spine/dispatch SSE stream is a spine event envelope, an
// agent-loop event (deliberate tract), or a bare pipeline event (region flashes
// the loop broadcasts). The route writes whatever the cord emits.
export type SpineFrame =
  | { type: "spine"; event: SpineEvent; timestamp: string }
  | AgentEvent
  | PipelineEvent;
export type SpineEmit = (frame: SpineFrame) => void;

const NOOP_EMIT: SpineEmit = () => {};
const RECENT_CAP = 30;
const QUEUE_PER_TICK = 2; // bound work per tick so the queue never stampedes

function nowIso(): string {
  return new Date().toISOString();
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

class SpinalCord {
  private readonly queue: MotorCommand[] = [];
  private readonly recent: MotorCommand[] = [];
  private readonly tractCounts: Record<SpinalTract, number> = {
    reflex: 0,
    program: 0,
    deliberate: 0,
  };
  private lastDispatchAt: string | null = null;

  // ── Events (SSE frame + WS broadcast so any tab's 3D spine flashes) ────────
  private emitSpine(
    emit: SpineEmit,
    kind: SpineEventKind,
    tract: SpinalTract | null,
    persona: SpinalPersona,
    intent: string,
    extra: Partial<SpineEvent> = {},
  ): void {
    const event: SpineEvent = {
      kind,
      tract,
      personaId: persona.id,
      intent: trunc(intent, 160),
      logicalRegions: tract ? regionsForTract(tract) : [],
      at: nowIso(),
      ...extra,
    };
    const frame = { type: "spine" as const, event, timestamp: event.at };
    try {
      emit(frame);
    } catch (err) {
      surfaceError("spine.emit", err);
    }
    try {
      broadcast(frame);
    } catch (err) {
      surfaceError("spine.broadcast", err);
    }
  }

  private remember(cmd: MotorCommand): void {
    this.recent.unshift(cmd);
    if (this.recent.length > RECENT_CAP) this.recent.length = RECENT_CAP;
  }

  // ── Reflex + program execution (safe-tier only, through the executor) ──────
  private async fireReflex(
    cmd: MotorCommand,
    persona: SpinalPersona,
    actionId: string,
    args: Record<string, unknown>,
    emit: SpineEmit,
  ): Promise<void> {
    cmd.tract = "reflex";
    cmd.status = "reflex";
    this.emitSpine(emit, "reflex-fired", "reflex", persona, cmd.intent, { actionId });
    const result = await executeAction({ actionId, args }).catch((err) => ({
      ok: false,
      actionId,
      summary: "",
      error: err instanceof Error ? err.message : String(err),
      status: 500 as const,
    }));
    cmd.ok = result.ok;
    cmd.summary = result.ok ? result.summary : result.error ?? "failed";
    cmd.status = result.ok ? "done" : "blocked";
    this.tractCounts.reflex += 1;
    this.emitSpine(emit, "feedback", "reflex", persona, cmd.intent, {
      actionId,
      ok: result.ok,
      detail: trunc(cmd.summary ?? "", 200),
    });
    this.remember(cmd);
  }

  private async runProgram(
    cmd: MotorCommand,
    persona: SpinalPersona,
    program: NonNullable<ReturnType<typeof selectProgram>>,
    emit: SpineEmit,
  ): Promise<void> {
    cmd.tract = "program";
    cmd.status = "program";
    this.emitSpine(emit, "program-run", "program", persona, cmd.intent, {
      detail: trunc(program.steps.join(" → "), 200),
    });
    const summaries: string[] = [];
    let allOk = true;
    for (const step of program.steps) {
      // Re-check safe-tier at run time — never trust the stored procedure.
      if (!isReflexEligible(step)) {
        allOk = false;
        summaries.push(`${step}: skipped (not safe)`);
        continue;
      }
      const result = await executeAction({ actionId: step, args: {} }).catch((err) => ({
        ok: false,
        actionId: step,
        summary: "",
        error: err instanceof Error ? err.message : String(err),
        status: 500 as const,
      }));
      allOk = allOk && result.ok;
      summaries.push(`${step}: ${result.ok ? result.summary : result.error ?? "failed"}`);
    }
    // Credit the procedure for the automatic run.
    try {
      recordOutcome(program.procedureId, allOk);
    } catch (err) {
      surfaceError("spine.program.credit", err);
    }
    cmd.ok = allOk;
    cmd.summary = trunc(summaries.join(" | "), 600);
    cmd.status = allOk ? "done" : "blocked";
    this.tractCounts.program += 1;
    this.emitSpine(emit, "feedback", "program", persona, cmd.intent, {
      ok: allOk,
      detail: trunc(cmd.summary ?? "", 200),
    });
    this.remember(cmd);
  }

  // ── Deliberate tract (the agent loop, persona-flavored) ────────────────────
  private async runDeliberate(
    cmd: MotorCommand,
    persona: SpinalPersona,
    mode: AgentConfirmMode,
    scope: ActionRiskTier[],
    emit: SpineEmit,
  ): Promise<void> {
    cmd.tract = "deliberate";
    cmd.status = "deliberate";
    this.tractCounts.deliberate += 1;
    this.emitSpine(emit, "dispatched", "deliberate", persona, cmd.intent, {
      detail: persona.name,
    });

    // Persona flavor + a known-good procedure hint ride into the loop's prompt
    // as context (the agent loop is untouched — it just reads a richer Request).
    const hint = bestProcedureHint(cmd.intent);
    const hintBlock = hint ? proceduresPromptBlock([hint]) : "";
    const prompt = [personaDirective(persona), hintBlock, `Task: ${cmd.intent}`]
      .filter((s) => s.length > 0)
      .join("\n\n");

    // The deliberate tract honors the persona's risk ceiling: scope is narrowed
    // to what BOTH the user granted AND the pool allows. The per-action executor
    // gate remains the authority — this only ever narrows.
    const cappedScope =
      persona.ceiling === "safe" ? [] : scope.filter((t) => t === "safe" || t === "confirm");

    // Capture the loop's outcome for afferent feedback without changing the
    // agent loop: sniff its final/metrics frames as they pass through.
    const sniff: SpineEmit = (frame) => {
      emit(frame);
      if ("type" in frame && frame.type === "spine") return;
      const agentFrame = frame as AgentEvent;
      if (agentFrame.type === "final" && typeof agentFrame.text === "string") {
        cmd.summary = trunc(agentFrame.text, 600);
      } else if (agentFrame.type === "metrics" && agentFrame.metrics) {
        const status = agentFrame.metrics.status;
        cmd.ok = status === "done";
        cmd.status =
          status === "done"
            ? "done"
            : status === "paused"
              ? "deliberate"
              : "blocked";
      }
    };

    try {
      const run = startAgentRun({
        prompt,
        conversationId: cmd.id,
        mode,
        scope: cappedScope,
      });
      await runAgentLoop(run, sniff);
    } catch (err) {
      cmd.ok = false;
      cmd.status = "blocked";
      cmd.summary = err instanceof Error ? err.message : String(err);
      surfaceError("spine.deliberate", err);
    }
    this.emitSpine(emit, "feedback", "deliberate", persona, cmd.intent, {
      ok: cmd.ok,
      detail: trunc(cmd.summary ?? "", 200),
    });
    this.remember(cmd);
  }

  // ── Public: dispatch one descending intent ─────────────────────────────────
  async dispatch(req: SpineDispatchRequest, emit: SpineEmit = NOOP_EMIT): Promise<MotorCommand> {
    const intent = (req.intent ?? "").trim();
    const persona: SpinalPersona =
      req.personaId && isPersonaId(req.personaId) ? getPersona(req.personaId) : pickPersona(intent);
    const cmd: MotorCommand = {
      id: `mc-${ulid()}`,
      intent,
      origin: req.origin ?? "route",
      personaId: persona.id,
      tract: null,
      status: "queued",
      priority: clampPriority(req.priority ?? 0),
      createdAt: nowIso(),
    };
    if (intent.length === 0) {
      cmd.status = "rejected";
      cmd.summary = "empty intent";
      this.remember(cmd);
      return cmd;
    }
    this.lastDispatchAt = cmd.createdAt;

    const mode: AgentConfirmMode = req.mode ?? "ask";
    const scope = req.scope ?? [];

    try {
      // (1) REFLEX — only when the persona allows reflex/safe behavior (every
      // persona does — reflexes are read-only) and a safe arc matches.
      const reflex = matchReflex(intent);
      if (reflex && isReflexEligible(reflex.arc.actionId)) {
        await this.fireReflex(cmd, persona, reflex.arc.actionId, reflex.args, emit);
        return cmd;
      }

      // (2) PROGRAM — a practiced all-safe sequence. The Reflex pool stops here
      // (it never engages the deliberate tract); other pools fall through.
      const program = selectProgram(intent);
      if (program) {
        await this.runProgram(cmd, persona, program, emit);
        return cmd;
      }

      // The Reflex pool is minimal by contract: if nothing reflexive matched it
      // declines rather than escalating to full deliberation.
      if (persona.id === "reflex") {
        cmd.tract = "reflex";
        cmd.status = "blocked";
        cmd.ok = false;
        cmd.summary = "no reflex matched (Reflex pool does not deliberate)";
        this.emitSpine(emit, "feedback", "reflex", persona, intent, {
          ok: false,
          detail: cmd.summary,
        });
        this.remember(cmd);
        return cmd;
      }

      // (3) DELIBERATE — full cortical control via the agent loop.
      await this.runDeliberate(cmd, persona, mode, scope, emit);
      return cmd;
    } catch (err) {
      cmd.status = "blocked";
      cmd.ok = false;
      cmd.summary = err instanceof Error ? err.message : String(err);
      surfaceError("spine.dispatch", err);
      this.remember(cmd);
      return cmd;
    }
  }

  // ── Public: the Hermes task queue ──────────────────────────────────────────
  enqueue(req: SpineDispatchRequest, emit: SpineEmit = NOOP_EMIT): MotorCommand {
    const intent = (req.intent ?? "").trim();
    const persona = req.personaId && isPersonaId(req.personaId) ? getPersona(req.personaId) : pickPersona(intent);
    const cmd: MotorCommand = {
      id: `mc-${ulid()}`,
      intent,
      origin: req.origin ?? "queue",
      personaId: persona.id,
      tract: null,
      status: "queued",
      priority: clampPriority(req.priority ?? 0),
      createdAt: nowIso(),
      scheduledFor: nowIso(),
    };
    if (intent.length === 0) {
      cmd.status = "rejected";
      cmd.summary = "empty intent";
      return cmd;
    }
    // Store the dispatch policy on the command so tick() can replay it. Queued
    // (autonomous) drives default to safe-only — an unattended descending drive
    // must never auto-run a confirm-tier action without an explicit grant.
    QUEUED_POLICY.set(cmd.id, { mode: req.mode ?? "safe-only", scope: req.scope ?? [] });
    this.queue.push(cmd);
    this.queue.sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
    this.emitSpine(emit, "command-queued", null, persona, intent, { detail: `priority ${cmd.priority}` });
    return cmd;
  }

  /** Process up to QUEUE_PER_TICK due commands. Returns how many ran. */
  async tick(emit: SpineEmit = NOOP_EMIT): Promise<number> {
    const now = Date.now();
    let ran = 0;
    while (ran < QUEUE_PER_TICK) {
      const idx = this.queue.findIndex(
        (c) => !c.scheduledFor || Date.parse(c.scheduledFor) <= now,
      );
      if (idx < 0) break;
      const [cmd] = this.queue.splice(idx, 1);
      const policy = QUEUED_POLICY.get(cmd.id) ?? { mode: "safe-only" as AgentConfirmMode, scope: [] };
      QUEUED_POLICY.delete(cmd.id);
      try {
        await this.dispatch(
          {
            intent: cmd.intent,
            personaId: cmd.personaId,
            mode: policy.mode,
            scope: policy.scope,
            priority: cmd.priority,
            origin: cmd.origin,
          },
          emit,
        );
      } catch (err) {
        surfaceError("spine.tick", err);
      }
      ran += 1;
    }
    return ran;
  }

  // ── Public: status surface ─────────────────────────────────────────────────
  snapshot(): SpineSnapshot {
    return {
      queueDepth: this.queue.length,
      pending: this.queue.slice(0, 20),
      recent: this.recent.slice(0, 20),
      reflexes: (() => {
        try {
          return listReflexes();
        } catch {
          return [];
        }
      })(),
      personas: listPersonas(),
      tractCounts: { ...this.tractCounts },
      lastDispatchAt: this.lastDispatchAt,
    };
  }

  /** One-line health probe for the Brain Kernel module registry. */
  health(): { ok: true; detail: string } {
    const total = this.tractCounts.reflex + this.tractCounts.program + this.tractCounts.deliberate;
    return {
      ok: true,
      detail: `${total} dispatched (reflex ${this.tractCounts.reflex} · program ${this.tractCounts.program} · deliberate ${this.tractCounts.deliberate}), queue ${this.queue.length}`,
    };
  }
}

// Per-queued-command dispatch policy (mode + scope), separate from the wire
// shape so MotorCommand stays a pure status object.
const QUEUED_POLICY = new Map<string, { mode: AgentConfirmMode; scope: ActionRiskTier[] }>();

let singleton: SpinalCord | null = null;
export function getSpine(): SpinalCord {
  if (!singleton) singleton = new SpinalCord();
  return singleton;
}

export type { SpinalCord };
