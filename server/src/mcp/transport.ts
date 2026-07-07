// MCP transports — how a single MCP server connection moves JSON-RPC 2.0 messages.
//
//   stdio — spawn the server binary; messages are newline-delimited JSON on
//           stdin/stdout. Spawning a process is run-command-class power, so this
//           is gated behind CONFIG.allowShell.
//   http  — POST JSON-RPC to one endpoint ("Streamable HTTP"); the response is
//   /sse    application/json OR a text/event-stream carrying the reply. Every URL
//           is routed through isLocalUrl() under CONFIG.localOnly BEFORE any byte
//           leaves the machine — remote MCP needs LOCAL_ONLY=false.
//
// The transport is the ONLY place MCP touches the OS/network; the client + hub +
// executor never spawn or fetch directly. A test seam (__setMcpTransportOverride)
// lets the selfcheck inject a fake transport so the whole MCP path is hermetic.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { CONFIG } from "../config.js";
import { assertEgressAllowed } from "../util/network.js";
import type { McpServerConfig } from "../../../shared/mcp.js";

export class McpError extends Error {
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "McpError";
    this.code = code;
  }
}

// A live JSON-RPC channel to one MCP server.
export interface McpTransport {
  start(): Promise<void>;
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
}

export type FetchImpl = typeof fetch;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string } | null;
}

const REQUEST_TIMEOUT_MS = 30_000;

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.jsonrpc !== undefined && v.jsonrpc !== "2.0") return false;
  const idOk = v.id === undefined || typeof v.id === "number" || typeof v.id === "string" || v.id === null;
  if (!idOk) return false;
  const hasResult = "result" in v;
  const hasError = "error" in v;
  if (!hasResult && !hasError) return false;
  if (hasError && v.error !== undefined && v.error !== null && (typeof v.error !== "object" || Array.isArray(v.error))) {
    return false;
  }
  return true;
}

function validateJsonRpcResponse(value: unknown): JsonRpcResponse {
  if (!isJsonRpcResponse(value)) {
    throw new McpError("Malformed JSON-RPC response from MCP server");
  }
  return value;
}

// Minimal environment for stdio MCP servers. We do NOT pass the full parent
// environment because that leaks every secret in .env / process.env to the
// spawned server. Only platform essentials + any explicitly configured extras
// are forwarded. ponytail: if a server needs an unusual env var, add it via
// McpServerConfig.env; we intentionally do not blanket-inherit.
function buildStdioEnv(config: McpServerConfig): NodeJS.ProcessEnv {
  const allowed = new Set([
    "PATH", "PATHEXT",
    "NODE_ENV", "NODE_PATH",
    "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
    "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
    "TMPDIR", "TMP", "TEMP",
    "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES",
    "TERM", "COLORTERM",
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && allowed.has(key)) env[key] = value;
  }
  for (const [key, value] of Object.entries(config.env ?? {})) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

// ── stdio ────────────────────────────────────────────────────────────────────
function createStdioTransport(config: McpServerConfig): McpTransport {
  let child: ChildProcessWithoutNullStreams | null = null;
  let buffer = "";
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  function fail(err: Error): void {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  }

  function onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcResponse;
    try {
      msg = validateJsonRpcResponse(JSON.parse(trimmed));
    } catch {
      return; // ignore non-JSON or malformed lines (server log noise)
    }
    if (typeof msg.id !== "number") return; // notification / unrelated; client uses numeric ids
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new McpError(msg.error.message ?? "MCP error", msg.error.code));
    else p.resolve(msg.result);
  }

  return {
    async start(): Promise<void> {
      if (!CONFIG.allowShell) {
        throw new McpError("stdio MCP servers require ALLOW_SHELL=true (they spawn a process)");
      }
      if (!config.command) throw new McpError(`MCP server "${config.id}" has no command for stdio transport`);
      child = spawn(config.command, config.args ?? [], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: buildStdioEnv(config),
      });
      child.on("error", (err) => fail(new McpError(`MCP server "${config.id}" spawn failed: ${err.message}`)));
      child.on("exit", (code) => fail(new McpError(`MCP server "${config.id}" exited (code ${code ?? "?"})`)));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          onLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf("\n");
        }
      });
      // stderr is server log output; swallow it (do not crash on it).
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", () => {});
    },
    request(method: string, params?: unknown): Promise<unknown> {
      return new Promise((resolve, reject) => {
        if (!child || child.killed) {
          reject(new McpError(`MCP server "${config.id}" is not running`));
          return;
        }
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new McpError(`MCP request "${method}" timed out`));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        try {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        } catch (err) {
          pending.delete(id);
          clearTimeout(timer);
          reject(new McpError(`write to "${config.id}" failed: ${err instanceof Error ? err.message : String(err)}`));
        }
      });
    },
    async notify(method: string, params?: unknown): Promise<void> {
      if (!child || child.killed) return;
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
      } catch {
        /* best-effort */
      }
    },
    async close(): Promise<void> {
      fail(new McpError(`MCP server "${config.id}" closed`));
      try {
        child?.stdin.end();
        child?.kill();
      } catch {
        /* already gone */
      }
      child = null;
    },
  };
}

