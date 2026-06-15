// Runtime application-settings layer — "edit the brain's own knobs from the UI".
//
// The whole server is configured by ServerConfig (server/src/config.ts), seeded
// from env / .env at boot. Historically the only way to change a knob was to edit
// .env and restart. This layer exposes a CURATED, runtime-safe subset of those
// knobs as editable settings:
//
//   - On boot, applyPersistedSettings() overlays any saved overrides onto the live
//     CONFIG object (mutated IN PLACE — every read site does `CONFIG.x` at call
//     time, never destructures it at import, so a mutation is picked up live).
//   - GET surfaces the catalog + current effective values.
//   - POST validates a patch, mutates CONFIG, and persists the diff-from-baseline
//     as a single brain_metadata JSON row (no schema/migration — same pattern as
//     reasoning/modelRouting.ts and db/repositories/adaptive.ts).
//
// HONESTY: keys read once at boot to wire up an interval/schedule (sleepCycle,
// workspaceEnabled) are flagged `requiresRestart` — the override persists and is
// applied next boot, but a live toggle won't start/stop the already-scheduled
// timer. Everything else is read at call time and takes effect immediately.
//
// SECURITY: secrets (API keys, tokens) are NEVER in the catalog. They stay in
// process.env and are never written to the DB. The most security-sensitive
// toggles (localOnly, allowShell, dedupAutoMerge) are flagged `danger` so the UI
// can warn, but they are exactly the same knobs the user could set in .env.

import { CONFIG } from "../config.js";
import { openDb } from "../db/sqlite.js";
import { surfaceError } from "../util/diagnostics.js";
import type {
  SettingSpec,
  SettingValue,
  SettingsView,
  UpdateSettingsResult,
} from "../../../shared/settings.js";

const META_KEY = "runtime_settings";

