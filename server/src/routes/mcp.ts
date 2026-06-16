// MCP client surface.
//
//   GET  /api/mcp/state            hub snapshot (servers + tools + enabled) + the
//                                  example presets the user can enable.
//   POST /api/mcp/resolve          { server, tool, args } → validate against the
//                                  tool's schema and mint a plan-bound confirm
//                                  token for a confirm-tier tool (mirrors
//                                  /api/actions/resolve).
//   POST /api/mcp/call             { server, tool, args, confirmToken? } → run the
//                                  tool through executeAction (the SAME allowlist +
//                                  confirm/scope gate + audit as every effector).
//
// The PRIMARY path to MCP tools is the agent loop / spine deliberate tract, which
// handles confirm via the run's confirmMode. This router is the direct/debug
// surface and never gets a side door — every call goes through executeAction.

import { Router } from "express";
import { z } from "zod";
import { getMcpHub } from "../mcp/hub.js";
import { searchMarket } from "../mcp/market.js";
import { executeAction } from "../actions/executor.js";
import { getDynamicAction } from "../actions/dynamicRegistry.js";
import { mintConfirmToken } from "../actions/confirmTokens.js";
import { mcpActionId, MCP_PRESETS } from "../../../shared/mcp.js";

export const mcpRouter = Router();

const callSchema = z.object({
  server: z.string().min(1).max(60),
  tool: z.string().min(1).max(120),
  args: z.record(z.string(), z.unknown()).optional(),
  confirmToken: z.string().max(200).optional(),
});

const resolveSchema = z.object({
  server: z.string().min(1).max(60),
  tool: z.string().min(1).max(120),
  args: z.record(z.string(), z.unknown()).optional(),
});

mcpRouter.get("/mcp/state", (_req, res) => {
  res.json({ ...getMcpHub().snapshot(), presets: MCP_PRESETS });
});

// ── Marketplace (registry discovery) ─────────────────────────────────────────
// GET search is read-only discovery (egress gated inside searchMarket); POST add
// CONNECTS a discovered server, so it routes through executeAction (gated +
// audited) — the local user's explicit POST is the plan approval.

mcpRouter.get("/mcp/market/search", (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q : "";
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
  void searchMarket(query, { limit })
    .then((r) => res.json(r))
    .catch((err) => res.status(500).json({ ok: false, reason: err instanceof Error ? err.message : String(err) }));
});

const marketAddSchema = z.object({
  id: z.string().min(1).max(60),
  transport: z.enum(["stdio", "http", "sse"]),
  package: z.string().max(214).optional(),
  registry: z.enum(["npm", "pypi"]).optional(),
  url: z.string().url().max(2048).optional(),
});

mcpRouter.post("/mcp/market/add", async (req, res) => {
  const parsed = marketAddSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const args = parsed.data as Record<string, unknown>;
  // The local user's explicit POST is the approval for THIS plan — mint the
  // plan-bound confirm token and run through executeAction so the connect is
  // re-validated, gated, and audited exactly like the agent-loop path.
  const confirmToken = mintConfirmToken("mcp-market-add", args);
  const result = await executeAction({ actionId: "mcp-market-add", args, confirmToken });
  res.status(result.status).json(result);
});

mcpRouter.post("/mcp/resolve", (req, res) => {
  const parsed = resolveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const actionId = mcpActionId(parsed.data.server, parsed.data.tool);
  const def = getDynamicAction(actionId);
  if (!def || !def.mcp) {
    res.status(404).json({ error: `MCP tool ${parsed.data.server}:${parsed.data.tool} is not registered` });
    return;
  }
  const args = (parsed.data.args ?? {}) as Record<string, unknown>;
  const valid = def.schema.safeParse(args);
  if (!valid.success) {
    res.status(400).json({ error: `invalid args: ${valid.error.issues.map((i) => i.message).join("; ")}` });
    return;
  }
  const needsConfirm = def.risk !== "safe";
  res.json({
    plan: { actionId, args },
    needsConfirm,
    // The token represents the local user approving THIS exact MCP call (the same
    // semantics as the actions confirm card).
    confirmToken: needsConfirm ? mintConfirmToken(actionId, args) : undefined,
  });
});

mcpRouter.post("/mcp/call", async (req, res) => {
  const parsed = callSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const actionId = mcpActionId(parsed.data.server, parsed.data.tool);
  const result = await executeAction({
    actionId,
    args: parsed.data.args ?? {},
    confirmToken: parsed.data.confirmToken,
  });
  res.status(result.status).json(result);
});
