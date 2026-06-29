import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../config.js";
import { createTransport, McpError, type FetchImpl } from "./transport.js";
import type { McpServerConfig } from "../../../shared/mcp.js";

// Regression guard for the egress finding: the MCP HTTP transport must apply the
// SAME redirect discipline as every other outbound path (webFetch / github
// discovery). Under LOCAL_ONLY the egress gate validates only the configured URL;
// without redirect:"manual" + a 3xx refusal, a local MCP server could 302 the
// JSON-RPC POST (with its body) off-box — the second-hop egress the first-hop
// gate can't see. fetchImpl is injected, so this is fully hermetic (no network).

const localConfig: McpServerConfig = {
  id: "test-http",
  transport: "http",
  url: "http://127.0.0.1:9999/mcp",
};

const fakeFetch = (res: Response): FetchImpl => ((async () => res) as unknown as FetchImpl);

test("http transport refuses an off-box redirect under LOCAL_ONLY (no second-hop egress)", async () => {
  const prev = CONFIG.localOnly;
  try {
    CONFIG.localOnly = true;
    const redirect = new Response(null, { status: 302, headers: { location: "http://evil.example.com/" } });
    const t = createTransport(localConfig, fakeFetch(redirect));
    await assert.rejects(
      () => t.request("tools/list"),
      (e: unknown) => {
        assert.ok(e instanceof McpError, "throws McpError");
        assert.match((e as McpError).message, /off-box redirect/i);
        return true;
      },
    );
  } finally {
    CONFIG.localOnly = prev;
  }
});

test("the redirect refusal is gated on LOCAL_ONLY (skipped when LOCAL_ONLY=false)", async () => {
  const prev = CONFIG.localOnly;
  try {
    CONFIG.localOnly = false;
    const redirect = new Response(null, { status: 302, headers: { location: "http://evil.example.com/" } });
    const t = createTransport(localConfig, fakeFetch(redirect));
    // With localOnly off, our refusal branch is skipped; the 302 falls through to
    // the generic !res.ok path (a real fetch would have transparently followed it).
    await assert.rejects(() => t.request("tools/list"), /HTTP 302/);
  } finally {
    CONFIG.localOnly = prev;
  }
});

test("http transport returns the JSON-RPC result on a direct 200", async () => {
  const prev = CONFIG.localOnly;
  try {
    CONFIG.localOnly = true;
    const ok = new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const t = createTransport(localConfig, fakeFetch(ok));
    assert.deepEqual(await t.request("tools/list"), { tools: [] });
  } finally {
    CONFIG.localOnly = prev;
  }
});

test("http transport blocks a remote endpoint URL outright under LOCAL_ONLY", async () => {
  const prev = CONFIG.localOnly;
  try {
    CONFIG.localOnly = true;
    const t = createTransport(
      { id: "remote", transport: "http", url: "http://evil.example.com/mcp" },
      fakeFetch(new Response("{}", { status: 200 })),
    );
    await assert.rejects(() => t.request("tools/list"), /blocked|LOCAL_ONLY/i);
  } finally {
    CONFIG.localOnly = prev;
  }
});
