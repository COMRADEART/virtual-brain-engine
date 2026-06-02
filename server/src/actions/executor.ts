// Action executor — the trust boundary. A client posts back { actionId, args,
// confirmToken }; NONE of it is trusted. The executor re-derives risk + the
// validation schema from the server registry by id, re-validates args, enforces
// the confirm-token gate for confirm-tier actions, runs the handler, and audits
// the attempt. The risk tier is NEVER read from the submitted plan — that's the
// attack the trust boundary closes (a caller self-labelling a confirm action
// "safe").
//
// Note on the existing `core/safety.ts` gate: that is the autonomous AGENT
// runtime's allow-all audit seam (writes `agent_audit`). User-initiated commands
// are a distinct path with a richer lifecycle (args + confirm state + result),
// so they get their own `action_log`. A future unified allowlist could merge the
// two; today this keeps the user-command trail clean and queryable.

import { createHash } from "node:crypto";
import { getActionDef, isAllowlisted, validateArgs } from "./registry.js";
import { consumeConfirmToken } from "./confirmTokens.js";
import { insertActionLog } from "../db/repositories/actions.js";
import { keywordSearch, listRecentMemories, upsertMemoryPoint } from "../db/repositories/memory.js";
import { fetchAndIngestUrl } from "../ingest/index.js";
import { runScan, scanState } from "../scanner/indexer.js";
import { surfaceError } from "../util/diagnostics.js";
import type { ActionId, ActionResult, OsDirective } from "../../../shared/actions.js";

export interface ExecuteInput {
  actionId: string; // untrusted — re-derived against the registry
  args: unknown; // untrusted — re-validated against the registry schema
  confirmToken?: string;
}

export interface ExecuteResult extends ActionResult {
  // The HTTP status the route should send. Not part of the wire body.
  status: number;
}

// Handlers run ONLY after the allowlist + arg-validation + confirm checks pass.
// Server-surface actions only — os-surface actions return an osDirective instead
// (see osDirectiveFor), so this is a Partial map.
type Handler = (args: Record<string, unknown>) => Promise<{ summary: string; data?: unknown }>;

const HANDLERS: Partial<Record<ActionId, Handler>> = {
  // Keyword search keeps this offline-capable (no embeddings required).
  "search-memory": async (args) => {
    const query = String(args.query);
    const limit = typeof args.limit === "number" ? args.limit : 8;
    const hits = keywordSearch(query, limit);
    return {
      summary: `Found ${hits.length} ${hits.length === 1 ? "memory" : "memories"} for "${query}"`,
      data: hits.map((h) => ({
        id: h.memory.id,
        title: h.memory.title,
        snippet: h.memory.content.slice(0, 200),
      })),
    };
  },
  "recent-memories": async (args) => {
    const limit = typeof args.limit === "number" ? args.limit : 10;
    const mems = listRecentMemories(limit);
    return {
      summary: `Listed ${mems.length} recent ${mems.length === 1 ? "memory" : "memories"}`,
      data: mems.map((m) => ({ id: m.id, title: m.title, snippet: m.content.slice(0, 200) })),
    };
  },
  "create-note": async (args) => {
    const content = String(args.content);
    const title = typeof args.title === "string" && args.title.length > 0 ? args.title : content.slice(0, 60);
    const mem = upsertMemoryPoint({
      sourceType: "manual",
      title,
      content,
      contentHash: createHash("sha1").update(content).digest("hex"),
      importance: 0.5,
      metadata: { source: "action:create-note" },
    });
    return { summary: `Saved note "${title}"`, data: { id: mem.id } };
  },
  "trigger-scan": async () => {
    // Fire-and-forget: runScan streams progress over the bus and can take a
    // while. We return immediately with the current scan state.
    void runScan().catch((err) => surfaceError("action:trigger-scan", err));
    return { summary: "Scan started", data: scanState() };
  },
  // "Learn from the internet". The egress gate lives inside fetchAndIngestUrl
  // (LOCAL_ONLY); a blocked fetch returns a clear reason rather than throwing,
  // so the user sees WHY (and that no traffic left the machine).
  "learn-url": async (args) => {
    const url = String(args.url);
    const r = await fetchAndIngestUrl(url);
    if (r.ingested === 0) {
      return {
        summary: r.reason ? `Couldn't learn ${url} — ${r.reason}` : `Nothing new to learn from ${url}`,
        data: r,
      };
    }
    const dup = r.deduped > 0 ? `, ${r.deduped} already known` : "";
    return {
      summary: `Learned ${r.title ?? url} — ${r.ingested} new memor${r.ingested === 1 ? "y" : "ies"}${dup}`,
      data: r,
    };
  },
};

