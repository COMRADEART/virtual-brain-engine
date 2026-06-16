// MCP marketplace selfcheck — hermetic (throwaway DB via BRAIN_DB_PATH, an
// INJECTED fetch so NO network, an INJECTED transport so NO subprocess/socket).
// Run: npm --prefix server run mcpmarket:selfcheck
//
// Asserts:
//   (A) PURE parse: the registry shape (servers[] with packages/remotes, the
//       `server` wrapper, field-name drift) → McpMarketEntry; npm→stdio/npx,
//       pypi→stdio/uvx, remote→http; entryMatches; marketEntryToConfig template;
//       isValidPackageName rejects flag/space injection.
//   (B) EGRESS GATE: searchMarket under LOCAL_ONLY=true is blocked BEFORE fetch
//       (call counter stays 0) with a LOCAL_ONLY reason.
//   (C) HOST PIN + redirect: a non-https registry is refused; a 3xx is refused —
//       both without reading a body.
//   (D) SEARCH happy path: LOCAL_ONLY=false + canned registry → entries parsed +
//       filtered; fetch called exactly once; discovery NEVER auto-connects.
//   (E) RUNTIME ADD trust boundary: mcp-market-add (through executeAction) builds
//       the config from the FIXED npx/uvx template, connects via the injected
//       transport, and the new tool dispatches through executeAction; a raw
//       `command` arg is rejected (strict schema); a bad package can't build a
//       config; the mcpEnabled gate holds; the connect is audited.
//   (F) PERSISTENCE: an added server is remembered in brain_metadata.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Deterministic config BEFORE importing config (dotenv won't override a set var).
process.env.LOCAL_ONLY = "true";
process.env.ALLOW_SHELL = "true";
process.env.MCP_ENABLED = "true";
process.env.MCP_SERVERS = "";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

