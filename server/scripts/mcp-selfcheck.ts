// MCP client selfcheck — hermetic (throwaway DB via BRAIN_DB_PATH, an INJECTED
// fake transport so NO subprocess spawns and NO socket/network opens). Run:
//   npm --prefix server run mcp:selfcheck
//
// Asserts:
//   (A) EGRESS GATE — a remote http MCP endpoint is blocked under LOCAL_ONLY=true
//       with a clear reason; a loopback endpoint passes; stdio requires ALLOW_SHELL.
//   (B) CLIENT — initialize + tools/list + tools/call round-trip over a transport.
//   (C) REGISTRATION — the hub connects a server and registers each tool as a
//       confirm-tier DYNAMIC action carrying an mcp:{server,tool} descriptor; the
//       schema is derived from the tool's JSON-Schema (required arg enforced).
//   (D) TRUST BOUNDARY — an MCP tool runs ONLY through executeAction: a confirm
//       token authorises (audited confirm-token), a session scope authorises
//       (audited session-scope), a missing-arg call is refused 400, and a no-auth
//       call is refused 403 — and EVERY attempt (incl. refusals) is AUDITED in
//       action_log (closing the dynamic-branch audit gap).
//   (E) SNAPSHOT + teardown — snapshot shape; stop()/clearMcpActions removes them.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Force a deterministic, local-only, shell-enabled config BEFORE importing config
// (dotenv does not override an already-set process.env var).
process.env.LOCAL_ONLY = "true";
process.env.ALLOW_SHELL = "true";
process.env.MCP_ENABLED = "true";
process.env.MCP_SERVERS = JSON.stringify([{ id: "test", transport: "stdio", command: "x" }]);

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

