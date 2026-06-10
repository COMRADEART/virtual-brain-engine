// Confirm-card summarizer. The agent loop pauses on a confirm-tier action with
// an AgentConfirmRequest carrying { actionId, args, risk }. The old card showed
// only the rationale + title, so the user approved write-file / learn-url (web
// egress) / git / scan BLIND to WHAT it would touch — a real trust-boundary
// gap, not cosmetics. This pure helper turns the request into a one-line human
// scope ("will write to C:\…", "will fetch https://…") so approval is informed.
//
// Pure + dependency-light so it unit-tests across every confirm-tier action
// shape in the registry (server/src/actions/registry.ts).

import type { ActionRiskTier } from "../../../shared/actions";

export interface ConfirmScope {
  /** One-line human description of what the action will do, scoped to its args. */
  detail: string;
  /** Short risk badge text. */
  riskLabel: string;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function clip(s: string, n = 64): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * Map an action id + args to a one-line scope. Falls back to a generic args
 * preview for any action whose specific shape isn't special-cased, so an action
 * added to the registry later still renders something useful rather than blank.
 */
export function summarizeConfirm(actionId: string, args: Record<string, unknown>): string {
  const path = str(args.path);
  const url = str(args.url);
  const query = str(args.query);

  switch (actionId) {
    case "write-file":
    case "git-write-file":
      return path ? `will WRITE to ${clip(path)}` : "will write a file";
    case "read-file":
    case "git-read-file":
      return path ? `will read ${clip(path)}` : "will read a file";
    case "list-directory":
    case "git-list-files":
    case "git-status":
    case "git-branches":
      return path ? `will read ${clip(path)}` : "will list a folder";
    case "open-path":
      return path ? `will OPEN ${clip(path)} with its default app` : "will open a file/folder";
    case "open-url":
      return url ? `will OPEN ${clip(url)} in your browser` : "will open a URL";
    case "learn-url":
      return url ? `will FETCH ${clip(url)} and learn it (web egress)` : "will fetch a web page";
    case "web-search":
      return query ? `will SEARCH the web for "${clip(query, 48)}" (web egress)` : "will search the web";
    case "research-web":
      return query ? `will RESEARCH "${clip(query, 48)}" and learn the pages (web egress)` : "will research the web";
    case "github-search":
      return query ? `will SEARCH GitHub for "${clip(query, 48)}" (web egress)` : "will search GitHub";
    case "github-learn":
      return query ? `will LEARN popular GitHub repos for "${clip(query, 48)}" (web egress)` : "will learn from GitHub";
    case "git-clone":
      return url ? `will CLONE ${clip(url)}` : "will clone a repository";
    case "git-commit": {
      const msg = str(args.message);
      const push = args.push === true ? " and PUSH" : "";
      return path ? `will COMMIT in ${clip(path, 40)}${push}${msg ? ` — "${clip(msg, 40)}"` : ""}` : "will commit changes";
    }
    case "git-checkout": {
      const branch = str(args.branch);
      return branch ? `will CHECKOUT branch ${clip(branch, 40)}` : "will checkout a branch";
    }
    case "trigger-scan":
      return "will SCAN your configured folders into memory";
    case "create-note": {
      const title = str(args.title);
      return title ? `will SAVE a note "${clip(title, 48)}"` : "will save a note to memory";
    }
    default: {
      // Generic fallback: surface the most salient string arg, if any.
      const salient = path ?? url ?? query ?? null;
      return salient ? `${actionId}: ${clip(salient)}` : `run ${actionId}`;
    }
  }
}

const RISK_LABEL: Record<ActionRiskTier, string> = {
  safe: "safe",
  confirm: "needs approval",
};

export function confirmScope(
  actionId: string,
  args: Record<string, unknown>,
  risk: ActionRiskTier,
): ConfirmScope {
  return { detail: summarizeConfirm(actionId, args), riskLabel: RISK_LABEL[risk] ?? risk };
}
