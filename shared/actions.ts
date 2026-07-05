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
  // Hybrid local+internet ("FRIDAY goes online"). web-search returns live web
  // results; research-web searches + fetches + LEARNS the top pages into memory.
  // Both egress, so both are confirm-tier and gated by LOCAL_ONLY.
  | "web-search"
  | "research-web"
  // Deep research — an iterative, multi-source, CITED investigation (Fable-style
  // /deep-research): plan sub-questions → gather local memory + egress-gated web →
  // synthesize cited findings → reflect → loop → final report (saved to memory).
  // confirm-tier (it can egress) and gated by LOCAL_ONLY exactly like research-web.
  | "deep-research"
  // GitHub project discovery — find popular repos (>1k stars) by topic and learn
  // their READMEs into memory. github-learn-repo learns ONE specific repo by
  // owner/name or URL ("add this repo to the brain"). All egress, so all are
  // confirm-tier and gated by LOCAL_ONLY (see server/src/github).
  | "github-search"
  | "github-learn"
  | "github-learn-repo"
  // System actions — "interact with the computer / do tasks". These run a Node
  // handler in the server process (same machine as the user). system-info is a
  // read-only metrics snapshot; the file ops are confirm-tier and path-guarded
  // (absolute paths only; sensitive locations like .env/.ssh are refused).
  | "system-info"
  | "list-directory"
  | "read-file"
  | "write-file"
  // Coding-mastery actions — the verify-until-correct loop's primitives. apply-patch
  // makes a guarded find/replace edit to a file; run-build / run-tests run a real
  // build/test command and return its exit code so the loop SEES failures and can
  // self-correct. All confirm-tier; run-build/run-tests spawn processes so they
  // ride ALLOW_SHELL exactly like run-command. See shared/coding.ts.
  | "apply-patch"
  | "run-build"
  | "run-tests"
  // "Do any task on the laptop" — the universal computer-control primitives. They
  // run a real child process on the user's own machine (an arbitrary shell
  // command / launching an app), so they are confirm-tier and only present in the
  // registry when ALLOW_SHELL is on (server/src/config.ts). Still fully gated:
  // every run goes through the permissioned executor (confirm token OR a granted
  // session scope) and is audited — see server/src/actions/executor.ts.
  | "run-command"
  | "launch-app"
  // Phase 3b — OS-surface actions. The server validates/gates/audits and returns
  // an osDirective; the actual OS call runs in Tauri (capability-scoped), never
  // in the headless server.
  | "open-path"
  | "open-url"
  // Git actions — clone, read, write, commit to GitHub repositories. Used by the
  // autonomous skill builder to fetch code from GitHub and create new skills.
  | "git-clone"
  | "git-list-files"
  | "git-read-file"
  | "git-write-file"
  | "git-status"
  | "git-commit"
  | "git-branches"
  | "git-checkout"
  // MCP marketplace — discover external MCP servers/tools from a registry and add
  // one at runtime. mcp-market-search is an egress READ (LOCAL_ONLY-gated);
  // mcp-market-add connects a discovered server (the spawn command is built from
  // a FIXED npx/uvx template, never caller-supplied). Both confirm-tier.
  | "mcp-market-search"
  | "mcp-market-add"
  // Daemon registry — long-running watch / schedule / event triggers. The brain
  // can register ONE allowlisted action to fire when a trigger evaluates true.
  // Confirm-tier for create/delete/pause/resume; safe for the list. The runner
  // re-derives the action's risk from the registry at fire-time, so a daemon
  // is bounded by its autonomy (ask / scope / safe-only).
  | "daemon-list"
  | "daemon-create"
  | "daemon-delete"
  | "daemon-pause"
  | "daemon-resume";

export const ACTION_IDS: ActionId[] = [
  "search-memory",
  "recent-memories",
  "create-note",
  "trigger-scan",
  "learn-url",
  "web-search",
  "research-web",
  "deep-research",
  "github-search",
  "github-learn",
  "github-learn-repo",
  "system-info",
  "list-directory",
  "read-file",
  "write-file",
  "apply-patch",
  "run-build",
  "run-tests",
  "run-command",
  "launch-app",
  "open-path",
  "open-url",
  "git-clone",
  "git-list-files",
  "git-read-file",
  "git-write-file",
  "git-status",
  "git-commit",
  "git-branches",
  "git-checkout",
  "mcp-market-search",
  "mcp-market-add",
  "daemon-list",
  "daemon-create",
  "daemon-delete",
  "daemon-pause",
  "daemon-resume",
];

// Where an action actually executes. "server" actions run a handler in the Node
// process; "os" actions return an osDirective for the Tauri renderer to invoke.
export type ActionSurface = "server" | "os";

// "safe"    = read-only / no side effects → runs without confirmation.
// "confirm" = writes or has side effects → requires a valid confirm token.
export type ActionRiskTier = "safe" | "confirm";

// How a (gated) execution was authorised — recorded in the audit trail so the
// log stays HONEST about what kind of approval actually happened:
//   "safe"          — read-only action, no approval needed.
//   "confirm-token" — a valid, plan-bound, single-use confirm token was
//                     presented (a human approved this specific plan via the
//                     confirm card).
//   "session-scope" — the autonomous agent loop ran a confirm-tier action under
//                     a risk ceiling the user granted for the whole run. This is
//                     COARSE approval, NOT per-plan — so it is deliberately NOT a
//                     confirm token, and `confirmed` stays false on its log row.
//   "none"          — the action was refused (no valid authorisation).
export type ActionAuthorization = "safe" | "confirm-token" | "session-scope" | "none";

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
  // How the action was authorised. Older rows (pre-agent-loop) have no value;
  // readers should treat a missing value as derived from `confirmed`
  // ("confirm-token" when confirmed and risk!=="safe", else "safe").
  authorizedVia?: ActionAuthorization;
  ok: boolean;
  summary: string;
  createdAt: string;
}
