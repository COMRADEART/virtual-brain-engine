// The MCP hub — a lazy singleton that owns every MCP server connection. On start
// it connects each configured server, discovers its tools, and registers each as
// a confirm-tier dynamic action (so the agent loop's tool catalog picks them up
// for free). callTool() is the dispatch seam the executor's dynamic branch uses.
// Per-server failure-isolated: one server that won't connect never blocks the
// others or the server boot.

import { CONFIG } from "../config.js";
import { openDb } from "../db/sqlite.js";
import { broadcast } from "../ws/brainBus.js";
import { surfaceError } from "../util/diagnostics.js";
import { createTransport } from "./transport.js";
import { McpClient } from "./client.js";
import { registerMcpTool, clearMcpActions } from "./registrySync.js";
import type {
  McpEvent,
  McpEventKind,
  McpHubSnapshot,
  McpServerConfig,
  McpServerStatus,
  McpToolDef,
  McpToolResult,
} from "../../../shared/mcp.js";
import type { ActionRiskTier } from "../../../shared/actions.js";

interface ServerState {
  config: McpServerConfig;
  client: McpClient | null;
  tools: McpToolDef[];
  connected: boolean;
  error?: string;
  risk: ActionRiskTier;
}

function emitEvent(kind: McpEventKind, server?: string, tool?: string, detail?: string): void {
  const event: McpEvent = { kind, server, tool, detail, at: new Date().toISOString() };
  try {
    broadcast({ type: "mcp", event, timestamp: event.at });
  } catch (err) {
    surfaceError("mcp.broadcast", err);
  }
}

// Parse CONFIG.mcpServersRaw (JSON array of McpServerConfig). Bad JSON → [] (logged),
// never a crash. Only minimally validated here; the transport re-checks specifics.
function parseConfigured(): McpServerConfig[] {
  const raw = CONFIG.mcpServersRaw.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is McpServerConfig =>
        !!c && typeof c === "object" && typeof (c as McpServerConfig).id === "string" &&
        typeof (c as McpServerConfig).transport === "string",
    );
  } catch (err) {
    surfaceError("mcp.parseConfig", err);
    return [];
  }
}

// Persisted market-added servers (separate from the env-configured MCP_SERVERS).
// One brain_metadata JSON row — the adaptive-layer KV pattern, no migration.
const ADDED_KEY = "mcp-added-servers-v1";

class McpHub {
  private servers = new Map<string, ServerState>();
  private started = false;

  configured(): McpServerConfig[] {
    return parseConfigured();
  }

