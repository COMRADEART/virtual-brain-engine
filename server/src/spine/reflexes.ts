// Reflex arcs — the NanoClaw/NemoClaw minimal loop.
//
// A reflex is the spinal cord's fastest path: a recognised stimulus fires ONE
// action with NO LLM round-trip and NO human confirmation — match → act → done.
// Because it skips both the model and the confirm card, a reflex may ONLY ever
// target a SAFE-tier (read-only) action. That invariant is enforced THREE times:
//   1. the built-in arcs below reference only safe action ids (pinned by the
//      selfcheck);
//   2. registerReflex re-derives the target's risk from the registry and
//      REFUSES any non-safe target;
//   3. the live matcher (matchReflex) drops any arc whose target is not
//      currently safe-tier, and cord.ts re-checks once more before firing.
// So even a registry change or a poisoned custom arc cannot make a reflex fire a
// side-effecting command — it simply declines and the intent falls through to a
// higher (gated) tract.
//
// The matching CORE (matchReflexIn) is pure + deterministic for the selfcheck.
// Custom arcs persist as one brain_metadata JSON row (no schema/migration).

import { createHash } from "node:crypto";
import { openDb } from "../db/sqlite.js";
import { surfaceError } from "../util/diagnostics.js";
import { getActionDef } from "../actions/registry.js";
import type { ReflexArc } from "../../../shared/spine.js";

const META_KEY = "spinal-reflexes-v1";

// ── Built-in reflexes (only safe-tier targets) ───────────────────────────────
// The three safe-tier actions in the registry are system-info, recent-memories
// and search-memory — so those are the only built-in reflexes. Each is a real,
// instantly-useful knee-jerk.
const BUILT_IN: ReflexArc[] = [
  {
    id: "reflex-system-info",
    name: "System status",
    triggers: [
      "system info",
      "system status",
      "how much memory",
      "how much ram",
      "free memory",
      "cpu usage",
      "disk space",
      "machine specs",
      "computer specs",
      "hardware info",
    ],
    actionId: "system-info",
    description: "Instantly report CPU / memory / disk without thinking.",
    builtIn: true,
  },
  {
    id: "reflex-recent-memories",
    name: "Recent recall",
    triggers: [
      "recent memories",
      "recent memory",
      "latest notes",
      "recent notes",
      "what did i just",
      "what's new in memory",
      "what is new in memory",
    ],
    actionId: "recent-memories",
    description: "Instantly list the most recent memories.",
    builtIn: true,
  },
  {
    id: "reflex-search-memory",
    name: "Memory reflex",
    triggers: [
      "search memory for",
      "search my memory for",
      "find in memory",
      "do i have a memory of",
      "do i remember",
      "recall about",
      "what do i know about",
    ],
    actionId: "search-memory",
    argParam: "query",
    description: "Instantly keyword-search memory for the named subject.",
    builtIn: true,
  },
];

// ── Pure matching core (selfcheck-exercisable) ───────────────────────────────

/** Pull the free-text argument that follows the first connector in `intent`. */
export function extractReflexArg(intent: string): string | null {
  // Take everything after the first " for " / " about " / " of " / ":".
  const m = intent.match(/(?:\bfor\b|\babout\b|\bof\b|:)\s+(.+)$/i);
  const v = m?.[1]?.trim();
  return v && v.length > 0 ? v : null;
}

export interface ReflexMatch {
  arc: ReflexArc;
  args: Record<string, unknown>;
}

/**
 * Match an intent against a list of reflex arcs. Pure: case-folds the intent,
 * returns the FIRST arc whose any trigger is a substring. If the arc needs an
 * arg it cannot extract, it declines (returns null for that arc and keeps
 * scanning) so the intent can fall through to a higher tract.
 */
export function matchReflexIn(intent: string, arcs: ReadonlyArray<ReflexArc>): ReflexMatch | null {
  const lower = intent.toLowerCase().trim();
  if (lower.length === 0) return null;
  for (const arc of arcs) {
    if (!arc.triggers.some((t) => lower.includes(t.toLowerCase()))) continue;
    if (arc.argParam) {
      const value = extractReflexArg(intent);
      if (value === null) continue; // can't fill the required arg → decline
      return { arc, args: { [arc.argParam]: value } };
    }
    return { arc, args: {} };
  }
  return null;
}

