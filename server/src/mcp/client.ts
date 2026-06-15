// One MCP server connection: the JSON-RPC handshake + tools/list + tools/call,
// layered over a McpTransport. Typed envelopes only (no `any` leaking out). The
// hub owns N of these; nothing here spawns or fetches — that's the transport.

import type { McpToolDef, McpToolResult, JsonSchema } from "../../../shared/mcp.js";
import type { McpTransport } from "./transport.js";
import { McpError } from "./transport.js";

const PROTOCOL_VERSION = "2024-11-05";

interface ToolsListResult {
  tools?: Array<{ name?: unknown; description?: unknown; inputSchema?: unknown }>;
}

interface ToolCallResult {
  content?: Array<{ type?: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
}

export class McpClient {
  private readonly transport: McpTransport;
  private readonly serverId: string;

  constructor(serverId: string, transport: McpTransport) {
    this.serverId = serverId;
    this.transport = transport;
  }

  // Connect + MCP initialize handshake.
  async initialize(): Promise<void> {
    await this.transport.start();
    await this.transport.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "star-brain", version: "1.0.0" },
    });
    await this.transport.notify("notifications/initialized");
  }

  // Discover the server's tools.
  async listTools(): Promise<McpToolDef[]> {
    const raw = (await this.transport.request("tools/list")) as ToolsListResult;
    const tools = Array.isArray(raw?.tools) ? raw.tools : [];
    return tools
      .filter((t): t is { name: string; description?: unknown; inputSchema?: unknown } => typeof t?.name === "string")
      .map((t) => ({
        server: this.serverId,
        name: t.name,
        description: typeof t.description === "string" ? t.description : `MCP tool ${t.name}`,
        inputSchema:
          t.inputSchema && typeof t.inputSchema === "object" ? (t.inputSchema as JsonSchema) : { type: "object" },
      }));
  }

  // Invoke a tool. Flattens the MCP content blocks into one text string for the
  // agent loop, and surfaces an isError result as ok:false.
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    try {
      const raw = (await this.transport.request("tools/call", { name, arguments: args })) as ToolCallResult;
      const text = Array.isArray(raw?.content)
        ? raw.content
            .map((c) => (typeof c?.text === "string" ? c.text : c?.type ? `[${c.type}]` : ""))
            .filter((s) => s.length > 0)
            .join("\n")
        : "";
      if (raw?.isError) {
        return { ok: false, content: text, error: text || "tool reported an error", data: raw };
      }
      return { ok: true, content: text || "(no content)", data: raw };
    } catch (err) {
      const msg = err instanceof McpError ? err.message : err instanceof Error ? err.message : String(err);
      return { ok: false, content: "", error: msg };
    }
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}
