// Per-cortex model routing (Phase B). The MoE router already classifies each
// query (experts, depth, difficulty); this maps that classification to a
// "profile", and each profile can be assigned a specific installed chat model.
// The pipeline passes the resolved model as SendOptions.model on its reasoning +
// response calls. Unassigned profiles → null → the connector's default model, so
// an empty config is a perfect no-op (no regression).
//
// profileForRoute + pickModel are PURE (selfcheck targets). Persistence is a
// single brain_metadata row; both assignments and the installed-model set are
// cached in-memory so routing adds ZERO latency / network to /api/ask.

import { openDb } from "../db/sqlite.js";
import { MODEL_PROFILES, type ModelProfile } from "../../../shared/models.js";
import type { RouteDecision } from "./router.js";

export { MODEL_PROFILES, type ModelProfile };

const META_KEY = "model_routing";

// --- Pure classification ----------------------------------------------------

// Deterministic. Precedence: a cheap shallow lookup wins (fast); then code/
// project queries (router's top expert); then genuinely hard full-depth
// queries (deep); else default.
export function profileForRoute(route: RouteDecision): ModelProfile {
  if (route.depth === "shallow") {
    return "fast";
  }
  const top = route.experts[0];
  if (top === "file-memory" || top === "project-cortex") {
    return "code";
  }
  if (route.depth === "full" && route.difficulty >= 0.66) {
    return "deep";
  }
  return "default";
}

// Returns the assigned model for the profile ONLY if it's currently installed;
// otherwise null (→ caller uses the default model). This makes a stale
// assignment to a since-removed model safely fall back instead of erroring.
export function pickModel(
  profile: ModelProfile,
  assignments: Partial<Record<ModelProfile, string>>,
  available: ReadonlySet<string>,
): string | null {
  const assigned = assignments[profile];
  return assigned && available.has(assigned) ? assigned : null;
}

// --- Persistence + caches ---------------------------------------------------

let assignmentsCache: Partial<Record<ModelProfile, string>> | null = null;
let availableCache = new Set<string>();

function readMeta(key: string): string | null {
  const row = openDb().prepare("SELECT value FROM brain_metadata WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function writeMeta(key: string, value: string): void {
  openDb()
    .prepare(
      "INSERT INTO brain_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

export function getAssignments(): Partial<Record<ModelProfile, string>> {
  if (assignmentsCache) {
    return assignmentsCache;
  }
  const raw = readMeta(META_KEY);
  if (!raw) {
    assignmentsCache = {};
    return assignmentsCache;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Record<ModelProfile, string>>;
    // Drop any keys that aren't valid profiles (defensive).
    assignmentsCache = Object.fromEntries(
      Object.entries(parsed).filter(([k]) => (MODEL_PROFILES as string[]).includes(k)),
    ) as Partial<Record<ModelProfile, string>>;
  } catch {
    assignmentsCache = {};
  }
  return assignmentsCache;
}

export function setAssignment(
  profile: ModelProfile,
  model: string | null,
): Partial<Record<ModelProfile, string>> {
  const next = { ...getAssignments() };
  if (model) {
    next[profile] = model;
  } else {
    delete next[profile];
  }
  writeMeta(META_KEY, JSON.stringify(next));
  assignmentsCache = next;
  return next;
}

// Updated whenever the installed-model list is freshly fetched (models route).
export function setAvailableModels(models: string[]): void {
  availableCache = new Set(models);
}

// Union-merge into the cache. Used by the boot/periodic local-Ollama refresh in
// index.ts, which only sees LOCAL models — a replace there would wipe remote
// provider models that the Model Hub view (the full picture) had merged in,
// flapping any remote-model profile assignment back to the default.
export function addAvailableModels(models: string[]): void {
  for (const m of models) {
    availableCache.add(m);
  }
}

export function getAvailableModels(): string[] {
  return [...availableCache];
}

// The pipeline seam: classify the route + resolve a model (or null = default).
export function getRoutedModel(route: RouteDecision): { profile: ModelProfile; model: string | null } {
  const profile = profileForRoute(route);
  return { profile, model: pickModel(profile, getAssignments(), availableCache) };
}

// Resolve the assigned model for an EXPLICIT profile (used by the adaptive
// controller, which may pick a profile other than profileForRoute(route)).
// Returns null — i.e. the connector's default model — when that profile has no
// assignment, so on a default setup (no per-profile model mapping) this is a
// no-op exactly like getRoutedModel.
export function modelForProfile(profile: ModelProfile): string | null {
  return pickModel(profile, getAssignments(), availableCache);
}

// Test seam.
export function _resetModelRoutingCaches(): void {
  assignmentsCache = null;
  availableCache = new Set();
}
