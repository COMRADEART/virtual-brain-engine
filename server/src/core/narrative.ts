// Narrative self ("mythos") — synthesise a coherent FIRST-PERSON self-narrative
// from the brain's identity material and persist it for prompt grounding.
//
// Generative-agents-style REFLECTION: beliefs + goals + developmental stage +
// competence + recent episodes → {identity, arc, values, pursuits}.
//
// Three public layers:
//   PURE helpers  — buildNarrativeInput, parseNarrative, narrativePreamble
//   SIDE-EFFECTING — synthesizeNarrative (gather → LLM → validate → persist → emit)
//   READ-ONLY      — getNarrative (load KV, validate, never throw)
//
// Integration path: the preamble is injected into reasoning prompts by a
// SEPARATE integration pass (no new pipeline call site here).
//
// Failure isolation: every DB/LLM/engine touch is wrapped in try/catch →
// surfaceError; this module NEVER throws to its callers.

import { openDb } from "../db/sqlite.js";
import { surfaceError } from "../util/diagnostics.js";
import { getEventBus, nowIso } from "./eventBus.js";
import { clampMagnitude, regionsFor } from "../../../shared/cognition.js";
import type { Connector } from "../connectors/Connector.js";

// ---------------------------------------------------------------------------
// Public interface types
// ---------------------------------------------------------------------------

export interface NarrativeInput {
  stage: number;
  beliefs: ReadonlyArray<{ statement: string; confidence: number }>;
  goals: ReadonlyArray<string>;
  competence: ReadonlyArray<{ domain: string; confidence: number }>;
  episodes: ReadonlyArray<string>;
}

export interface SelfNarrative {
  identity: string;   // 1-2 sentences: who I am
  arc: string;        // 1-2 sentences: how I've grown
  values: string[];   // 2-4 short phrases
  pursuits: string[]; // 2-4 short phrases
  updatedAt: string;  // ISO
}

export interface SynthesizeOptions {
  connector?: Connector | null;
  now?: string;
  input?: NarrativeInput;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const NARRATIVE_KEY = "self-narrative-v1";
export const PREAMBLE_MAX_LEN = 240;

const MAX_BELIEFS = 6;
const MAX_GOALS = 5;
const MAX_COMPETENCE = 6;
const MAX_EPISODES = 4;
const EPISODE_SNIPPET_LEN = 120;
const MAX_VALUES = 4;
const MAX_PURSUITS = 4;

export const NARRATIVE_SYSTEM = `You are the self-reflection core of a cognitive brain. Synthesise the input into a FIRST-PERSON self-narrative.

Respond with STRICT JSON — no preamble, no markdown, no trailing text:
{
  "identity": "<1-2 sentences in first person: who I am, what I do>",
  "arc":      "<1-2 sentences in first person: how I have grown and what I have learned>",
  "values":   ["<short phrase>", "<short phrase>", "<short phrase>"],
  "pursuits": ["<short phrase>", "<short phrase>", "<short phrase>"]
}

Rules:
- identity: 1-2 sentences, first person ("I am …")
- arc: 1-2 sentences, first person, describes growth/learning arc
- values: 2-4 phrases (beliefs / principles that guide me)
- pursuits: 2-4 phrases (active goals / things I am working toward)
- JSON ONLY — no prose outside the JSON object`;

// ---------------------------------------------------------------------------
// PURE helpers
// ---------------------------------------------------------------------------

/**
 * Assemble the bounded structured brief the LLM distills into a narrative.
 * Deterministic — no side effects, no randomness.
 */
export function buildNarrativeInput(input: NarrativeInput): string {
  const lines: string[] = [];

  lines.push(`Developmental stage: ${input.stage} / 7`);

  if (input.beliefs.length > 0) {
    lines.push("\nCore beliefs (statement — confidence):");
    input.beliefs
      .slice(0, MAX_BELIEFS)
      .forEach(({ statement, confidence }) => {
        lines.push(`  - ${statement.trim().slice(0, 160)} (${(confidence * 100).toFixed(0)}%)`);
      });
  }

  if (input.goals.length > 0) {
    lines.push("\nActive goals:");
    input.goals.slice(0, MAX_GOALS).forEach((g) => {
      lines.push(`  - ${g.trim().slice(0, 120)}`);
    });
  }

  if (input.competence.length > 0) {
    lines.push("\nCompetence profile:");
    input.competence.slice(0, MAX_COMPETENCE).forEach(({ domain, confidence }) => {
      const label = confidence >= 0.6 ? "strong" : confidence >= 0.35 ? "developing" : "weak";
      lines.push(`  - ${domain}: ${label} (${(confidence * 100).toFixed(0)}%)`);
    });
  }

  if (input.episodes.length > 0) {
    lines.push("\nRecent experiences:");
    input.episodes.slice(0, MAX_EPISODES).forEach((ep) => {
      lines.push(`  - ${ep.trim().slice(0, EPISODE_SNIPPET_LEN)}`);
    });
  }

  return lines.join("\n");
}

/**
 * Robust JSON parse with regex fallback — mirrors parseFacts in sleepCycle.ts.
 * Validates shape; clamps values/pursuits arrays to ≤4 each; trims strings.
 * Returns null on garbage input.
 */
export function parseNarrative(text: string, now?: string): SelfNarrative | null {
  const updatedAt = now ?? nowIso();

  function tryParse(raw: string): SelfNarrative | null {
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!obj || typeof obj !== "object") return null;
    const o = obj as Record<string, unknown>;
    const identity = typeof o["identity"] === "string" ? o["identity"].trim() : "";
    const arc = typeof o["arc"] === "string" ? o["arc"].trim() : "";
    if (!identity || !arc) return null;

    const toStrArr = (v: unknown): string[] => {
      if (!Array.isArray(v)) return [];
      return v
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.trim())
        .slice(0, MAX_VALUES);
    };

