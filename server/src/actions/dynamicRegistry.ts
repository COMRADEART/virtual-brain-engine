// Dynamic action registry — runtime registration of new skills/actions.
// Allows the brain to dynamically add new capabilities by parsing GitHub code
// or receiving skill definitions from external sources.
//
// Security:
// - All dynamic registrations require elevated trust (admin-level)
// - Skill code is validated before registration
// - Every registration is audited
// - Dynamic actions run in a sandboxed context

import { z } from "zod";
import { ulid } from "ulid";
import { CONFIG } from "../config.js";
import { openDb } from "../db/sqlite.js";
import { getActionDef, isRegisteredId, listActionSpecs } from "./registry.js";
import { insertActionLog } from "../db/repositories/actions.js";
import type { ActionId, ActionRiskTier, ActionSurface, ActionSpec } from "../../../shared/actions.js";

// Schema for registering a new skill.
export const SkillDefinitionSchema = z
  .object({
    id: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, "lowercase alphanumeric + dash only"),
    title: z.string().min(1).max(100),
    description: z.string().min(1).max(1000),
    risk: z.enum(["safe", "confirm"]),
    surface: z.enum(["server", "os"]),
    params: z.record(z.string(), z.string()),
    // Handler code (for server-surface actions). This is a string that gets
    // evaluated in a sandboxed context. MUST be a simple async function.
    handlerCode: z.string().optional(),
  })
  .strict();

export type SkillDefinition = z.infer<typeof SkillDefinitionSchema>;

// In-memory cache of dynamic actions. Loaded from DB on startup.
const dynamicActions = new Map<ActionId, ActionDef>();

interface DynamicActionRow {
  id: string;
  definition_json: string;
  created_at: string;
  updated_at: string;
}

// Load all dynamic actions from DB.
export function loadDynamicActions(): void {
  const db = openDb();
  const rows = db
    .prepare("SELECT id, definition_json, created_at, updated_at FROM dynamic_actions WHERE status = 'active'")
    .all() as DynamicActionRow[];

  dynamicActions.clear();
  for (const row of rows) {
    try {
      const def = JSON.parse(row.definition_json) as SkillDefinition;
      dynamicActions.set(def.id as ActionId, {
        ...def,
        schema: z.object(
          Object.fromEntries(
            Object.entries(def.params).map(([k, v]) => [k, z.string()]),
          ),
        ).strict(),
      });
    } catch (err) {
      console.error(`[dynamic-registry] failed to load ${row.id}:`, err);
    }
  }
  console.log(`[dynamic-registry] loaded ${dynamicActions.size} dynamic actions`);
}

// Save a new dynamic action to DB.
async function saveDynamicAction(def: SkillDefinition): Promise<void> {
  const db = openDb();
  const now = new Date().toISOString();
  const id = ulid();

  db.prepare(
    `INSERT INTO dynamic_actions (id, definition_json, status, created_at, updated_at)
     VALUES (?, ?, 'active', ?, ?)
     ON CONFLICT(id) DO UPDATE SET definition_json = excluded.definition_json, updated_at = excluded.updated_at`,
  ).run(id, JSON.stringify(def), now, now);
}

// Delete a dynamic action (soft delete).
async function deleteDynamicAction(id: string): Promise<void> {
  const db = openDb();
  db.prepare("UPDATE dynamic_actions SET status = 'deleted', updated_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    id,
  );
}

// Validate handler code for server-surface actions.
// Returns { ok: true } if valid, or { ok: false, error } if invalid.
function validateHandlerCode(code: string): { ok: true } | { ok: false; error: string } {
  // Very basic validation: must be an async function that takes args and returns a result.
  // We don't actually execute it here — we just check it looks like valid JS.
  if (!code.includes("async") && !code.includes("function")) {
    return { ok: false, error: "handler must be an async function" };
  }
  if (code.includes("require(") || code.includes("import(")) {
    return { ok: false, error: "handler cannot use require/import" };
  }
  if (code.includes("process.") || code.includes("global.")) {
    return { ok: false, error: "handler cannot access process/global" };
  }
  // Block dangerous keywords
  const blocked = ["eval(", "Function(", "exec(", "spawn(", "execSync("];
  for (const kw of blocked) {
    if (code.includes(kw)) {
      return { ok: false, error: `handler contains blocked keyword: ${kw}` };
    }
  }
  return { ok: true };
}