  // Servers added at runtime via the marketplace, persisted across restarts.
  private loadAddedServers(): McpServerConfig[] {
    try {
      const row = openDb().prepare("SELECT value FROM brain_metadata WHERE key = ?").get(ADDED_KEY) as
        | { value: string }
        | undefined;
      if (!row) return [];
      const parsed = JSON.parse(row.value) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (c): c is McpServerConfig =>
          !!c && typeof c === "object" && typeof (c as McpServerConfig).id === "string" &&
          typeof (c as McpServerConfig).transport === "string",
      );
    } catch (err) {
      surfaceError("mcp.loadAdded", err);
      return [];
    }
  }

  private rememberAdded(config: McpServerConfig): void {
    try {
      const list = this.loadAddedServers().filter((c) => c.id !== config.id);
      list.push(config);
      openDb()
        .prepare(
          "INSERT INTO brain_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(ADDED_KEY, JSON.stringify(list));
    } catch (err) {
      surfaceError("mcp.rememberAdded", err);
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // Persisted market-added servers first, then env-configured (env wins on an
    // id clash — the operator's explicit config is authoritative).
    const byId = new Map<string, McpServerConfig>();
    for (const c of this.loadAddedServers()) byId.set(c.id, c);
    for (const c of this.configured()) byId.set(c.id, c);
    for (const config of byId.values()) {
      const risk: ActionRiskTier = config.risk === "safe" ? "safe" : "confirm";
      if (config.enabled === false) {
        this.servers.set(config.id, { config, client: null, tools: [], connected: false, risk });
        continue;
      }
      await this.connect(config, risk);
    }
  }

  /**
   * Add (and connect) a server at runtime — the marketplace "wire it in" seam.
   * NEVER auto-called from search; reached only via the confirm-tier
   * mcp-market-add action (executeAction gates it). Connecting still routes
   * through the transport gates (stdio→ALLOW_SHELL, http→LOCAL_ONLY), and every
   * discovered tool registers confirm-tier (registrySync). Persists on success
   * so the server survives a restart. Never throws.
   */
  async addServer(config: McpServerConfig): Promise<{ ok: boolean; server: string; toolCount: number; error?: string }> {
    const risk: ActionRiskTier = config.risk === "safe" ? "safe" : "confirm";
    const cfg: McpServerConfig = { ...config, enabled: true, risk };
    const existing = this.servers.get(cfg.id);
    if (existing?.connected) {
      return { ok: true, server: cfg.id, toolCount: existing.tools.length };
    }
    this.started = true; // host this server even if the boot set was empty
    await this.connect(cfg, risk);
    const state = this.servers.get(cfg.id);
    const ok = !!state?.connected;
    if (ok) this.rememberAdded(cfg);
    return { ok, server: cfg.id, toolCount: state?.tools.length ?? 0, error: state?.error };
  }

  private async connect(config: McpServerConfig, risk: ActionRiskTier): Promise<void> {
    const state: ServerState = { config, client: null, tools: [], connected: false, risk };
    this.servers.set(config.id, state);
    try {
      const client = new McpClient(config.id, createTransport(config));
      await client.initialize();
      const tools = await client.listTools();
      state.client = client;
      state.tools = tools;
      state.connected = true;
      for (const tool of tools) {
        registerMcpTool(tool, risk);
        emitEvent("tool-registered", config.id, tool.name);
      }
      emitEvent("connected", config.id, undefined, `${tools.length} tools`);
      console.log(`[mcp] connected "${config.id}" (${config.transport}) — ${tools.length} tools (${risk}-tier)`);
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
      emitEvent("error", config.id, undefined, state.error);
      surfaceError("mcp.connect", err);
      console.warn(`[mcp] server "${config.id}" failed: ${state.error}`);
    }
  }

  // Dispatch a tool call to its server. The CALLER (executeAction) has already
  // re-derived risk + run the confirm/scope gate + will audit — this only routes.
  async callTool(server: string, tool: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const state = this.servers.get(server);
    if (!state?.client || !state.connected) {
      return { ok: false, content: "", error: `MCP server "${server}" is not connected` };
    }
    emitEvent("tool-call", server, tool);
    return state.client.callTool(tool, args);
  }

  health(): { ok: boolean; detail: string } {
    if (!this.started) return { ok: true, detail: "disabled" };
    const states = [...this.servers.values()];
    const connected = states.filter((s) => s.connected).length;
    const tools = states.reduce((n, s) => n + s.tools.length, 0);
    return { ok: states.every((s) => s.connected || s.config.enabled === false), detail: `${connected}/${states.length} servers, ${tools} tools` };
  }

  snapshot(): McpHubSnapshot {
    const servers: McpServerStatus[] = [];
    const tools: McpHubSnapshot["tools"] = [];
    for (const s of this.servers.values()) {
      servers.push({ id: s.config.id, transport: s.config.transport, connected: s.connected, toolCount: s.tools.length, error: s.error });
      for (const t of s.tools) {
        tools.push({ id: `mcp-${s.config.id}-${t.name}`, server: s.config.id, name: t.name, description: t.description, risk: s.risk });
      }
    }
    return { enabled: CONFIG.mcpEnabled, servers, tools };
  }

  async stop(): Promise<void> {
    for (const s of this.servers.values()) {
      try {
        await s.client?.close();
      } catch {
        /* already gone */
      }
    }
    clearMcpActions();
    this.servers.clear();
    this.started = false;
  }
}

let hub: McpHub | null = null;

export function getMcpHub(): McpHub {
  if (!hub) hub = new McpHub();
  return hub;
}

// The executor's dynamic-branch dispatch seam.
export function callMcpTool(server: string, tool: string, args: Record<string, unknown>): Promise<McpToolResult> {
  return getMcpHub().callTool(server, tool, args);
}

// Test seam — drop the singleton so a selfcheck starts clean.
export function __resetMcpHub(): void {
  hub = null;
}