const tmp = mkdtempSync(join(tmpdir(), "brain-mcpmarket-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const { CONFIG } = await import("../src/config.js");
const market = await import("../src/mcp/market.js");
const sharedMcp = await import("../../shared/mcp.js");
const { __setMcpTransportOverride } = await import("../src/mcp/transport.js");
import type { McpTransport } from "../src/mcp/transport.js";
const { getMcpHub, __resetMcpHub } = await import("../src/mcp/hub.js");
const { executeAction } = await import("../src/actions/executor.js");
const { isDynamicAction, getDynamicAction } = await import("../src/actions/dynamicRegistry.js");
const { mintConfirmToken } = await import("../src/actions/confirmTokens.js");
const { openDb } = await import("../src/db/sqlite.js");

const db = openDb();
const REGISTRY = "registry.modelcontextprotocol.io";
const REGISTRY_URL = `https://${REGISTRY}`;

// Canned registry page covering: npm package, pypi package, a remote endpoint,
// the v0 `{server:{...}}` wrapper, and a junk row (no connectable target).
const REGISTRY_PAYLOAD = {
  servers: [
    { name: "io.github.acme/files", description: "filesystem tools", packages: [{ registryType: "npm", identifier: "@acme/mcp-files" }] },
    { name: "io.github.acme/pydata", description: "python data tools", packages: [{ registry_name: "pypi", name: "mcp-pydata" }] },
    { server: { name: "io.github.acme/remote", description: "a remote browser server", remotes: [{ type: "streamable-http", url: "https://acme.example.com/mcp" }] } },
    { name: "io.github.acme/empty", description: "nothing connectable" },
  ],
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

// -----------------------------------------------------------------------------
// (A) PURE parse + template.
// -----------------------------------------------------------------------------
{
  const entries = market.parseRegistryServers(JSON.stringify(REGISTRY_PAYLOAD), REGISTRY);
  check("(A) parses npm/pypi/remote + the server-wrapper, drops the junk row", entries.length === 3, `n=${entries.length}`);
  const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
  check("(A) npm package → stdio entry", byId["files"]?.transport === "stdio" && byId["files"]?.packageRegistry === "npm" && byId["files"]?.package === "@acme/mcp-files");
  check("(A) pypi package → stdio entry", byId["pydata"]?.packageRegistry === "pypi" && byId["pydata"]?.package === "mcp-pydata");
  check("(A) remote → http entry", byId["remote"]?.transport === "http" && byId["remote"]?.url === "https://acme.example.com/mcp");

  // marketEntryToConfig — the FIXED spawn template.
  const npmCfg = sharedMcp.marketEntryToConfig(byId["files"]);
  check("(A) npm entry → `npx -y <pkg>` (fixed template)", npmCfg?.command === "npx" && JSON.stringify(npmCfg?.args) === JSON.stringify(["-y", "@acme/mcp-files"]) && npmCfg?.risk === "confirm" && npmCfg?.enabled === false);
  const pypiCfg = sharedMcp.marketEntryToConfig(byId["pydata"]);
  check("(A) pypi entry → `uvx <pkg>`", pypiCfg?.command === "uvx" && JSON.stringify(pypiCfg?.args) === JSON.stringify(["mcp-pydata"]));
  const httpCfg = sharedMcp.marketEntryToConfig(byId["remote"]);
  check("(A) remote entry → http config with the url", httpCfg?.transport === "http" && httpCfg?.url === "https://acme.example.com/mcp");

  // Injection-proofing: a package name with a flag/space can never build a config.
  check("(A) injection package name rejected by isValidPackageName", sharedMcp.isValidPackageName("evil --rm", "npm") === false && sharedMcp.isValidPackageName("a b", "pypi") === false);
  const evil = sharedMcp.marketEntryToConfig({ id: "x", name: "x", description: "", source: "m", transport: "stdio", package: "evil; rm -rf /", packageRegistry: "npm" });
  check("(A) marketEntryToConfig refuses a malicious package", evil === null);
  const noUrl = sharedMcp.marketEntryToConfig({ id: "x", name: "x", description: "", source: "m", transport: "http" });
  check("(A) marketEntryToConfig refuses a urless remote", noUrl === null);
  const badScheme = sharedMcp.marketEntryToConfig({ id: "x", name: "x", description: "", source: "m", transport: "http", url: "file:///etc/passwd" });
  check("(A) marketEntryToConfig refuses a non-http(s) remote url", badScheme === null);

  check("(A) entryMatches filters by query terms", market.entryMatches(byId["files"], "filesystem") === true && market.entryMatches(byId["files"], "postgres") === false);
}

// -----------------------------------------------------------------------------
// (B) EGRESS GATE — blocked BEFORE fetch under LOCAL_ONLY.
// -----------------------------------------------------------------------------
{
  let calls = 0;
  const countingFetch = (async () => {
    calls += 1;
    return jsonResponse(REGISTRY_PAYLOAD);
  }) as unknown as typeof fetch;
  const r = await market.searchMarket("files", { localOnly: true, registryUrl: REGISTRY_URL, fetchImpl: countingFetch });
  check("(B) LOCAL_ONLY blocks the market search", r.ok === false && /local_only|blocked/i.test(("reason" in r ? r.reason : "")));
  check("(B) blocked BEFORE any fetch (zero outbound)", calls === 0, `calls=${calls}`);
}

// -----------------------------------------------------------------------------
// (C) HOST PIN + redirect refusal.
// -----------------------------------------------------------------------------
{
  let calls = 0;
  const countingFetch = (async () => {
    calls += 1;
    return jsonResponse(REGISTRY_PAYLOAD);
  }) as unknown as typeof fetch;
  // Non-https registry → the host pin refuses before fetch.
  const insecure = await market.searchMarket("files", { localOnly: false, registryUrl: "http://registry.modelcontextprotocol.io", fetchImpl: countingFetch });
  check("(C) a non-https registry is refused by the host pin", insecure.ok === false && calls === 0);

  // A 3xx response is refused (a Location could move us off the pinned host).
  const redirectFetch = (async () => new Response(null, { status: 302 })) as unknown as typeof fetch;
  const redir = await market.searchMarket("files", { localOnly: false, registryUrl: REGISTRY_URL, fetchImpl: redirectFetch });
  check("(C) a registry redirect (3xx) is refused", redir.ok === false && /redirect/i.test(("reason" in redir ? redir.reason : "")));
}

// -----------------------------------------------------------------------------
// (D) SEARCH happy path + discovery never auto-connects.
// -----------------------------------------------------------------------------
__setMcpTransportOverride((config) => fakeTransport(config.id));
__resetMcpHub();
{
  let calls = 0;
  const okFetch = (async () => {
    calls += 1;
    return jsonResponse(REGISTRY_PAYLOAD);
  }) as unknown as typeof fetch;
  const r = await market.searchMarket("acme", { localOnly: false, registryUrl: REGISTRY_URL, fetchImpl: okFetch });
  check("(D) search returns parsed entries when egress is allowed", r.ok === true && "entries" in r && r.entries.length === 3, JSON.stringify(r));
  check("(D) exactly one registry fetch", calls === 1, `calls=${calls}`);
  check("(D) discovery NEVER auto-connects a server", getMcpHub().snapshot().servers.length === 0);
}

// -----------------------------------------------------------------------------
// (E) RUNTIME ADD trust boundary (through executeAction).
// -----------------------------------------------------------------------------
function fakeTransport(serverId: string): McpTransport {
  return {
    async start() {},
    async request(method: string, params?: unknown) {
      if (method === "initialize") return { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: serverId } };
      if (method === "tools/list") {
        return { tools: [{ name: "echo", description: "echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] };
      }
      if (method === "tools/call") {
        const p = params as { arguments?: { text?: string } };
        return { content: [{ type: "text", text: `echoed: ${p?.arguments?.text ?? ""}` }] };
      }
      throw new Error(`unknown method ${method}`);
    },
    async notify() {},
    async close() {},
  };
}
{
  const addArgs = { id: "files", transport: "stdio", package: "@acme/mcp-files", registry: "npm" };
  const token = mintConfirmToken("mcp-market-add", addArgs);
  const added = await executeAction({ actionId: "mcp-market-add", args: addArgs, confirmToken: token });
  check("(E) mcp-market-add connects a discovered server", added.ok === true && /Added MCP server "files"/.test(added.summary), JSON.stringify(added));
  check("(E) the added server's tool is registered as a confirm-tier dynamic action", isDynamicAction("mcp-files-echo") && getDynamicAction("mcp-files-echo")?.risk === "confirm");

  // The new tool dispatches through executeAction like every effector.
  const toolToken = mintConfirmToken("mcp-files-echo", { text: "hi" });
  const ran = await executeAction({ actionId: "mcp-files-echo", args: { text: "hi" }, confirmToken: toolToken });
  check("(E) the discovered tool runs through executeAction", ran.ok === true && /echoed: hi/.test(ran.summary));

  // A raw `command` arg is rejected by the strict schema (no command side door).
  const evilArgs = { id: "x", transport: "stdio", package: "@acme/mcp-files", registry: "npm", command: "rm" };
  const evilToken = mintConfirmToken("mcp-market-add", evilArgs);
  const evil = await executeAction({ actionId: "mcp-market-add", args: evilArgs, confirmToken: evilToken });
  check("(E) a raw `command` arg is rejected (strict schema, no side door)", evil.ok === false && evil.status === 400);

  // A bad package name can't build a config (defense in depth).
  const badArgs = { id: "bad", transport: "stdio", package: "evil; rm -rf", registry: "npm" };
  const badToken = mintConfirmToken("mcp-market-add", badArgs);
  const bad = await executeAction({ actionId: "mcp-market-add", args: badArgs, confirmToken: badToken });
  check("(E) a malicious package name builds no config", bad.ok === true && /Couldn't build a valid MCP server config/.test(bad.summary));

  // The mcpEnabled master gate holds.
  CONFIG.mcpEnabled = false;
  const gateArgs = { id: "files2", transport: "stdio", package: "@acme/mcp-files", registry: "npm" };
  const gateToken = mintConfirmToken("mcp-market-add", gateArgs);
  const gated = await executeAction({ actionId: "mcp-market-add", args: gateArgs, confirmToken: gateToken });
  check("(E) mcp-market-add refuses when MCP is disabled", /MCP is disabled/.test(gated.summary));
  CONFIG.mcpEnabled = true;

  // The connect was audited (confirm-token).
  const rows = db
    .prepare("SELECT ok, authorized_via FROM action_log WHERE action_id = 'mcp-market-add' ORDER BY created_at")
    .all() as Array<{ ok: number; authorized_via: string }>;
  check("(E) every mcp-market-add attempt is audited", rows.length >= 3, `rows=${rows.length}`);
  check("(E) a successful add audits as confirm-token", rows.some((r) => r.ok === 1 && r.authorized_via === "confirm-token"));
}

// -----------------------------------------------------------------------------
// (F) PERSISTENCE — the added server is remembered for next boot.
// -----------------------------------------------------------------------------
{
  const row = db.prepare("SELECT value FROM brain_metadata WHERE key = 'mcp-added-servers-v1'").get() as { value: string } | undefined;
  const list = row ? (JSON.parse(row.value) as Array<{ id: string; command?: string }>) : [];
  check("(F) the added server is persisted", list.some((c) => c.id === "files" && c.command === "npx"), JSON.stringify(list));
}

await getMcpHub().stop();
__setMcpTransportOverride(null);

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