// os-surface actions: map a validated plan to the Tauri command the client must
// invoke. The server never touches the OS — it only authorises + describes the
// op. `os_open` (src-tauri/src/os_actions.rs) uses the OS default handler, not a
// shell interpreter, so there's no command-injection surface.
function osDirectiveFor(actionId: ActionId, args: Record<string, unknown>): OsDirective {
  switch (actionId) {
    case "open-path":
      return { command: "os_open_path", args: { path: String(args.path) } };
    case "open-url":
      return { command: "os_open_url", args: { url: String(args.url) } };
    default:
      // Unreachable: only os-surface ids reach here (guarded by def.surface).
      throw new Error(`no os directive for ${actionId}`);
  }
}

export async function executeAction(input: ExecuteInput): Promise<ExecuteResult> {
  // (1) TRUST BOUNDARY — everything below is derived from the registry by id.
  if (!isAllowlisted(input.actionId)) {
    return {
      ok: false,
      actionId: input.actionId,
      summary: "",
      error: `not allowlisted: ${input.actionId}`,
      status: 403,
    };
  }
  const actionId = input.actionId; // narrowed to ActionId
  const def = getActionDef(actionId);
  if (!def) {
    return { ok: false, actionId, summary: "", error: "unknown action", status: 403 };
  }

  // Audit any attempt against a KNOWN (allowlisted) action — including refusals
  // — so the trail captures probing, not just successes. (A totally-unknown id
  // is rejected above and not logged, to avoid garbage-id spam.)
  const audit = (ok: boolean, confirmed: boolean, summary: string, loggedArgs: Record<string, unknown>): void => {
    try {
      insertActionLog({ actionId, args: loggedArgs, risk: def.risk, confirmed, ok, summary });
    } catch (err) {
      surfaceError("action:auditLog", err);
    }
  };

  const validation = validateArgs(actionId, input.args);
  if (!validation.ok || !validation.args) {
    const error = `invalid args: ${validation.error}`;
    audit(false, false, error, {});
    return { ok: false, actionId, summary: "", error, status: 400 };
  }
  const args = validation.args;

  // (2) CONFIRM GATE — confirm-tier requires a valid, plan-bound, single-use
  // token. The tier comes from the registry, never from the submitted plan.
  const needsConfirm = def.risk !== "safe";
  let confirmed = false;
  if (needsConfirm) {
    if (!input.confirmToken || !consumeConfirmToken(input.confirmToken, actionId, args)) {
      const error = "confirmation required (missing or invalid confirm token)";
      audit(false, false, error, args);
      return { ok: false, actionId, summary: "", error, status: 403 };
    }
    confirmed = true;
  }

  // (3) EXECUTE. os-surface actions don't run a server handler — they return a
  // directive for the Tauri client to invoke. The audit below records that the
  // (gated, confirmed) directive was ISSUED, not that the OS op later succeeded.
  let result: ExecuteResult;
  if (def.surface === "os") {
    try {
      const osDirective = osDirectiveFor(actionId, args);
      result = { ok: true, actionId, summary: `${def.title} — dispatched`, osDirective, status: 200 };
    } catch (err) {
      surfaceError(`action:${actionId}`, err);
      result = { ok: false, actionId, summary: "", error: err instanceof Error ? err.message : String(err), status: 500 };
    }
  } else {
    const handler = HANDLERS[actionId];
    if (!handler) {
      result = { ok: false, actionId, summary: "", error: "no handler for server action", status: 500 };
    } else {
      try {
        const out = await handler(args);
        result = { ok: true, actionId, summary: out.summary, data: out.data, status: 200 };
      } catch (err) {
        surfaceError(`action:${actionId}`, err);
        result = { ok: false, actionId, summary: "", error: err instanceof Error ? err.message : String(err), status: 500 };
      }
    }
  }

  // (4) AUDIT the outcome.
  audit(result.ok, confirmed, result.ok ? result.summary : result.error ?? "", args);
  return result;
}