// THE catalog. Each `key` is BOTH the catalog id and the ServerConfig property it
// controls. Adding a knob here makes it runtime-editable; anything not listed
// stays env-only.
export const SETTINGS_CATALOG: SettingSpec[] = [
  // ── Privacy & network ────────────────────────────────────────────────────
  {
    key: "localOnly",
    label: "Local-only (zero outbound)",
    description:
      "When ON, the brain makes ZERO outbound network requests. Turn OFF to let it use the internet — web search, learn-from-URL, GitHub discovery, and remote models.",
    group: "Privacy & network",
    type: "boolean",
    envVar: "LOCAL_ONLY",
    danger: true,
  },
  {
    key: "webSearchMode",
    label: "Web search mode",
    description:
      "When an answer reaches the live web (needs Local-only OFF). smart = only on thin/weak local memory or a time-sensitive query; always = every query; ondemand = only explicit research/learn actions; off = never.",
    group: "Privacy & network",
    type: "enum",
    envVar: "WEB_SEARCH_MODE",
    options: ["smart", "always", "ondemand", "off"],
  },
  {
    key: "hybridResearch",
    label: "Hybrid web research",
    description: "Master switch for fusing local memory + live web into answers. (Still gated by Local-only.)",
    group: "Privacy & network",
    type: "boolean",
    envVar: "HYBRID_RESEARCH",
  },

  // ── Speed ────────────────────────────────────────────────────────────────
  {
    key: "fastMode",
    label: "Fast mode",
    description: "Bias toward the cheap path — more answers stream straight from retrieved memory instead of paying extra reasoning round-trips.",
    group: "Speed",
    type: "boolean",
    envVar: "BRAIN_FAST_MODE",
  },
  {
    key: "fastModeMaxTokens",
    label: "Fast answer length cap",
    description: "Max tokens for a fast-path answer, so replies stay crisp instead of rambling.",
    group: "Speed",
    type: "number",
    envVar: "BRAIN_FAST_MODE_MAX_TOKENS",
    min: 128,
    max: 4096,
    step: 64,
  },
  {
    key: "fastModeDepthThreshold",
    label: "Slow-path difficulty gate",
    description: "How hard a query must be (0–1) to take the slow, thorough route. Higher = more queries answer fast.",
    group: "Speed",
    type: "number",
    envVar: "BRAIN_FAST_MODE_DEPTH_THRESHOLD",
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    key: "fastSalvage",
    label: "Salvage thin fast answers",
    description: "When a fast answer retrieves little/weak memory, transparently escalate to the full path instead of answering thin.",
    group: "Speed",
    type: "boolean",
    envVar: "FAST_SALVAGE",
  },
  {
    key: "ollamaKeepAlive",
    label: "Keep local models warm",
    description:
      "How long Ollama keeps a model loaded after a request. Longer = no cold reload between questions (faster), at the cost of holding VRAM/RAM. '-1' keeps it forever; '0' unloads immediately.",
    group: "Speed",
    type: "enum",
    envVar: "OLLAMA_KEEP_ALIVE",
    options: ["0", "5m", "30m", "1h", "24h", "-1"],
  },

  // ── Retrieval (RAG) ──────────────────────────────────────────────────────
  {
    key: "multiQueryRag",
    label: "Multi-query retrieval",
    description: "On weak local memory, rephrase the query a few ways and fuse the results for higher recall.",
    group: "Retrieval",
    type: "boolean",
    envVar: "MULTI_QUERY_RAG",
  },
  {
    key: "rerankerEnabled",
    label: "Lexical reranker",
    description: "Learned query-aware reranker that reorders the top results after the main ranker. No-op until it has trained.",
    group: "Retrieval",
    type: "boolean",
    envVar: "RERANKER",
  },
  {
    key: "hebbianRetrieval",
    label: "Associative (Hebbian) recall",
    description: "Co-cited memories wire together; strong associations pull related memories into the candidate pool.",
    group: "Retrieval",
    type: "boolean",
    envVar: "HEBBIAN_RETRIEVAL",
  },
  {
    key: "predictiveProcessing",
    label: "Predictive processing",
    description: "Predict retrieval quality before searching and learn from the surprise. Zero effect until warmed up.",
    group: "Retrieval",
    type: "boolean",
    envVar: "PREDICTIVE_PROCESSING",
  },
  {
    key: "adaptiveController",
    label: "RL adaptive controller",
    description: "A contextual bandit that learns the augment / retrieval-k / multi-query decisions from citation usage. Opt-in.",
    group: "Retrieval",
    type: "boolean",
    envVar: "ADAPTIVE_CONTROLLER",
  },
  {
    key: "citationFaithfulness",
    label: "Citation faithfulness check",
    description: "Verify each citation's claim is actually supported by the cited memory; unfaithful ones are flagged and not rewarded.",
    group: "Retrieval",
    type: "boolean",
    envVar: "CITATION_FAITHFULNESS",
  },

  // ── Reasoning ────────────────────────────────────────────────────────────
  {
    key: "parallelReasoning",
    label: "Parallel reasoning drafts",
    description: "On a hard query, sample several reasoning drafts and keep the most consistent. Costs more LLM calls.",
    group: "Reasoning",
    type: "boolean",
    envVar: "PARALLEL_REASONING",
  },
  {
    key: "combinedReasoningError",
    label: "Combine reasoning + error check (faster)",
    description:
      "On hard queries, merge the reasoning plan and the contradiction/confidence check into ONE model call instead of two — cuts a round-trip so the answer starts sooner. Slightly weaker as an independent check; falls back to two calls if the merged result is incomplete.",
    group: "Reasoning",
    type: "boolean",
    envVar: "COMBINED_REASONING_ERROR",
  },
  {
    key: "adaptiveDepth",
    label: "Outcome-learned depth",
    description: "Nudge the slow-path difficulty gate from observed citation outcomes. Returns the base gate exactly until warmed up.",
    group: "Reasoning",
    type: "boolean",
    envVar: "ADAPTIVE_DEPTH",
  },
  {
    key: "narrativeGrounding",
    label: "Narrative grounding",
    description: "Inject a compact first-person identity preamble into the reasoning + response prompts.",
    group: "Reasoning",
    type: "boolean",
    envVar: "NARRATIVE_GROUNDING",
  },

  // ── Actions & agent ──────────────────────────────────────────────────────
  {
    key: "allowShell",
    label: "Allow shell / app actions",
    description:
      "Let the brain run shell commands and launch apps on this PC. The broadest capability — every run is STILL confirm-gated and audited, but turning this off removes the ability entirely.",
    group: "Actions & agent",
    type: "boolean",
    envVar: "ALLOW_SHELL",
    danger: true,
  },
  {
    key: "agentConfirmMode",
    label: "Default confirm mode",
    description: "How confirm-tier actions are handled by default. ask = pause for approval; scope = run within a granted ceiling; safe-only = never run confirm-tier autonomously.",
    group: "Actions & agent",
    type: "enum",
    envVar: "AGENT_CONFIRM_MODE",
    options: ["ask", "scope", "safe-only"],
  },
  {
    key: "agentMaxRounds",
    label: "Agent max rounds",
    description: "How many think→act rounds the agent loop runs before it is asked to wrap up.",
    group: "Actions & agent",
    type: "number",
    envVar: "AGENT_MAX_ROUNDS",
    min: 1,
    max: 50,
    step: 1,
  },

  // ── Models ───────────────────────────────────────────────────────────────
  {
    key: "remoteFallback",
    label: "Fall back to local model",
    description: "If a remote provider fails mid-answer, fall back to a local model (tagged [degraded]) instead of surfacing the error.",
    group: "Models",
    type: "boolean",
    envVar: "REMOTE_FALLBACK",
  },

  // ── Memory ───────────────────────────────────────────────────────────────
  {
    key: "dedupAutoMerge",
    label: "Auto-merge duplicates",
    description: "Automatically merge near-duplicate memories on the daily audit. Off by default — at the default threshold this can merge distinct-but-related memories (merges are reversible from the Memory Inspector).",
    group: "Memory",
    type: "boolean",
    envVar: "DEDUP_AUTO_MERGE",
    danger: true,
  },

  // ── Cognition (restart to fully apply) ───────────────────────────────────
  {
    key: "sleepCycle",
    label: "Sleep cycle",
    description: "Nightly episodic→semantic distillation + association decay. The schedule is wired at boot.",
    group: "Cognition",
    type: "boolean",
    envVar: "SLEEP_CYCLE",
    requiresRestart: true,
  },
  {
    key: "workspaceEnabled",
    label: "Global workspace (autonomous thoughts)",
    description: "Subsystems bid for an LLM micro-thought on an interval. The schedule is wired at boot.",
    group: "Cognition",
    type: "boolean",
    envVar: "WORKSPACE",
    requiresRestart: true,
  },
];

