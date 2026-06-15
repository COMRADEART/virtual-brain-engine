// Turn a discovered MCP tool into a dynamic action on the brain's allowlist. Each
// MCP tool becomes a confirm-tier (by default) dynamic ActionDef carrying an
// `mcp:{server,tool}` descriptor — so it flows through executeAction's dynamic
// branch and is dispatched to the hub, reusing the SAME confirm/scope gate + audit
// as every other effector. The zod schema is derived from the tool's JSON-Schema
// (typed, not all-string) so the model is steered toward valid arguments.

import { z } from "zod";
import { registerMcpAction, clearMcpActions } from "../actions/dynamicRegistry.js";
import { mcpActionId, type JsonSchema, type McpToolDef } from "../../../shared/mcp.js";
import type { ActionRiskTier } from "../../../shared/actions.js";

// Map a single JSON-Schema node to a zod type. Best-effort + permissive: anything
// unrecognised becomes z.unknown() so a quirky schema never makes a tool
// un-callable. Depth-bounded so a pathological recursive schema can't blow the
// stack.
function nodeToZod(node: JsonSchema | undefined, depth: number): z.ZodTypeAny {
  if (!node || typeof node !== "object" || depth > 5) return z.unknown();
  if (Array.isArray(node.enum) && node.enum.length > 0) return z.unknown();
  switch (node.type) {
    case "string":
      return z.string();
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(nodeToZod(node.items, depth + 1));
    case "object":
      return objectToZod(node, depth + 1);
    default:
      return z.unknown();
  }
}

function objectToZod(schema: JsonSchema, depth: number): z.ZodTypeAny {
  const props = schema.properties;
  if (!props || typeof props !== "object") {
    // Unconstrained object — accept any bag of args (the MCP server validates).
    return z.record(z.string(), z.unknown());
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, sub] of Object.entries(props)) {
    const t = nodeToZod(sub, depth + 1);
    shape[key] = required.has(key) ? t : t.optional();
  }
  // passthrough(): keep any extra keys so the full arg bag reaches the MCP server
  // (it owns the authoritative schema; we only steer the model toward valid args).
  return z.object(shape).passthrough();
}

// Human-readable param hints for the resolver/agent prompt + UI.
function describeParams(schema: JsonSchema): Record<string, string> {
  const out: Record<string, string> = {};
  const props = schema.properties;
  if (props && typeof props === "object") {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const [key, sub] of Object.entries(props)) {
      const desc = typeof sub?.description === "string" ? sub.description : (sub?.type ?? "value");
      out[key] = `${desc}${required.has(key) ? " (required)" : ""}`;
    }
  }
  return out;
}

// Register ONE MCP tool as a dynamic action. Returns the synthesized action id.
export function registerMcpTool(tool: McpToolDef, risk: ActionRiskTier): string {
  const id = mcpActionId(tool.server, tool.name);
  registerMcpAction({
    id,
    title: `${tool.server}: ${tool.name}`,
    description: `[MCP:${tool.server}] ${tool.description}`.slice(0, 1000),
    risk,
    params: describeParams(tool.inputSchema),
    schema: objectToZod(
      tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object" },
      0,
    ),
    mcp: { server: tool.server, tool: tool.name },
  });
  return id;
}

export { clearMcpActions };