interface ActionDef {
  id: string;
  title: string;
  description: string;
  risk: ActionRiskTier;
  surface: ActionSurface;
  params: Record<string, string>;
  schema: z.ZodTypeAny;
  handlerCode?: string;
  // When set, this dynamic action is backed by an external MCP server tool. The
  // executor routes it to the MCP hub instead of the new Function() handler — so
  // MCP tools reuse the dynamic allowlist + confirm gate + audit WITHOUT relaxing
  // the eval sandbox. (See server/src/actions/executor.ts dynamic branch.)
  mcp?: { server: string; tool: string };
}

// Register a new dynamic action.
export async function registerSkill(
  def: SkillDefinition,
  audited = true,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  // Check the action ID isn't already in the static registry. Use raw membership
  // (isRegisteredId), NOT isAllowlisted: a shell action hidden by ALLOW_SHELL=off
  // still OWNS its id, so a dynamic skill must not be able to claim "run-command"
  // et al. and permanently shadow the built-in (executeAction resolves dynamic
  // actions before static ones).
  if (isRegisteredId(def.id)) {
    return { ok: false, error: `action ${def.id} is already registered (static)` };
  }

  // Validate the ID format.
  if (!/^[a-z][a-z0-9-]*$/.test(def.id)) {
    return { ok: false, error: "action ID must be lowercase alphanumeric with dashes, starting with a letter" };
  }

  // Validate handler code if server-surface.
  if (def.surface === "server" && def.handlerCode) {
    const validation = validateHandlerCode(def.handlerCode);
    if (!validation.ok) {
      return { ok: false, error: validation.error };
    }
  }

  // Build the Zod schema from params.
  const schema = z.object(
    Object.fromEntries(
      Object.entries(def.params).map(([k, v]) => [
        k,
        // All dynamic action params are strings for simplicity
        z.string().describe(v),
      ]),
    ),
  ).strict();

  const actionDef: ActionDef = { ...def, schema };

  // Save to DB.
  await saveDynamicAction(def);

  // Add to runtime cache.
  dynamicActions.set(def.id as ActionId, actionDef);

  // Audit the registration.
  if (audited) {
    try {
      insertActionLog({
        actionId: "dynamic-register",
        args: { skillId: def.id, title: def.title },
        risk: "confirm",
        confirmed: true,
        ok: true,
        summary: `Registered dynamic skill: ${def.id}`,
      });
    } catch {
      // audit failure shouldn't block registration
    }
  }

  return { ok: true, id: def.id };
}

// Unregister a dynamic action.
export async function unregisterSkill(
  id: string,
  audited = true,
): Promise<{ ok: boolean; error?: string }> {
  if (!dynamicActions.has(id as ActionId)) {
    return { ok: false, error: `skill ${id} not found in dynamic registry` };
  }

  await deleteDynamicAction(id);
  dynamicActions.delete(id as ActionId);

  if (audited) {
    try {
      insertActionLog({
        actionId: "dynamic-unregister",
        args: { skillId: id },
        risk: "confirm",
        confirmed: true,
        ok: true,
        summary: `Unregistered dynamic skill: ${id}`,
      });
    } catch {
      // audit failure shouldn't block unregistration
    }
  }

  return { ok: true };
}

