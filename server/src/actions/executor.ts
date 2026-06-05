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
import { promises as fs } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import os from "node:os";
import { getActionDef, isAllowlisted, validateArgs } from "./registry.js";
import { consumeConfirmToken } from "./confirmTokens.js";
import { insertActionLog } from "../db/repositories/actions.js";
import { keywordSearch, listRecentMemories, upsertMemoryPoint } from "../db/repositories/memory.js";
import { fetchAndIngestUrl } from "../ingest/index.js";
import { isExcludedPath } from "../ingest/governance.js";
import { webSearch } from "../web/search.js";
import { webResearch } from "../web/research.js";
import { getDefaultConnectorInstance } from "../connectors/registry.js";
import { runScan, scanState } from "../scanner/indexer.js";
import { surfaceError } from "../util/diagnostics.js";
import type { ActionAuthorization, ActionId, ActionResult, ActionRiskTier, OsDirective } from "../../../shared/actions.js";
import {
  cloneRepo,
  listRepoFiles,
  readRepoFile,
  writeRepoFile,
  getRepoStatus,
  commitRepo,
  listBranches,
  checkoutBranch,
} from "./git.js";
import {
  isDynamicAction,
  getDynamicAction,
  getDynamicHandler,
  executeDynamicHandler,
} from "./dynamicRegistry.js";

// Filesystem actions touch the REAL machine (same box as the user), so they are
// confirm-tier and guarded here: absolute paths only, and the governance
// exclude-list (.env / .ssh / keys / credentials …) is refused outright — the
// same locations ambient ingest will never capture.
const MAX_READ_BYTES = 256 * 1024;

// A Windows UNC / network path (`\\host\share`, `//host/share`, or the extended
// `\\?\…` form). Node's fs.* on such a path opens an outbound SMB connection and
// triggers an NTLM auth handshake — a non-fetch egress channel the LOCAL_ONLY
// gate (which only sees fetch()) cannot cover. Reject before any fs call.
function isUncPath(p: string): boolean {
  return /^[\\/]{2}/.test(p);
}

// Validate + CANONICALIZE a path for the file actions. Returns the RESOLVED path
// the caller MUST use (never the raw arg): checking one path and reading another
// is a TOCTOU hole — `..` is normalized here so the exclude check and the actual
// fs call agree. Rejects relative paths, UNC/network roots, and the governance
// exclude-list. NOTE: resolve() normalizes `..` but does NOT resolve symlinks; a
// junction pre-planted into a secret dir plus a user-confirmed action is an
// accepted residual for this single-user, loopback-bound threat model.
function guardFsPath(p: string): { ok: true; path: string } | { ok: false; error: string } {
  if (!isAbsolute(p)) return { ok: false, error: "path must be absolute" };
  if (isUncPath(p)) return { ok: false, error: "refused: UNC / network paths are not allowed" };
  const resolved = resolve(p);
  if (isUncPath(resolved)) return { ok: false, error: "refused: UNC / network paths are not allowed" };
  if (isExcludedPath(resolved)) return { ok: false, error: "refused: sensitive location (.env/.ssh/keys/credentials)" };
  return { ok: true, path: resolved };
}