// CONFIG is typed ServerConfig; the catalog only touches boolean/number/string
// properties. Narrow, local casts keep the rest of the code type-safe.
function readConfigValue(key: string): SettingValue {
  return (CONFIG as unknown as Record<string, SettingValue>)[key];
}
function setConfigValue(key: string, value: SettingValue): void {
  (CONFIG as unknown as Record<string, SettingValue>)[key] = value;
}

// Env-resolved baseline, captured ONCE at module load (config.ts has already run,
// so this is the .env/default state BEFORE any persisted override). reset()
// restores this — i.e. "revert my runtime edits, go back to .env".
const BASELINE: Record<string, SettingValue> = {};
for (const spec of SETTINGS_CATALOG) {
  BASELINE[spec.key] = readConfigValue(spec.key);
}

type Coerced = { ok: true; value: SettingValue } | { ok: false; error: string };

// Validate + normalise a raw incoming value against a spec. Numbers are clamped
// to the spec bounds (same clamping config.ts applies to the env var); enums must
// match an allowed option; booleans accept real booleans or "true"/"false".
function coerce(spec: SettingSpec, raw: unknown): Coerced {
  if (spec.type === "boolean") {
    if (typeof raw === "boolean") return { ok: true, value: raw };
    if (raw === "true" || raw === "false") return { ok: true, value: raw === "true" };
    return { ok: false, error: "expected a boolean" };
  }
  if (spec.type === "number") {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n)) return { ok: false, error: "expected a number" };
    const lo = spec.min ?? n;
    const hi = spec.max ?? n;
    return { ok: true, value: Math.min(hi, Math.max(lo, n)) };
  }
  // enum
  const s = String(raw);
  if (!spec.options || !spec.options.includes(s)) {
    return { ok: false, error: `expected one of: ${spec.options?.join(", ") ?? ""}` };
  }
  return { ok: true, value: s };
}

