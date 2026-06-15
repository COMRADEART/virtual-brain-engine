// Shared contract for the AGENTIC LOOP — the brain's "main thinking" (an
// Odysseus-style multi-round ReAct loop, ported to TypeScript). ZERO runtime
// deps: types + small constants only, so both the Vite client and the Node
// server import it without a build step.
//
// RELATIONSHIP TO THE 7-STEP PIPELINE. The agent loop does NOT replace the
// pipeline — it sits in front of it. A fast triage router (see
// server/src/reasoning/triage.ts) sends a plain question straight to the 7-step
// pipeline (citations / ranker / learning) and a multi-step / "do X" / tool
// request into the loop. The loop can also call the pipeline as a `deep-reason`
// tool when it needs a grounded, citeable answer mid-task.
//
// SAFETY. Every tool the loop runs goes through the SAME permissioned executor
// trust boundary as a user command (allowlist + zod + confirm gate + audit;
// see server/src/actions/executor.ts). The loop never gets a side door: a
// confirm-tier action (web / file / git / scan) is handled per `confirmMode`.

import type { ActionRiskTier, OsDirective } from "./actions.js";
import type { PipelineEvent } from "./pipeline.js";
import type { VerifyOutcome } from "./coding.js";

// How the loop treats a confirm-tier action it wants to run mid-task.
//   "ask"       — pause and surface an approve/deny to the user, then resume on
//                 approval (mirrors the existing confirm-card trust boundary).
//   "scope"     — the user granted a risk ceiling for the WHOLE run up front;
//                 anything within it runs without a per-action prompt, audited
//                 honestly as authorizedVia="session-scope" (NOT a confirm
//                 token — no per-plan human approval happened).
//   "safe-only" — the loop only runs read-only "safe" actions on its own; a
//                 confirm-tier call is refused with a note (no side effects).
export type AgentConfirmMode = "ask" | "scope" | "safe-only";

export const AGENT_CONFIRM_MODES: AgentConfirmMode[] = ["ask", "scope", "safe-only"];

// Why the loop ended a turn. "paused" means it is waiting on a confirm decision
// (ask mode) — the run is resumable via POST /api/agent/confirm.
export type AgentRunStatus = "done" | "blocked" | "exhausted" | "paused" | "error";

// The agent loop's streaming event envelope. The /api/agent SSE stream ALSO
// carries bare PipelineEvent frames (so the 3D brain visualizer flashes exactly
// like /api/ask); a client discriminates the two by shape — a PipelineEvent has
// `step`, an AgentEvent has `type`.
export type AgentEventType =
  | "agent-start"
  | "round" // a new reasoning round began
  | "thought" // the model's plan/rationale for this round
  | "delta" // a streamed chunk of the final answer
  | "tool-start" // about to run a tool
  | "tool-result" // a tool finished (ok or error)
  | "confirm-request" // a confirm-tier action is paused awaiting approval (ask mode)
  | "final" // the complete final answer
  | "metrics" // end-of-run metrics
  | "error"
  | "done"; // end of stream (terminal)

export interface AgentToolEvent {
  actionId: string;
  args: Record<string, unknown>;
  risk: ActionRiskTier;
  ok?: boolean;
  summary?: string;
  error?: string;
  // How the action was authorised (audit-honest): "safe" | "confirm-token" |
  // "session-scope" | "refused".
  authorizedVia?: string;
  // os-surface actions (open-path / open-url) return a directive the Tauri
  // client invokes; forwarded so the pet can carry it out after approval.
  osDirective?: OsDirective;
}

// Emitted when the loop wants a confirm-tier action in "ask" mode. The run is
// parked server-side under `runId`; the client shows an approve/deny card and
// calls POST /api/agent/confirm to resume.
export interface AgentConfirmRequest {
  runId: string;
  actionId: string;
  title: string;
  args: Record<string, unknown>;
  rationale: string;
  risk: ActionRiskTier;
}

export interface AgentRunMetrics {
  rounds: number;
  toolCalls: number;
  status: AgentRunStatus;
  durationMs: number;
}

export interface AgentEvent {
  type: AgentEventType;
  runId: string;
  conversationId: string;
  round?: number;
  text?: string; // thought / delta / final
  tool?: AgentToolEvent;
  confirm?: AgentConfirmRequest;
  detail?: string; // error / status reason
  metrics?: AgentRunMetrics;
  // On the terminal "final" frame of a coding run that mutated files: whether the
  // result was actually verified ("passed") or not ("failed"/"unverified"). Absent
  // when the run didn't touch code. The honest core of the coding-mastery layer.
  verified?: VerifyOutcome;
  timestamp: string;
}

// A frame on the /api/agent SSE stream is either an agent event or a bare
// pipeline event (deep-reason + region flashes). Discriminate on shape.
export type AgentStreamFrame = AgentEvent | PipelineEvent;

export function isAgentEvent(frame: AgentStreamFrame): frame is AgentEvent {
  return (frame as AgentEvent).type !== undefined;
}

// POST /api/agent body.
export interface AgentRequest {
  prompt: string;
  conversationId?: string;
  // Defaults to the server's AGENT_CONFIRM_MODE config (default "ask").
  confirmMode?: AgentConfirmMode;
  // For "scope" mode only: the risk ceiling the user authorised for this run.
  // e.g. ["safe","confirm"] grants everything; omitted/empty falls back to
  // safe-only behaviour so a missing grant can never widen autonomy.
  scope?: { allow: ActionRiskTier[] };
  // Skip the triage router and force the loop (e.g. the pet's command box,
  // which is the FRIDAY "do things" surface). When false/omitted, triage may
  // route a plain question straight to the 7-step pipeline.
  forceLoop?: boolean;
}

// POST /api/agent/confirm body — approve or deny a paused confirm-tier action.
export interface AgentConfirmDecision {
  runId: string;
  approve: boolean;
  // For "scope" approvals the client can widen the run's grant going forward.
  grantScope?: { allow: ActionRiskTier[] };
}