export interface ExecuteInput {
  actionId: string; // untrusted — re-derived against the registry
  args: unknown; // untrusted — re-validated against the registry schema
  confirmToken?: string;
  // SERVER-INTERNAL authorisation channel for the autonomous agent loop's
  // granted-session-scope mode. NOT a per-plan human approval: the user granted
  // this risk ceiling for the whole run up front, so a confirm-tier action whose
  // risk is in `allow` runs WITHOUT a confirm token and is audited honestly as
  // confirmed=false, authorizedVia="session-scope". This must NEVER be populated
  // from client-supplied request data on the per-action /api/actions/execute
  // path — only the agent loop, holding a run-scoped grant the user approved,
  // sets it. A confirm token (when present) always takes precedence.
  sessionScope?: { allow: ActionRiskTier[] };
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
  // "Search the web" — live results, no persistence. Egress gated inside
  // webSearch (LOCAL_ONLY); a blocked search returns a clear reason.
  "web-search": async (args) => {
    const query = String(args.query);
    const limit = typeof args.limit === "number" ? args.limit : 5;
    const r = await webSearch(query, { limit });
    if (!r.ok) {
      return { summary: `Couldn't search the web — ${r.reason}`, data: r };
    }
    return {
      summary: `Found ${r.results.length} web result${r.results.length === 1 ? "" : "s"} for "${query}" (via ${r.provider})`,
      data: r.results,
    };
  },
  // "Research the web" — search + read the top pages INTO memory (learn). The
  // default connector's embedder (if any) is passed so learned pages join the
  // vector index. Egress gated inside webResearch.
  "research-web": async (args) => {
    const query = String(args.query);
    const maxPages = typeof args.maxPages === "number" ? args.maxPages : undefined;
    const conn = getDefaultConnectorInstance();
    const embed = conn?.embed ? conn.embed.bind(conn) : undefined;
    const r = await webResearch(query, { limit: maxPages, embed });
    if (!r.ok) {
      return { summary: `Couldn't research "${query}" — ${r.reason}`, data: r };
    }
    const dup = r.deduped > 0 ? `, ${r.deduped} already known` : "";
    return {
      summary: `Researched "${query}" via ${r.provider} — learned ${r.ingested} new memor${r.ingested === 1 ? "y" : "ies"}${dup} from ${r.results.length} page${r.results.length === 1 ? "" : "s"}`,
      data: { provider: r.provider, ingested: r.ingested, deduped: r.deduped, results: r.results },
    };
  },
  // --- System actions --------------------------------------------------------
  "system-info": async () => {
    const cpus = os.cpus();
    const info: Record<string, unknown> = {
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      hostname: os.hostname(),
      cpuModel: cpus[0]?.model ?? "unknown",
      cpuCount: cpus.length,
      totalMemGB: Number((os.totalmem() / 2 ** 30).toFixed(2)),
      freeMemGB: Number((os.freemem() / 2 ** 30).toFixed(2)),
      loadAvg: os.loadavg().map((n) => Number(n.toFixed(2))),
      uptimeHours: Number((os.uptime() / 3600).toFixed(1)),
      homedir: os.homedir(),
    };
    let diskNote = "";
    try {
      const statfs = (fs as unknown as { statfs?: (p: string) => Promise<{ blocks: number; bsize: number; bavail: number }> }).statfs;
      if (statfs) {
        const s = await statfs(os.homedir());
        const totalGB = Number(((s.blocks * s.bsize) / 2 ** 30).toFixed(1));
        const freeGB = Number(((s.bavail * s.bsize) / 2 ** 30).toFixed(1));
        info.disk = { totalGB, freeGB };
        diskNote = `, disk ${freeGB}/${totalGB} GB free`;
      }
    } catch {
      /* disk stats are best-effort */
    }
    return {
      summary: `${info.platform}/${info.arch}, ${info.cpuCount} CPUs, ${info.freeMemGB}/${info.totalMemGB} GB RAM free${diskNote}`,
      data: info,
    };
  },
  "list-directory": async (args) => {
    const g = guardFsPath(String(args.path));
    if (!g.ok) throw new Error(g.error);
    const entries = await fs.readdir(g.path, { withFileTypes: true });
    const items = entries.slice(0, 500).map((e) => ({
      name: e.name,
      type: e.isDirectory() ? "dir" : e.isFile() ? "file" : "other",
    }));
    return {
      summary: `Listed ${items.length} item${items.length === 1 ? "" : "s"} in ${g.path}${entries.length > 500 ? " (truncated to 500)" : ""}`,
      data: items,
    };
  },
  "read-file": async (args) => {
    const g = guardFsPath(String(args.path));
    if (!g.ok) throw new Error(g.error);
    const st = await fs.stat(g.path);
    if (!st.isFile()) throw new Error("not a file");
    if (st.size > MAX_READ_BYTES) throw new Error(`file too large (${st.size} bytes > ${MAX_READ_BYTES})`);
    const text = await fs.readFile(g.path, "utf8");
    return { summary: `Read ${g.path} (${text.length} chars)`, data: { path: g.path, content: text } };
  },
  "write-file": async (args) => {
    const g = guardFsPath(String(args.path));
    if (!g.ok) throw new Error(g.error);
    const content = String(args.content);
    await fs.writeFile(g.path, content, "utf8");
    return { summary: `Wrote ${content.length} chars to ${g.path}`, data: { path: g.path, bytes: Buffer.byteLength(content, "utf8") } };
  },
  // --- Git actions -------------------------------------------------------------
  "git-clone": async (args) => {
    const url = String(args.url);
    const branch = typeof args.branch === "string" ? args.branch : undefined;
    const r = await cloneRepo(url, branch);
    if (!r.ok) throw new Error(r.error);
    return { summary: r.summary, data: r.data };
  },
  "git-list-files": async (args) => {
    const path = String(args.path);
    const r = await listRepoFiles(path);
    if (!r.ok) throw new Error(r.error);
    return { summary: r.summary, data: r.data };
  },
  "git-read-file": async (args) => {
    const path = String(args.path);
    const r = await readRepoFile(path);
    if (!r.ok) throw new Error(r.error);
    return { summary: r.summary, data: r.data };
  },
  "git-write-file": async (args) => {
    const path = String(args.path);
    const content = String(args.content);
    const r = await writeRepoFile(path, content);
    if (!r.ok) throw new Error(r.error);
    return { summary: r.summary, data: r.data };
  },
  "git-status": async (args) => {
    const path = String(args.path);
    const r = await getRepoStatus(path);
    if (!r.ok) throw new Error(r.error);
    return { summary: r.summary, data: r.data };
  },
  "git-commit": async (args) => {
    const path = String(args.path);
    const message = String(args.message);
    const push = typeof args.push === "boolean" ? args.push : false;
    const r = await commitRepo(path, message, push);
    if (!r.ok) throw new Error(r.error);
    return { summary: r.summary, data: r.data };
  },
  "git-branches": async (args) => {
    const path = String(args.path);
    const r = await listBranches(path);
    if (!r.ok) throw new Error(r.error);
    return { summary: r.summary, data: r.data };
  },
  "git-checkout": async (args) => {
    const path = String(args.path);
    const branch = String(args.branch);
    const r = await checkoutBranch(path, branch);
    if (!r.ok) throw new Error(r.error);
    return { summary: r.summary, data: r.data };
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
  // First check static registry, then dynamic registry.
  const isDynamic = isDynamicAction(input.actionId);
  const staticDef = getActionDef(input.actionId);

  if (!isDynamic && !staticDef) {
    return {
      ok: false,
      actionId: input.actionId,
      summary: "",
      error: `not allowlisted: ${input.actionId}`,
      status: 403,
    };
  }

  // Handle dynamic actions differently
  if (isDynamic) {
    const dynDef = getDynamicAction(input.actionId);
    if (!dynDef) {
      return { ok: false, actionId: input.actionId, summary: "", error: "dynamic action not found", status: 403 };
    }

    // Validate args against the dynamic schema
    const parsed = dynDef.schema.safeParse(input.args ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        actionId: input.actionId,
        summary: "",
        error: `invalid args: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        status: 400,
      };
    }

    // Confirm check for confirm-tier dynamic actions. A confirm token (per-plan
    // human approval) takes precedence; failing that, the agent loop's granted
    // session scope authorises the action when its risk is within the ceiling.
    const needsConfirm = dynDef.risk !== "safe";
    if (needsConfirm) {
      const tokenOk =
        Boolean(input.confirmToken) &&
        consumeConfirmToken(input.confirmToken as string, input.actionId, input.args as Record<string, unknown>);
      const scopeOk = !tokenOk && Boolean(input.sessionScope?.allow.includes(dynDef.risk));
      if (!tokenOk && !scopeOk) {
        return { ok: false, actionId: input.actionId, summary: "", error: "confirmation required", status: 403 };
      }
    }

    // Execute the dynamic handler
    try {
      const result = await executeDynamicHandler(input.actionId, parsed.data as Record<string, unknown>);
      return { ok: true, actionId: input.actionId, summary: result.summary, data: result.data, status: 200 };
    } catch (err) {
      return { ok: false, actionId: input.actionId, summary: "", error: err instanceof Error ? err.message : String(err), status: 500 };
    }
  }

  // Static action path (original code)
  const actionId = input.actionId as ActionId;
  const def = staticDef;
  if (!def) {
    return { ok: false, actionId, summary: "", error: "unknown action", status: 403 };
  }

  // Audit any attempt against a KNOWN (allowlisted) action — including refusals
  // — so the trail captures probing, not just successes. (A totally-unknown id
  // is rejected above and not logged, to avoid garbage-id spam.) `authorizedVia`
  // keeps the trail honest: a granted-session-scope run records confirmed=false
  // + authorizedVia="session-scope", never a forged confirm.
  const audit = (
    ok: boolean,
    confirmed: boolean,
    authorizedVia: ActionAuthorization,
    summary: string,
    loggedArgs: Record<string, unknown>,
  ): void => {
    try {
      insertActionLog({ actionId, args: loggedArgs, risk: def.risk, confirmed, authorizedVia, ok, summary });
    } catch (err) {
      surfaceError("action:auditLog", err);
    }
  };

  const validation = validateArgs(actionId, input.args);
  if (!validation.ok || !validation.args) {
    const error = `invalid args: ${validation.error}`;
    audit(false, false, "none", error, {});
    return { ok: false, actionId, summary: "", error, status: 400 };
  }
  const args = validation.args;

  // (2) CONFIRM GATE — confirm-tier requires either a valid, plan-bound,
  // single-use confirm token (a per-plan human approval), OR — for the agent
  // loop — a granted session scope whose ceiling covers this action's risk. The
  // tier comes from the registry, never from the submitted plan. A confirm
  // token always wins; session scope is the coarse, honestly-audited fallback.
  const needsConfirm = def.risk !== "safe";
  let confirmed = false;
  let authorizedVia: ActionAuthorization = needsConfirm ? "none" : "safe";
  if (needsConfirm) {
    if (input.confirmToken && consumeConfirmToken(input.confirmToken, actionId, args)) {
      confirmed = true;
      authorizedVia = "confirm-token";
    } else if (input.sessionScope?.allow.includes(def.risk)) {
      // Coarse, run-scoped grant the user approved up front. NOT a per-plan
      // approval, so confirmed stays false and the audit records the real basis.
      authorizedVia = "session-scope";
    } else {
      const error = "confirmation required (missing or invalid confirm token)";
      audit(false, false, "none", error, args);
      return { ok: false, actionId, summary: "", error, status: 403 };
    }
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
  audit(result.ok, confirmed, authorizedVia, result.ok ? result.summary : result.error ?? "", args);
  return result;
}