function readMeta(key: string): string | null {
  try {
    const row = openDb().prepare("SELECT value FROM brain_metadata WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch (err) {
    surfaceError("settings.readMeta", err);
    return null;
  }
}

function writeMeta(key: string, value: string): void {
  try {
    openDb()
      .prepare(
        "INSERT INTO brain_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  } catch (err) {
    surfaceError("settings.writeMeta", err);
  }
}

// Persist ONLY the keys whose current effective value differs from the env
// baseline. Keeping the row to diffs means an unchanged knob is never pinned —
// a future code/env default change still flows through.
function persistOverrides(): void {
  const overrides: Record<string, SettingValue> = {};
  for (const spec of SETTINGS_CATALOG) {
    const cur = readConfigValue(spec.key);
    if (cur !== BASELINE[spec.key]) overrides[spec.key] = cur;
  }
  writeMeta(META_KEY, JSON.stringify(overrides));
}

/**
 * Boot hook — overlay any persisted overrides onto the live CONFIG object. Call
 * once, early in server startup (after openDb, before the routers/agents read
 * config). Failure-isolated: a bad row can never block boot.
 */
export function applyPersistedSettings(): void {
  const raw = readMeta(META_KEY);
  if (!raw) return;
  try {
    const overrides = JSON.parse(raw) as Record<string, unknown>;
    let applied = 0;
    for (const [key, val] of Object.entries(overrides)) {
      const spec = SETTINGS_CATALOG.find((s) => s.key === key);
      if (!spec) continue;
      const c = coerce(spec, val);
      if (c.ok) {
        setConfigValue(key, c.value);
        applied += 1;
      }
    }
    if (applied > 0) console.log(`[settings] applied ${applied} persisted override(s)`);
  } catch (err) {
    surfaceError("settings.apply", err);
  }
}

export function getSettingsView(): SettingsView {
  const settings = SETTINGS_CATALOG.map((spec) => ({ ...spec, value: readConfigValue(spec.key) }));
  const groups: string[] = [];
  for (const s of SETTINGS_CATALOG) if (!groups.includes(s.group)) groups.push(s.group);
  return { groups, settings };
}

/**
 * Validate + apply a patch of { key: value }. Each key is checked against the
 * catalog and coerced; valid keys mutate the live CONFIG and are persisted.
 * Unknown keys / bad values are collected in `errors` and skipped — a partial
 * patch still applies the good keys.
 */
export function updateSettings(patch: Record<string, unknown>): UpdateSettingsResult {
  const applied: string[] = [];
  const restartRequired: string[] = [];
  const errors: Record<string, string> = {};

  for (const [key, raw] of Object.entries(patch)) {
    const spec = SETTINGS_CATALOG.find((s) => s.key === key);
    if (!spec) {
      errors[key] = "unknown setting";
      continue;
    }
    const c = coerce(spec, raw);
    if (!c.ok) {
      errors[key] = c.error;
      continue;
    }
    setConfigValue(key, c.value);
    applied.push(key);
    if (spec.requiresRestart) restartRequired.push(key);
  }

  if (applied.length > 0) persistOverrides();

  return {
    ok: Object.keys(errors).length === 0,
    applied,
    restartRequired,
    errors,
    view: getSettingsView(),
  };
}

/** Restore every editable knob to its env/.env baseline and clear the overrides. */
export function resetSettings(): SettingsView {
  for (const spec of SETTINGS_CATALOG) setConfigValue(spec.key, BASELINE[spec.key]);
  writeMeta(META_KEY, "{}");
  return getSettingsView();
}
