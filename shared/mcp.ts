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
// ── Marketplace (registry discovery) ─────────────────────────────────────────
// "Wire the MCP market to the brain": search a public MCP registry to FIND
// servers (and the tools/skills they bring), then add one at runtime. Discovery
// is an egress READ gated by LOCAL_ONLY exactly like web/GitHub discovery;
// ADDING a server is a confirm-tier action and the spawn command is built from
// the FIXED template below (never a caller-supplied raw command), so the market
// can never become an arbitrary-command side door.

/** The official MCP registry. Overridable via MCP_REGISTRY_URL (must be one host). */
export const MCP_REGISTRY_DEFAULT_URL = "https://registry.modelcontextprotocol.io";

export type McpPackageRegistry = "npm" | "pypi";

export interface McpMarketEntry {
  /** Slug id derived from the registry name — used as the server id when added. */
  id: string;
  /** Full registry name, e.g. "io.github.owner/server-name". */
  name: string;
  description: string;
  /** The transport the brain would use to connect this server. */
  transport: McpTransportKind;
  /** stdio: the package to run; the spawn command is built from a fixed template. */
  package?: string;
  packageRegistry?: McpPackageRegistry;
  /** http/sse: the remote JSON-RPC endpoint. */
  url?: string;
  /** Source repository / homepage, if the registry provided one. */
  homepage?: string;
  /** Which registry this entry came from (the configured registry host). */
  source: string;
}

// npm/pypi package-name charsets — validated BEFORE a name reaches a spawn arg so
// a poisoned entry can't inject flags or extra args (e.g. "x --evil").
export const NPM_PKG_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;
export const PYPI_PKG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,213}[A-Za-z0-9])?$/;

export function isValidPackageName(name: string, registry: McpPackageRegistry): boolean {
  const n = String(name).trim();
  if (!n || n.length > 214) return false;
  return registry === "pypi" ? PYPI_PKG_RE.test(n) : NPM_PKG_RE.test(n);
}

/**
 * Build the connectable server config for a market entry. PURE + the SINGLE
 * source of the spawn template: stdio servers always run `npx -y <pkg>` (npm) or
 * `uvx <pkg>` (pypi) — the caller never supplies a raw command/args. Always
 * `enabled:false` + `risk:"confirm"` (the add path connects it explicitly and
 * every tool stays confirm-tier).
 */
export function marketEntryToConfig(entry: McpMarketEntry): McpServerConfig | null {
  const id = slug(entry.id || entry.name);
  if (entry.transport === "http" || entry.transport === "sse") {
    // Defense in depth: a remote endpoint must be an http(s) URL. The egress
    // (isLocalUrl/LOCAL_ONLY) gate and the runtime fetch already reject a
    // non-http(s) scheme, but rejecting it here means a poisoned registry entry
    // (file:/ftp:/javascript:) never even becomes a connectable config — the
    // same `https?` posture as learn-url / open-url.
    if (!entry.url || !/^https?:\/\//i.test(entry.url)) return null;
    return { id, transport: entry.transport, url: entry.url, enabled: false, risk: "confirm" };
  }
  // stdio
  const registry: McpPackageRegistry = entry.packageRegistry === "pypi" ? "pypi" : "npm";
  if (!entry.package || !isValidPackageName(entry.package, registry)) return null;
  const command = registry === "pypi" ? "uvx" : "npx";
  const args = registry === "pypi" ? [entry.package] : ["-y", entry.package];
  return { id, transport: "stdio", command, args, enabled: false, risk: "confirm" };
}

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
  {
    // Blender — the worked example for "give it an objective, it does it through a
    // real tool". The ahujasid/blender-mcp server (run via uvx) bridges to a
    // Blender socket addon and exposes execute_blender_code / get_viewport_screenshot
    // / get_scene_info / asset generation. stdio → gated by ALLOW_SHELL; every tool
    // is confirm-tier (execute_blender_code runs arbitrary bpy). The user must
    // install the Blender addon + start its socket server first (see docs).
    id: "blender",
    transport: "stdio",
    command: "uvx",
    args: ["blender-mcp"],
    enabled: false,
    risk: "confirm",
  },
];