// ── Persistence + live API (every method failure-isolated) ───────────────────

function readCustom(): ReflexArc[] {
  try {
    const row = openDb().prepare("SELECT value FROM brain_metadata WHERE key = ?").get(META_KEY) as
      | { value: string }
      | undefined;
    if (!row) return [];
    const parsed = JSON.parse(row.value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is ReflexArc =>
        !!x &&
        typeof x === "object" &&
        typeof (x as ReflexArc).id === "string" &&
        Array.isArray((x as ReflexArc).triggers) &&
        typeof (x as ReflexArc).actionId === "string",
    );
  } catch (err) {
    surfaceError("spine.reflexes.read", err);
    return [];
  }
}

function writeCustom(arcs: ReflexArc[]): void {
  try {
    openDb()
      .prepare(
        "INSERT INTO brain_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(META_KEY, JSON.stringify(arcs));
  } catch (err) {
    surfaceError("spine.reflexes.write", err);
  }
}

/** Is this action id currently a SAFE-tier (reflex-eligible) action? */
export function isReflexEligible(actionId: string): boolean {
  const def = getActionDef(actionId);
  return def?.risk === "safe";
}

/** All reflexes (built-in + custom). */
export function listReflexes(): ReflexArc[] {
  return [...BUILT_IN, ...readCustom()];
}

/**
 * The reflexes that are SAFE to fire right now — built-ins are safe by
 * construction; customs are re-checked against the live registry. This is the
 * list the live matcher uses, so a target that lost safe-tier (registry change)
 * is silently skipped, never fired.
 */
export function liveReflexes(): ReflexArc[] {
  return listReflexes().filter((arc) => isReflexEligible(arc.actionId));
}

/** Live reflex match (safe-eligible arcs only). */
export function matchReflex(intent: string): ReflexMatch | null {
  return matchReflexIn(intent, liveReflexes());
}

export interface RegisterReflexInput {
  name?: string;
  triggers: string[];
  actionId: string;
  argParam?: string;
  description?: string;
}

export type RegisterReflexResult =
  | { ok: true; arc: ReflexArc }
  | { ok: false; error: string };

/**
 * Register a custom reflex. REFUSES any target that is not a safe-tier action —
 * a reflex fires without confirmation, so it can never carry a side effect.
 */
export function registerReflex(input: RegisterReflexInput): RegisterReflexResult {
  const triggers = (input.triggers ?? [])
    .map((t) => String(t).toLowerCase().trim())
    .filter((t) => t.length > 0);
  if (!input.actionId || typeof input.actionId !== "string") {
    return { ok: false, error: "actionId required" };
  }
  if (triggers.length === 0) {
    return { ok: false, error: "at least one trigger phrase required" };
  }
  const def = getActionDef(input.actionId);
  if (!def) {
    return { ok: false, error: `unknown or unavailable action "${input.actionId}"` };
  }
  if (def.risk !== "safe") {
    return {
      ok: false,
      error: `refused: a reflex may only fire a SAFE action (read-only). "${input.actionId}" is ${def.risk}-tier — route it through the deliberate tract instead.`,
    };
  }
  const id = `reflex-${createHash("sha1").update(`${input.actionId}:${triggers.join("|")}`).digest("hex").slice(0, 10)}`;
  const arc: ReflexArc = {
    id,
    name: input.name?.trim() || def.title,
    triggers,
    actionId: input.actionId,
    argParam: input.argParam && input.argParam.trim() ? input.argParam.trim() : undefined,
    description: input.description?.trim() || `Reflex → ${def.title}`,
    builtIn: false,
  };
  const custom = readCustom().filter((c) => c.id !== id);
  custom.push(arc);
  writeCustom(custom);
  return { ok: true, arc };
}

/** Remove a custom reflex by id. Built-ins cannot be removed. Returns success. */
export function removeReflex(id: string): boolean {
  const custom = readCustom();
  const next = custom.filter((c) => c.id !== id);
  if (next.length === custom.length) return false;
  writeCustom(next);
  return true;
}