// ── http / sse ─────────────────────────────────────────────────────────────
function createHttpTransport(config: McpServerConfig, fetchImpl: FetchImpl): McpTransport {
  let nextId = 1;
  let sessionId: string | null = null;
  const url = config.url ?? "";

  // Asserts the endpoint has a URL AND is egress-allowed. Renamed from
  // assertEgressAllowed to avoid shadowing the shared helper of the same name
  // in util/network.ts — the LOCAL_ONLY decision is delegated there so the gate
  // lives in one place. This wrapper adds the no-url check the helper doesn't.
  function assertEndpointReady(): void {
    if (!url) throw new McpError(`MCP server "${config.id}" has no url for ${config.transport} transport`);
    // SAME gate as every other outbound path: under LOCAL_ONLY only loopback/
    // RFC1918 MCP endpoints are reachable. MCP is NOT a curated remote provider,
    // so there is no allowlist bypass — remote MCP needs LOCAL_ONLY=false.
    const egress = assertEgressAllowed(url, CONFIG.localOnly);
    if (!egress.ok) {
      throw new McpError(
        `MCP server "${config.id}" (${url}) is blocked: LOCAL_ONLY=true allows only local endpoints. Set LOCAL_ONLY=false for remote MCP.`,
      );
    }
  }

  // Extract a single JSON-RPC response from either a JSON body or an SSE stream.
  function parseSse(text: string): JsonRpcResponse | null {
    let last: JsonRpcResponse | null = null;
    for (const block of text.split(/\n\n/)) {
      const dataLines = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim());
      if (dataLines.length === 0) continue;
      try {
        const raw = JSON.parse(dataLines.join("\n"));
        const msg = validateJsonRpcResponse(raw);
        if (msg.result !== undefined || msg.error !== undefined) last = msg;
      } catch {
        /* skip non-JSON / malformed event */
      }
    }
    return last;
  }

  async function post(body: unknown, expectReply: boolean): Promise<JsonRpcResponse | null> {
    assertEndpointReady();
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(config.headers ?? {}),
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      // SAME redirect discipline as every other outbound path (webFetch.ts /
      // github discovery): assertEndpointReady() validated only `url`. Under
      // LOCAL_ONLY a 30x `Location` could point at a REMOTE host and the default
      // "follow" would transparently re-issue this POST (with its JSON-RPC body)
      // off-box — the exact second-hop egress the first-hop gate can't see.
      // "manual" surfaces the 3xx without contacting the target so we refuse it.
      redirect: CONFIG.localOnly ? "manual" : "follow",
    });
    // Off-box redirect refusal (LOCAL_ONLY). The target was NOT contacted.
    if (CONFIG.localOnly && (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400))) {
      throw new McpError(
        `MCP server "${config.id}" attempted an off-box redirect — refused under LOCAL_ONLY (set LOCAL_ONLY=false for remote MCP)`,
      );
    }
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new McpError(`MCP server "${config.id}" HTTP ${res.status}${t ? `: ${t.slice(0, 200)}` : ""}`, res.status);
    }
    if (!expectReply) return null;
    const ct = res.headers.get("content-type") ?? "";
    const text = await res.text();
    const raw = ct.includes("text/event-stream") ? parseSse(text) : JSON.parse(text);
    if (raw === null) return null;
    return validateJsonRpcResponse(raw);
  }

  return {
    async start(): Promise<void> {
      assertEndpointReady();
    },
    async request(method: string, params?: unknown): Promise<unknown> {
      const id = nextId++;
      const msg = await post({ jsonrpc: "2.0", id, method, params }, true);
      if (!msg) throw new McpError(`MCP server "${config.id}" returned no response for "${method}"`);
      if (msg.error) throw new McpError(msg.error.message ?? "MCP error", msg.error.code);
      return msg.result;
    },
    async notify(method: string, params?: unknown): Promise<void> {
      try {
        await post({ jsonrpc: "2.0", method, params }, false);
      } catch {
        /* best-effort */
      }
    },
    async close(): Promise<void> {
      sessionId = null;
    },
  };
}

// Test seam (hermetic selfcheck): inject a fake transport factory so the MCP path
// runs with no subprocess, socket, or network. Null = real transports.
let transportOverride: ((config: McpServerConfig) => McpTransport) | null = null;
export function __setMcpTransportOverride(fn: ((config: McpServerConfig) => McpTransport) | null): void {
  transportOverride = fn;
}

export function createTransport(config: McpServerConfig, fetchImpl: FetchImpl = fetch): McpTransport {
  if (transportOverride) return transportOverride(config);
  if (config.transport === "stdio") return createStdioTransport(config);
  return createHttpTransport(config, fetchImpl);
}