    const values = toStrArr(o["values"]);
    const pursuits = toStrArr(o["pursuits"]).slice(0, MAX_PURSUITS);

    return { identity, arc, values, pursuits, updatedAt };
  }

  // Primary: direct parse
  const direct = tryParse(text);
  if (direct !== null) return direct;

  // Fallback: extract first {...} block
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    return tryParse(match[0]);
  }

  return null;
}

/**
 * Compact first-person creed line(s) for prompt grounding.
 * Empty string when narrative is null; length-bounded by maxLen.
 */
export function narrativePreamble(n: SelfNarrative | null, maxLen: number = PREAMBLE_MAX_LEN): string {
  if (!n) return "";
  const parts: string[] = [n.identity];
  if (n.arc) parts.push(n.arc);
  const joined = parts.join(" ").trim();
  if (joined.length <= maxLen) return joined;
  return joined.slice(0, maxLen - 1) + "…";
}

// ---------------------------------------------------------------------------
// KV persistence helpers (failure-isolated)
// ---------------------------------------------------------------------------

function saveNarrative(n: SelfNarrative): void {
  try {
    openDb()
      .prepare(
        "INSERT INTO brain_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(NARRATIVE_KEY, JSON.stringify(n));
  } catch (err) {
    surfaceError("narrative.save", err);
  }
}

function loadNarrativeFromKv(): SelfNarrative | null {
  try {
    const row = openDb()
      .prepare("SELECT value FROM brain_metadata WHERE key = ?")
      .get(NARRATIVE_KEY) as { value: string } | undefined;
    if (!row) return null;
    const parsed = parseNarrative(row.value);
    return parsed;
  } catch (err) {
    surfaceError("narrative.load", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Read-only accessor
// ---------------------------------------------------------------------------

/** Load the persisted narrative (null if none / broken store). Never throws. */
export function getNarrative(): SelfNarrative | null {
  return loadNarrativeFromKv();
}

// ---------------------------------------------------------------------------
// Gather from engines (best-effort; each source in its own try/catch)
// ---------------------------------------------------------------------------

async function gatherInput(now: string): Promise<NarrativeInput> {
  let stage = 1;
  try {
    const { currentStage } = await import("./stages.js");
    stage = currentStage();
  } catch (err) {
    surfaceError("narrative.gather.stage", err);
  }

  let beliefs: Array<{ statement: string; confidence: number }> = [];
  try {
    const { getBeliefEngine } = await import("./beliefs.js");
    const recs = getBeliefEngine().listBeliefs({ limit: 8 });
    beliefs = recs.map((r) => ({ statement: r.statement, confidence: r.confidence }));
  } catch (err) {
    surfaceError("narrative.gather.beliefs", err);
  }

  let goals: string[] = [];
  try {
    const { getPersistentOrganism } = await import("./organism.js");
    goals = getPersistentOrganism().getActiveGoalTitles(6);
  } catch (err) {
    surfaceError("narrative.gather.goals", err);
  }

  let competence: Array<{ domain: string; confidence: number }> = [];
  try {
    const { loadSelfModelState } = await import("./selfModel.js");
    const state = loadSelfModelState();
    competence = Object.entries(state.competence ?? {}).map(([domain, confidence]) => ({
      domain,
      confidence: typeof confidence === "number" ? confidence : 0,
    }));
  } catch (err) {
    surfaceError("narrative.gather.competence", err);
  }

  let episodes: string[] = [];
  try {
    const { listEpisodes } = await import("../memory/episodes.js");
    const recs = listEpisodes(5);
    episodes = recs.map((r) => r.title || JSON.stringify(r).slice(0, 100));
  } catch (err) {
    surfaceError("narrative.gather.episodes", err);
  }

  void now; // used only to avoid unused-var lint; ISO timestamp passed in for testability
  return { stage, beliefs, goals, competence, episodes };
}

// ---------------------------------------------------------------------------
// Side-effecting: synthesise → validate → persist → emit
// ---------------------------------------------------------------------------

/**
 * Synthesise a self-narrative from identity material.
 * Wraps the whole call chain in failure isolation — never throws.
 */
export async function synthesizeNarrative(
  opts: SynthesizeOptions = {},
): Promise<{ narrative: SelfNarrative | null; reason?: string }> {
  const now = opts.now ?? nowIso();

  // 1. Resolve input
  let input: NarrativeInput;
  if (opts.input !== undefined) {
    input = opts.input;
  } else {
    try {
      input = await gatherInput(now);
    } catch (err) {
      surfaceError("narrative.gather", err);
      input = { stage: 1, beliefs: [], goals: [], competence: [], episodes: [] };
    }
  }

  // 2. Resolve connector
  let connector: Connector | null;
  if (opts.connector !== undefined) {
    connector = opts.connector;
  } else {
    try {
      const { getDefaultConnectorInstance } = await import("../connectors/registry.js");
      connector = getDefaultConnectorInstance();
    } catch (err) {
      surfaceError("narrative.connector", err);
      connector = null;
    }
  }
  if (!connector) {
    return { narrative: null, reason: "no connector" };
  }

  // 3. Call LLM
  let raw: string;
  try {
    raw = await connector.send(buildNarrativeInput(input), {
      system: NARRATIVE_SYSTEM,
      format: "json",
      temperature: 0.3,
    });
  } catch (err) {
    surfaceError("narrative.synthesis", err);
    return { narrative: null, reason: "synthesis failed" };
  }

  // 4. Validate
  const narrative = parseNarrative(raw, now);
  if (!narrative) {
    return { narrative: null, reason: "unparseable" };
  }

  // 5. Persist
  saveNarrative(narrative);

  // 6. Emit cognition event (failure-isolated)
  try {
    const label = `My self-narrative: ${narrative.identity.slice(0, 80)}`;
    const cognitionEvent = {
      kind: "reflection" as const,
      label,
      detail: narrative.arc,
      magnitude: clampMagnitude(0.5),
      logicalRegions: regionsFor("reflection"),
      reason: "narrative:synthesize",
      at: now,
    };
    getEventBus().emit({ kind: "cognition", event: cognitionEvent, at: now });
  } catch (err) {
    surfaceError("narrative.emit", err);
  }

  return { narrative };
}
