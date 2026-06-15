// Shared contract for the MCP (Model Context Protocol) CLIENT — the brain's
// connection to external MCP tool servers, reachable via the spine's deliberate
// tract. ZERO runtime deps: types + pure helpers + example presets only, so both
// the Vite client and the Node server import it without a build step.
//
// SECURITY MODEL (enforced server-side, see server/src/mcp + actions/executor.ts):
// MCP gets NO side door. Each discovered MCP tool is registered as a DYNAMIC
// action and called ONLY through executeAction — the same allowlist + zod + confirm/
// scope gate + audit as every other effector. MCP tools default to CONFIRM tier
// (so reflex/program tracts can never fire them and the deliberate tract gates
// them by the run's confirmMode). HTTP/SSE egress is gated by LOCAL_ONLY exactly
// like every other outbound path; stdio (spawning a server binary) is gated by
// ALLOW_SHELL. MCP is OFF by default (opt-in).

import type { ActionRiskTier } from "./actions.js";

// ── Transports ───────────────────────────────────────────────────────────────
//   stdio — spawn a local server process; JSON-RPC over newline-delimited stdio.
//   http  — POST JSON-RPC to a single endpoint (MCP "Streamable HTTP"); the
//           response is application/json OR a text/event-stream carrying the reply.
//   sse   — same POST client; used for servers whose HTTP response is SSE-framed.
export type McpTransportKind = "stdio" | "http" | "sse";

export const MCP_TRANSPORT_KINDS: McpTransportKind[] = ["stdio", "http", "sse"];

export interface McpServerConfig {
  /** Short, stable id ([a-z0-9-]) used to namespace this server's tools. */
  id: string;
  transport: McpTransportKind;
  /** stdio: the executable to spawn (e.g. "npx", "uvx"). */
  command?: string;
  /** stdio: arguments for the executable. */
  args?: string[];
  /** http/sse: the JSON-RPC endpoint URL. */
  url?: string;
  /** http/sse: extra request headers (auth tokens — sourced from env, NEVER persisted). */
  headers?: Record<string, string>;
  /** Whether to connect this server on hub start. Presets ship disabled. */
  enabled?: boolean;
  /**
   * Per-server risk ceiling for its tools. Defaults to "confirm" — every MCP tool
   * needs approval/scope. Only set "safe" for a server whose tools are provably
   * read-only with no egress (it would then run autonomously and be reflex-eligible).
   */
  risk?: ActionRiskTier;
}

// A minimal JSON-Schema shape (MCP tool inputSchema). Loosely typed on purpose —
// the converter only reads top-level type/properties/required.
export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  description?: string;
  enum?: unknown[];
  [k: string]: unknown;
}

export interface McpToolDef {
  /** The server id this tool came from. */
  server: string;
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface McpToolResult {
  ok: boolean;
  /** Flattened text content of the tool result (what the loop sees). */
  content: string;
  /** Raw structured result, if any. */
  data?: unknown;
  error?: string;
}

export interface McpServerStatus {
  id: string;
  transport: McpTransportKind;
  connected: boolean;
  toolCount: number;
  error?: string;
}

export interface McpHubSnapshot {
  enabled: boolean;
  servers: McpServerStatus[];
  tools: Array<{ id: string; server: string; name: string; description: string; risk: ActionRiskTier }>;
}

// Rides BrainBusMessage as { type: "mcp" }.
export type McpEventKind = "connected" | "disconnected" | "tool-registered" | "tool-call" | "error";

export interface McpEvent {
  kind: McpEventKind;
  server?: string;
  tool?: string;
  detail?: string;
  at: string;
}

// Deterministic action-id for an MCP tool: `mcp-<server>-<tool>` (lowercased,
// non-id chars collapsed to dashes). Starts with a letter so it satisfies the
// dynamic-registry id rule.
export function mcpActionId(server: string, tool: string): string {
  return `mcp-${slug(server)}-${slug(tool)}`;
}

function slug(s: string): string {
  const out = String(s).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return out.length > 0 ? out : "x";
}

// Example server configs the user can enable (all DISABLED by default). They are
// starting points — the user supplies the concrete <DIR>/<REPO> and ensures the
// runtime (npx for the Node servers, uvx for the Python ones) is installed. The
// hub merges these (disabled) with whatever MCP_SERVERS provides.
export const MCP_PRESETS: McpServerConfig[] = [
  {
    id: "filesystem",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "<DIR>"],
    enabled: false,
    risk: "confirm",
  },
  {
    id: "git",
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-git", "--repository", "<REPO>"],
    enabled: false,
    risk: "confirm",
  },
  {
    id: "fetch",
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-fetch"],
    enabled: false,
    risk: "confirm",
  },
];
