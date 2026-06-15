// Spinal motor pools — the OpenClaw "persona-forge" layer.
//
// A motor pool is a specialised descending controller: a named persona with a
// domain, a set of actions it's biased toward, a risk ceiling, and a prompt
// FLAVOR that shapes the deliberate tract's "voice" when this pool drives it.
// The dispatcher (cord.ts) routes an intent to a pool by keyword; the chosen
// pool's flavor is prepended to the agent-loop prompt so a "Courier" task reads
// and acts differently from a "Scholar" task — without ever changing WHAT is
// allowed (the per-action executor gate is the authority; `ceiling` only
// narrows, never widens).
//
// PURE + deterministic (no DB, no LLM) so the spine selfcheck can pin routing.

import type { SpinalPersona, SpinalPersonaId } from "../../../shared/spine.js";
import { tokens } from "../attention/saliency.js";

// The built-in pools. Order matters only for the deterministic tie-break in
// pickPersona (earlier wins an equal score).
const PERSONAS: Record<SpinalPersonaId, SpinalPersona> = {
  courier: {
    id: "courier",
    name: "Courier",
    domain: "files · web · movement",
    description:
      "Moves things: reads and writes files, fetches and learns web pages, opens paths, drives git. The messenger that carries data between places.",
    preferredActions: [
      "list-directory",
      "read-file",
      "write-file",
      "open-path",
      "open-url",
      "learn-url",
      "research-web",
      "git-clone",
      "git-read-file",
      "git-write-file",
    ],
    ceiling: "confirm",
    flavor:
      "Act as the Courier: a precise logistics agent. Move data deliberately, name exact paths/URLs, and confirm each transfer landed before reporting done.",
  },
  scribe: {
    id: "scribe",
    name: "Scribe",
    domain: "memory · notes · recall",
    description:
      "Tends the brain's own memory: searches recall, lists recent memories, writes notes, and reasons over what's stored. The keeper of the record.",
    preferredActions: ["search-memory", "recent-memories", "create-note", "deep-reason"],
    ceiling: "confirm",
    flavor:
      "Act as the Scribe: the memory-keeper. Prefer the brain's own memory (deep-reason / search-memory) over outside sources, cite what you recall, and write durable notes.",
  },
  mechanic: {
    id: "mechanic",
    name: "Mechanic",
    domain: "system · shell · the machine",
    description:
      "Operates the machine itself: reads system metrics, runs commands, launches apps, triggers scans. The hands that touch the hardware.",
    preferredActions: ["system-info", "run-command", "launch-app", "trigger-scan"],
    ceiling: "confirm",
    flavor:
      "Act as the Mechanic: the machine operator. Inspect with system-info before you change anything, run the smallest command that does the job, and read the real exit code/output before declaring success.",
  },
  scholar: {
    id: "scholar",
    name: "Scholar",
    domain: "research · reasoning · the world",
    description:
      "Reaches outward to learn: searches the web, researches and learns pages, discovers GitHub projects, and reasons over the result. The investigator.",
    preferredActions: ["web-search", "research-web", "github-search", "github-learn", "deep-reason"],
    ceiling: "confirm",
    flavor:
      "Act as the Scholar: the investigator. Gather from multiple sources, weigh them, and ground the final answer in what you actually found — never assert beyond the evidence.",
  },
  connector: {
    id: "connector",
    name: "Connector",
    domain: "MCP · external tools · integrations",
    description:
      "The MCP envoy: reaches external Model Context Protocol servers (filesystem, git, fetch, and whatever else is wired) and drives their tools. The brain's plug into the wider tool ecosystem.",
    // A HINT — the live MCP tool ids are dynamic (mcp-<server>-<tool>); the flavor
    // steers the loop toward whichever mcp-* tools appear in its tool list.
    preferredActions: ["mcp-filesystem-read_file", "mcp-git-status", "mcp-fetch-fetch", "deep-reason"],
    ceiling: "confirm",
    flavor:
      "Act as the Connector: the MCP envoy. Prefer the external mcp-* tools in your tool list for this task, pass exactly the arguments their schema expects, and read each tool's real result before the next step.",
  },
  reflex: {
    id: "reflex",
    name: "Reflex",
    domain: "instant · safe · no-thought",
    description:
      "The minimal spinal pool: answers and acts only through fast safe reflexes and read-only tools. Never engages the deliberate tract. The knee-jerk.",
    preferredActions: ["system-info", "recent-memories", "search-memory", "deep-reason"],
    ceiling: "safe",
    flavor:
      "Act as the Reflex pool: minimal and immediate. Use only fast, read-only tools; do the obvious safe thing and stop.",
  },
};

// Keyword cues per pool — deterministic routing. A token hit on any cue scores
// the pool; the highest score wins, ties broken by PERSONA declaration order.
const CUES: Record<SpinalPersonaId, string[]> = {
  courier: [
    "file", "files", "folder", "directory", "path", "read", "write", "save",
    "open", "url", "download", "fetch", "git", "clone", "repo", "move", "copy",
  ],
  scribe: [
    "memory", "memories", "remember", "recall", "note", "notes", "remind",
    "recent", "stored", "know", "knowledge",
  ],
  mechanic: [
    "system", "cpu", "memory", "disk", "ram", "specs", "command", "run", "shell",
    "launch", "app", "process", "scan", "machine", "computer", "hardware",
  ],
  scholar: [
    "search", "web", "research", "internet", "online", "github", "learn",
    "discover", "explore", "look", "investigate", "browse",
  ],
  connector: ["mcp", "integration", "plugin", "connector", "envoy"],
  reflex: [],
};

export function listPersonas(): SpinalPersona[] {
  return Object.values(PERSONAS);
}

export function getPersona(id: SpinalPersonaId): SpinalPersona {
  return PERSONAS[id];
}

export function isPersonaId(id: unknown): id is SpinalPersonaId {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(PERSONAS, id);
}

/**
 * Route an intent to a motor pool by keyword. Deterministic: scores each pool
 * by token overlap with its cue set and returns the best, defaulting to the
 * Scribe (the memory-first pool) when nothing matches. `reflex` is never
 * auto-selected here — it's an explicit opt-in pool — so a plain question lands
 * on a real deliberate pool.
 */
export function pickPersona(intent: string): SpinalPersona {
  const toks = new Set(tokens(intent));
  let best: SpinalPersona = PERSONAS.scribe;
  let bestScore = 0;
  for (const persona of Object.values(PERSONAS)) {
    if (persona.id === "reflex") continue;
    let score = 0;
    for (const cue of CUES[persona.id]) if (toks.has(cue)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = persona;
    }
  }
  return best;
}

/**
 * The persona's prompt flavor, plus a one-line bias toward its preferred
 * actions. Prepended to the deliberate tract's request so the loop's "voice"
 * matches the pool. Pure string assembly.
 */
export function personaDirective(persona: SpinalPersona): string {
  return [
    `[Motor pool: ${persona.name} — ${persona.domain}]`,
    persona.flavor,
    `Preferred tools for this pool: ${persona.preferredActions.join(", ")}.`,
  ].join("\n");
}