const tmp = mkdtempSync(join(tmpdir(), "brain-mcp-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const { CONFIG } = await import("../src/config.js");
const { createTransport, __setMcpTransportOverride } = await import("../src/mcp/transport.js");
import type { McpTransport } from "../src/mcp/transport.js";
const { McpClient } = await import("../src/mcp/client.js");
const { getMcpHub, __resetMcpHub } = await import("../src/mcp/hub.js");
const { executeAction } = await import("../src/actions/executor.js");
const { getDynamicAction, isDynamicAction, clearMcpActions } = await import("../src/actions/dynamicRegistry.js");
const { mintConfirmToken } = await import("../src/actions/confirmTokens.js");
const { openDb } = await import("../src/db/sqlite.js");

const db = openDb();

// A fully in-memory MCP transport: answers the three JSON-RPC methods with canned
// results. No process, no socket — the whole MCP path becomes hermetic.
function fakeTransport(serverId: string): McpTransport {
  return {
    async start() {},
    async request(method: string, params?: unknown) {
      if (method === "initialize") return { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: serverId } };
      if (method === "tools/list") {
        return {
          tools: [
            {
              name: "echo",
              description: "echo text back",
              inputSchema: { type: "object", properties: { text: { type: "string", description: "text to echo" } }, required: ["text"] },
            },
          ],
        };
      }
      if (method === "tools/call") {
        const p = params as { name?: string; arguments?: { text?: string } };
        return { content: [{ type: "text", text: `echoed: ${p?.arguments?.text ?? ""}` }] };
      }
      throw new Error(`unknown method ${method}`);
    },
    async notify() {},
    async close() {},
  };
}

// -----------------------------------------------------------------------------
// (A) EGRESS GATE (real transports, override OFF).
// -----------------------------------------------------------------------------
{
  const remote = createTransport({ id: "remote", transport: "http", url: "https://mcp.evil.example.com/rpc" });
  let blocked = false;
  try {
    await remote.start();
  } catch (e) {
    blocked = e instanceof Error && /local_only|blocked|local/i.test(e.message);
  }
  check("(A) remote http MCP endpoint blocked under LOCAL_ONLY=true", blocked);

  const local = createTransport({ id: "local", transport: "http", url: "http://127.0.0.1:9/rpc" });
  let localOk = true;
  try {
    await local.start();
  } catch {
    localOk = false;
  }
  check("(A) loopback http MCP endpoint passes the egress gate", localOk);

  // stdio requires ALLOW_SHELL — toggle the live flag and prove the gate.
  CONFIG.allowShell = false;
  const stdio = createTransport({ id: "s", transport: "stdio", command: "x" });
  let shellBlocked = false;
  try {
    await stdio.start();
  } catch (e) {
    shellBlocked = e instanceof Error && /allow_shell|shell/i.test(e.message);
  }
  check("(A) stdio MCP requires ALLOW_SHELL", shellBlocked);
  CONFIG.allowShell = true;
}

// -----------------------------------------------------------------------------
// (B) CLIENT round-trip over a transport.
// -----------------------------------------------------------------------------
{
  const client = new McpClient("direct", fakeTransport("direct"));
  await client.initialize();
  const tools = await client.listTools();
  check("(B) listTools returns the server's tools", tools.length === 1 && tools[0].name === "echo");
  const r = await client.callTool("echo", { text: "hi" });
  check("(B) callTool round-trips the result text", r.ok && /echoed: hi/.test(r.content), JSON.stringify(r));
}

// -----------------------------------------------------------------------------
// (C) HUB connect → tools registered as confirm-tier dynamic actions.
// -----------------------------------------------------------------------------
__setMcpTransportOverride((config) => fakeTransport(config.id));
__resetMcpHub();
const hub = getMcpHub();
await hub.start();
{
  check("(C) MCP tool registered as a dynamic action", isDynamicAction("mcp-test-echo"));
  const def = getDynamicAction("mcp-test-echo");
  check("(C) defaults to confirm-tier", def?.risk === "confirm");
  check("(C) carries the mcp descriptor", def?.mcp?.server === "test" && def?.mcp?.tool === "echo");
  check("(C) schema is server-surface", def?.surface === "server");
}

// -----------------------------------------------------------------------------
// (D) TRUST BOUNDARY — every MCP call goes through executeAction + is AUDITED.
// -----------------------------------------------------------------------------
function auditRows(): Array<{ ok: number; authorized_via: string }> {
  return db
    .prepare("SELECT ok, authorized_via FROM action_log WHERE action_id = 'mcp-test-echo' ORDER BY created_at")
    .all() as Array<{ ok: number; authorized_via: string }>;
}
{
  // session-scope authorises (agent-loop channel) and is audited honestly.
  const scoped = await executeAction({ actionId: "mcp-test-echo", args: { text: "scope" }, sessionScope: { allow: ["confirm"] } });
  check("(D) session-scope authorises the MCP call", scoped.ok && /echoed: scope/.test(scoped.summary), JSON.stringify(scoped));

  // missing required arg → 400, audited.
  const bad = await executeAction({ actionId: "mcp-test-echo", args: {}, sessionScope: { allow: ["confirm"] } });
  check("(D) missing required arg refused 400", bad.ok === false && bad.status === 400);

  // no auth → 403 refusal, audited.
  const denied = await executeAction({ actionId: "mcp-test-echo", args: { text: "x" } });
  check("(D) confirm-tier MCP tool refused without auth (403)", denied.ok === false && denied.status === 403);

  // a plan-bound confirm token authorises and audits as confirm-token.
  const token = mintConfirmToken("mcp-test-echo", { text: "tok" });
  const tokenRun = await executeAction({ actionId: "mcp-test-echo", args: { text: "tok" }, confirmToken: token });
  check("(D) confirm token authorises the MCP call", tokenRun.ok && /echoed: tok/.test(tokenRun.summary));

  const rows = auditRows();
  check("(D) AUDIT PARITY — every attempt logged (incl. refusals)", rows.length === 4, `rows=${rows.length}`);
  check("(D) honest authorizedVia: session-scope present", rows.some((r) => r.authorized_via === "session-scope"));
  check("(D) honest authorizedVia: confirm-token present", rows.some((r) => r.authorized_via === "confirm-token"));
  check("(D) refusals recorded as ok=0 / authorized_via='none'", rows.filter((r) => r.ok === 0 && r.authorized_via === "none").length === 2);
}

// -----------------------------------------------------------------------------
// (E) SNAPSHOT shape + teardown.
// -----------------------------------------------------------------------------
{
  const snap = hub.snapshot();
  check("(E) snapshot exposes servers + tools", snap.servers.length === 1 && snap.tools.length === 1 && snap.tools[0].id === "mcp-test-echo");
  check("(E) health reports connected", hub.health().ok === true);
  const removed = clearMcpActions();
  check("(E) clearMcpActions removes the registered MCP tools", removed === 1 && !isDynamicAction("mcp-test-echo"));
  await hub.stop();
  __setMcpTransportOverride(null);
}

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
