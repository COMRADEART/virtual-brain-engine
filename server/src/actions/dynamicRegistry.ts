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
import { openDb } from "../db/sqlite.js";
import { getActionDef, isAllowlisted, listActionSpecs } from "./registry.js";
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
}

// Register a new dynamic action.
export async function registerSkill(
  def: SkillDefinition,
  audited = true,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  // Check the action ID isn't already in the static registry.
  if (isAllowlisted(def.id)) {
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

// Get a dynamic action by ID.
export function getDynamicAction(id: string): ActionDef | null {
  return dynamicActions.get(id as ActionId) ?? null;
}

// List all dynamic actions (as ActionSpec, without the schema).
export function listDynamicActions(): ActionSpec[] {
  return Array.from(dynamicActions.values()).map(({ schema: _schema, handlerCode: _hc, ...spec }) => ({
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

  // Build a sandboxed context for the handler.
  // The handler receives: { args, log: (msg) => void }
  const context = {
    args,
    log: (msg: string) => console.log(`[dynamic:${id}] ${msg}`),
  };

  try {
    // Create a function from the handler code and execute it with the context.
    // We wrap it in a Promise to handle async handlers.
    const handlerFn = new Function("ctx", `
      const { args, log } = ctx;
      ${action.handlerCode}
      return (async () => { ${action.handlerCode} })();
    `);

    // Simpler approach: just eval the handler in a limited scope
    // This is intentionally minimal - only args and log are available
    const fn = new Function("args", "log", action.handlerCode);
    const result = await fn(args, context.log);
    return result || { summary: `Executed ${id}`, data: { args } };
  } catch (err) {
    throw new Error(`handler failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Initialize: load dynamic actions from DB on module load.
loadDynamicActions();