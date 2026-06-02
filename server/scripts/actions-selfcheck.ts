// Permissioned command/action layer selfcheck (Phase 3). HERMETIC: a STUB
// connector stands in for the LLM (no network, no Ollama), and the DB is a
// throwaway temp file via BRAIN_DB_PATH (set BEFORE importing config-dependent
// modules). Stays I/O-free: only `recent-memories` (a pure SELECT) and
// `create-note` (a pure INSERT) are ever EXECUTED. The heavier handlers
// (search-memory → keyword scan, trigger-scan → disk walk) are proven gated /
// validated WITHOUT invoking their real I/O.
//
// Run: npm --prefix server run actions:selfcheck
//
// Asserts:
//   Resolver  — allowlist reject, arg reject, confidence floor, "none", strict
//               unknown-key reject, happy safe (no token), happy confirm (token),
//               no-connector graceful.
//   Executor  — TRUST BOUNDARY: risk derived from the registry, never the caller
//               (a confirm action submitted as if safe is still refused).
//   Tokens    — (a) confirm + no token → refused; (b) token for plan A → refused
//               for plan B (hash binding); (c) single use (replay refused).
//   Audit     — known-action attempts (success AND refusal) are logged; an
//               unknown id is NOT; a confirmed success persists its memory.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Redirect the DB to a throwaway dir BEFORE importing config-dependent modules.
const tmp = mkdtempSync(join(tmpdir(), "brain-actioncheck-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const { openDb } = await import("../src/db/sqlite.js");
const { resolveAction } = await import("../src/actions/resolver.js");
const { executeAction } = await import("../src/actions/executor.js");
const { mintConfirmToken, _resetConfirmTokens } = await import("../src/actions/confirmTokens.js");
const { listActionLog } = await import("../src/db/repositories/actions.js");
const { countMemoryPoints, getMemoryPoint } = await import("../src/db/repositories/memory.js");
const ConnectorMod = await import("../src/connectors/Connector.js");
type Connector = import("../src/connectors/Connector.js").Connector;

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

openDb(); // applies schema.sql (action_log + memory_points) + migrations

// A stub connector whose send() returns a fixed JSON string. Only send() is
// exercised by the resolver; the rest satisfy the interface.
function makeStub(json: string): Connector {
  return {
    descriptor: {
      id: "stub",
      name: "stub",
      kind: "ollama",
      enabled: true,
      state: "ok",
      createdAt: "",
      updatedAt: "",
      isLocal: true,
    },
    async listModels() {
      return [];
    },
    async send() {
      return json;
    },
    async *stream() {
      yield "";
    },
    async test() {
      return { ok: true };
    },
  } satisfies Connector;
}

// --- Resolver ---------------------------------------------------------------
{
  const r = await resolveAction("nuke it", {
    connector: makeStub(`{"actionId":"delete-everything","args":{},"confidence":0.95}`),
  });
  check("resolver rejects a non-allowlisted action", r.plan === null && /not allowlisted/.test(r.reason ?? ""), r.reason ?? "");
}
{
  const r = await resolveAction("search", {
    connector: makeStub(`{"actionId":"search-memory","args":{"query":123},"confidence":0.95}`),
  });
  check("resolver rejects invalid args (wrong type)", r.plan === null && /invalid args/.test(r.reason ?? ""), r.reason ?? "");
}
{
  const r = await resolveAction("search", {
    connector: makeStub(`{"actionId":"search-memory","args":{"query":"x","evil":"y"},"confidence":0.95}`),
  });
  check("resolver rejects unknown arg key (strict schema)", r.plan === null && /invalid args/.test(r.reason ?? ""), r.reason ?? "");
}
{
  const r = await resolveAction("maybe?", {
    connector: makeStub(`{"actionId":"search-memory","args":{"query":"x"},"confidence":0.1}`),
  });
  check("resolver rejects below the confidence floor", r.plan === null && /confidence/.test(r.reason ?? ""), r.reason ?? "");
}
{
  const r = await resolveAction("what's the weather", {
    connector: makeStub(`{"actionId":"none","confidence":0.9}`),
  });
  check('resolver returns no plan for "none"', r.plan === null && r.reason === "no matching action");
}
{
  const r = await resolveAction("find notes about the brain", {
    connector: makeStub(`{"actionId":"search-memory","args":{"query":"brain"},"rationale":"ok","confidence":0.9}`),
  });
  check(
    "resolver: valid SAFE action → plan, no confirm, no token",
    r.plan?.actionId === "search-memory" && r.needsConfirm === false && r.confirmToken === undefined,
  );
}
{
  const r = await resolveAction("note: buy milk", {
    connector: makeStub(`{"actionId":"create-note","args":{"content":"buy milk"},"confidence":0.9}`),
  });
  check(
    "resolver: valid CONFIRM action → plan, needsConfirm, token minted",
    r.plan?.actionId === "create-note" && r.needsConfirm === true && typeof r.confirmToken === "string",
  );
}
{
  const r = await resolveAction("anything", { connector: null });
  check("resolver: no connector → graceful no-plan", r.plan === null && /no connector/.test(r.reason ?? ""));
}

// --- Executor trust boundary + confirm tokens -------------------------------
_resetConfirmTokens();

{
  const r = await executeAction({ actionId: "delete-everything", args: {} });
  check("executor refuses a non-allowlisted action (403)", r.ok === false && r.status === 403);
}
{
  // The self-label-safe attack: caller submits a confirm-tier action hoping it
  // runs without a token. Executor derives the tier from the registry → refused.
  const r = await executeAction({ actionId: "create-note", args: { content: "x" } });
  check("executor: confirm-tier with NO token is refused (403)", r.ok === false && r.status === 403 && /confirmation required/.test(r.error ?? ""));
}
{
  // (b) plan-hash binding: token minted for plan A must not authorise plan B.
  const tokenForA = mintConfirmToken("create-note", { content: "A" });
  const r = await executeAction({ actionId: "create-note", args: { content: "B" }, confirmToken: tokenForA });
  check("executor: token for plan A is refused for plan B", r.ok === false && r.status === 403);
  // …and the same token must not authorise a DIFFERENT action either.
  const r2 = await executeAction({ actionId: "trigger-scan", args: {}, confirmToken: tokenForA });
  check("executor: create-note token cannot run trigger-scan", r2.ok === false && r2.status === 403);
}
{
  // (a)+(c): valid token executes ONCE; replay is refused (single use).
  const token = mintConfirmToken("create-note", { content: "keep this note" });
  const ok = await executeAction({ actionId: "create-note", args: { content: "keep this note" }, confirmToken: token });
  check("executor: confirm-tier with valid token succeeds", ok.ok === true && ok.status === 200);
  const noteId = (ok.data as { id?: string } | undefined)?.id;
  check("executor: create-note persisted a memory", typeof noteId === "string" && getMemoryPoint(noteId!) !== null);
  const replay = await executeAction({ actionId: "create-note", args: { content: "keep this note" }, confirmToken: token });
  check("executor: confirm token is single-use (replay refused)", replay.ok === false && replay.status === 403);
}
{
  // SAFE action runs with no token (pure SELECT — I/O-free, no embeddings).
  const r = await executeAction({ actionId: "recent-memories", args: {} });
  check("executor: safe action runs without a token", r.ok === true && Array.isArray(r.data));
}
{
  // Execute-time arg re-validation (defense in depth) fails BEFORE the handler
  // runs, so search-memory's keyword scan is never invoked here.
  const r = await executeAction({ actionId: "search-memory", args: { query: 123 } });
  check("executor: re-validates args at execute (400, handler not run)", r.ok === false && r.status === 400);
}

// --- OS-surface actions (Phase 3b): directive, not server execution ---------
_resetConfirmTokens();
{
  const r = await resolveAction("open my downloads folder", {
    connector: makeStub(`{"actionId":"open-path","args":{"path":"C:\\\\Users\\\\me\\\\Downloads"},"confidence":0.9}`),
  });
  check("resolver: os action → plan needs confirm + token", r.plan?.actionId === "open-path" && r.needsConfirm === true && typeof r.confirmToken === "string");

  const noToken = await executeAction({ actionId: "open-path", args: { path: "C:\\Users\\me\\Downloads" } });
  check("executor: os action without token is refused", noToken.ok === false && noToken.status === 403);

  const token = mintConfirmToken("open-path", { path: "C:\\Users\\me\\Downloads" });
  const ok = await executeAction({ actionId: "open-path", args: { path: "C:\\Users\\me\\Downloads" }, confirmToken: token });
  check("executor: os action returns an osDirective (no server handler, no OS touched)", ok.ok === true && ok.osDirective?.command === "os_open_path" && ok.osDirective?.args.path === "C:\\Users\\me\\Downloads");
}
{
  // open-url enforces http(s) at the registry; a non-http URL is rejected by zod.
  const r = await resolveAction("open the site", {
    connector: makeStub(`{"actionId":"open-url","args":{"url":"ftp://evil/x"},"confidence":0.9}`),
  });
  check("resolver: open-url rejects non-http(s) scheme", r.plan === null && /invalid args/.test(r.reason ?? ""));
}

// --- Audit completeness -----------------------------------------------------
{
  const log = listActionLog(100);
  const has = (pred: (e: (typeof log)[number]) => boolean) => log.some(pred);
  check("audit: a confirmed create-note success is logged", has((e) => e.actionId === "create-note" && e.ok && e.confirmed));
  check("audit: a refused create-note attempt is logged", has((e) => e.actionId === "create-note" && !e.ok));
  check("audit: a recent-memories success is logged (unconfirmed)", has((e) => e.actionId === "recent-memories" && e.ok && !e.confirmed));
  check("audit: an unknown action id is NOT logged", !has((e) => e.actionId === "delete-everything"));
  check("audit: the os-surface open-path is logged (confirmed)", has((e) => e.actionId === "open-path" && e.ok && e.confirmed));
  check("audit: exactly one memory was persisted (one confirmed note)", countMemoryPoints() === 1);
}

void ConnectorMod; // imported for its types only

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