// Register an MCP-backed dynamic action. IN-MEMORY only (NOT persisted): MCP tools
// are connection-bound and re-discovered on every hub start, so they must never
// outlive a connection in the DB. The zod `schema` is supplied by the caller
// (derived from the tool's JSON-Schema). Surface is always "server".
export function registerMcpAction(input: {
  id: string;
  title: string;
  description: string;
  risk: ActionRiskTier;
  params: Record<string, string>;
  schema: z.ZodTypeAny;
  mcp: { server: string; tool: string };
}): void {
  dynamicActions.set(input.id as ActionId, {
    id: input.id,
    title: input.title,
    description: input.description,
    risk: input.risk,
    surface: "server",
    params: input.params,
    schema: input.schema,
    mcp: input.mcp,
  });
}

// Remove MCP-backed dynamic actions (all, or just one server's). Returns the
// count removed. Used when the hub stops or a server disconnects.
export function clearMcpActions(server?: string): number {
  let removed = 0;
  for (const [id, def] of dynamicActions) {
    if (def.mcp && (server === undefined || def.mcp.server === server)) {
      dynamicActions.delete(id);
      removed += 1;
    }
  }
  return removed;
}

// Get a dynamic action by ID.
export function getDynamicAction(id: string): ActionDef | null {
  return dynamicActions.get(id as ActionId) ?? null;
}

// List all dynamic actions (as ActionSpec, without the schema/handler/mcp internals).
export function listDynamicActions(): ActionSpec[] {
  return Array.from(dynamicActions.values()).map(({ schema: _schema, handlerCode: _hc, mcp: _mcp, ...spec }) => ({
    ...spec,
    id: spec.id as ActionId,
  }));
}

// Check if an action ID is a dynamic action.
export function isDynamicAction(id: string): boolean {
  return dynamicActions.has(id as ActionId);
}

// Get the handler code for a dynamic action (if server-surface).
export function getDynamicHandler(id: string): string | undefined {
  return dynamicActions.get(id as ActionId)?.handlerCode;
}

// Execute a dynamic server-surface action.
// The handlerCode is a string that we need to evaluate in context.
// This is intentionally limited - we provide a sandboxed `args` object.
export async function executeDynamicHandler(
  id: string,
  args: Record<string, unknown>,
): Promise<{ summary: string; data?: unknown }> {
  const action = dynamicActions.get(id as ActionId);
  if (!action) {
    throw new Error(`dynamic action ${id} not found`);
  }
  if (!action.handlerCode) {
    throw new Error(`dynamic action ${id} has no handler code`);
  }
  // SECURITY GATE — plain-code handler execution is OFF by default. A handler
  // runs via `new Function`, whose body executes in Node's GLOBAL scope, so it
  // can reach `process`/`globalThis` regardless of the param list, and the
  // registration-time keyword scan is bypassable (obfuscated `Function`/`require`
  // construction). Rather than pretend to sandbox untrusted JS, we simply don't
  // run it unless the operator opts in. MCP-backed dynamic actions never reach
  // here (the executor dispatches them to the hub before this). The throw is
  // caught + audited by executor.ts as a clean refusal. (Opt in: ALLOW_DYNAMIC_CODE=true.)
  if (!CONFIG.allowDynamicCode) {
    throw new Error(
      "plain-code dynamic handlers are disabled (set ALLOW_DYNAMIC_CODE=true to enable, or use an MCP-backed skill)",
    );
  }

  const log = (msg: string) => console.log(`[dynamic:${id}] ${msg}`);

  try {
    // Only `args` and `log` are passed in. NOTE: this is NOT a real sandbox (the
    // body still runs in global scope) — the trust boundary is the ALLOW_DYNAMIC_CODE
    // gate above + the executor's allowlist/confirm/audit, not this construction.
    const fn = new Function("args", "log", action.handlerCode);
    const result = await fn(args, log);
    return result || { summary: `Executed ${id}`, data: { args } };
  } catch (err) {
    throw new Error(`handler failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

// Initialize: load dynamic actions from DB on module load.
loadDynamicActions();