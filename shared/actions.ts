// Shared contract for the permissioned command/action layer (Phase 3 — "do
// stuff with the computer with commands"). ZERO runtime deps: the authoritative
// zod param schemas + the handlers live server-side (server/src/actions/*). This
// file is only types + the allowlisted id list + the risk-tier vocabulary, so
// both the Vite client and the Node server can import it without a build step.
//
// SECURITY MODEL (see server/src/actions/executor.ts for enforcement):
//   - Allowlist-only: an action is executable iff its id is in ACTION_IDS AND
//     present in the server registry. The resolver can never propose anything
//     else; the executor re-derives risk + schema from the registry by id and
//     never trusts a risk/surface field on a submitted plan.
//   - Confirm-gated: "confirm"-tier actions require a one-time, plan-bound
//     confirm token minted at resolve time and consumed at execute time.
//   - Audited: every execute attempt (success or refusal) is recorded.
// OS-touching actions (open file, launch app, …) are deliberately NOT in this
// list yet — they arrive in Phase 3b together with their Tauri-side executor.

export type ActionId =
  | "search-memory"
  | "recent-memories"
  | "create-note"
  | "trigger-scan"
  // "Learn from the internet": fetch a URL server-side and persist its readable
  // text into memory through the governed ingest pipeline. confirm-tier (it
  // egresses) and only works while LOCAL_ONLY=false — see server/src/ingest.
  | "learn-url"
  // Phase 3b — OS-surface actions. The server validates/gates/audits and returns
  // an osDirective; the actual OS call runs in Tauri (capability-scoped), never
  // in the headless server.
  | "open-path"
  | "open-url";

export const ACTION_IDS: ActionId[] = [
  "search-memory",
  "recent-memories",
  "create-note",
  "trigger-scan",
  "learn-url",
  "open-path",
  "open-url",
];

// Where an action actually executes. "server" actions run a handler in the Node
// process; "os" actions return an osDirective for the Tauri renderer to invoke.
export type ActionSurface = "server" | "os";

// "safe"    = read-only / no side effects → runs without confirmation.
// "confirm" = writes or has side effects → requires a valid confirm token.
export type ActionRiskTier = "safe" | "confirm";

export interface ActionSpec {
  id: ActionId;
  title: string;
  description: string;
  risk: ActionRiskTier;
  surface: ActionSurface;
  // Human-readable description of each parameter, for the UI + the resolver
  // prompt. The authoritative validation schema is server-side (zod).
  params: Record<string, string>;
}

// What the client must invoke (a named Tauri command + its args) to carry out
// an os-surface action. The server never performs the OS op itself.
export interface OsDirective {
  command: string;
  args: Record<string, unknown>;
}

export interface ActionPlan {
  actionId: ActionId;
  args: Record<string, unknown>;
  rationale: string;
  confidence: number;
}

export interface ActionResolveResult {
  plan: ActionPlan | null;
  // Present (and required at execute time) only for confirm-tier plans.
  confirmToken?: string;
  needsConfirm: boolean;
  // Why no plan was produced (no-match, below confidence floor, not
  // allowlisted, invalid args, no connector). Null when plan is non-null.
  reason: string | null;
}

export interface ActionResult {
  ok: boolean;
  // Echoes the attempted id verbatim — a string, not ActionId, because a
  // refused/non-allowlisted attempt is still reported back.
  actionId: string;
  summary: string;
  data?: unknown;
  error?: string;
  // Present for os-surface actions: the client invokes this Tauri command to
  // carry out the (already validated, confirmed, and audited) OS operation.
  osDirective?: OsDirective;
}

export interface ActionLogEntry {
  id: string;
  actionId: string;
  args: Record<string, unknown>;
  risk: ActionRiskTier;
  confirmed: boolean;
  ok: boolean;
  summary: string;
  createdAt: string;
}
