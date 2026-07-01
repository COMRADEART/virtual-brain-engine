// Narrative-self ("mythos") selfcheck — hermetic (throwaway DB, scripted
// stub connector, NO network, NO LLM).
//
// Run:  npx tsx server/scripts/narrative-selfcheck.ts
//       (or: npm --prefix server run narrative:selfcheck)
//
// Asserts:
//   1. buildNarrativeInput: non-empty brief, mentions belief + goal, bounded.
//   2. parseNarrative: clean JSON → valid SelfNarrative; arrays clamped to ≤4.
//   3. parseNarrative: messy wrapped JSON still parses; "not json" → null.
//   4. narrativePreamble: null → ""; valid → first-person, non-empty, ≤ PREAMBLE_MAX_LEN.
//   5. synthesizeNarrative: scripted stub → non-null narrative; getNarrative round-trips.
//   6. synthesizeNarrative: null connector → { narrative: null, reason: "no connector" };
//      prior persisted narrative still readable (persist-nothing contract).
//   7. Failure isolation: throwing connector → reason, no throw; garbage raw →
//      reason "unparseable", persists nothing; broken brain_metadata table → null,
//      no throw.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

// ── Throwaway DB ──────────────────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), "brain-narrative-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

// ── Module under test ─────────────────────────────────────────────────────────
const {
  buildNarrativeInput,
  parseNarrative,
  narrativePreamble,
  synthesizeNarrative,
  getNarrative,
  PREAMBLE_MAX_LEN,
} = await import("../src/core/narrative.js");

import type { Connector } from "../src/connectors/Connector.js";
import type { NarrativeInput, SelfNarrative } from "../src/core/narrative.js";
const { openDb } = await import("../src/db/sqlite.js");
const { getEventBus } = await import("../src/core/eventBus.js");

const db = openDb();

// ── Shared stub input ─────────────────────────────────────────────────────────
const stubInput: NarrativeInput = {
  stage: 3,
  beliefs: [
    { statement: "Clarity of thought produces better outcomes than speed", confidence: 0.82 },
    { statement: "Persistent curiosity is more valuable than prior knowledge", confidence: 0.71 },
  ],
  goals: [
    "Understand the project codebase end-to-end",
    "Improve retrieval precision for technical queries",
  ],
  competence: [
    { domain: "typescript", confidence: 0.78 },
    { domain: "sql", confidence: 0.45 },
    { domain: "machine-learning", confidence: 0.22 },
  ],
  episodes: [
    "Debugged a subtle race condition in the pipeline memory step",
    "Distilled three semantic facts from today's conversation log",
  ],
};

const VALID_NARRATIVE_JSON = JSON.stringify({
  identity: "I am a cognitive brain assistant specialising in local-first reasoning.",
  arc: "I have grown from storing isolated facts to forming coherent beliefs and goals.",
  values: ["truth over agreement", "evidence over assumption"],
  pursuits: ["improve retrieval recall", "form richer beliefs"],
});

// ── 1. buildNarrativeInput ────────────────────────────────────────────────────
{
  const brief = buildNarrativeInput(stubInput);
  check("brief is non-empty", brief.length > 0);
  check(
    "brief mentions a belief statement",
    brief.includes("Clarity of thought") || brief.includes("Persistent curiosity"),
    brief.slice(0, 120),
  );
  check(
    "brief mentions a goal",
    brief.includes("Understand the project") || brief.includes("Improve retrieval"),
    brief.slice(0, 120),
  );
  // Bounded: each field snippet is short — full brief must be under 4 kB for any
  // reasonable stub input (it's never truncated at call-site, but should be compact).
  check("brief is reasonably bounded (<= 4000 chars)", brief.length <= 4000, `len=${brief.length}`);
}

// ── 2. parseNarrative: clean JSON → valid shape ───────────────────────────────
{
  const n = parseNarrative(VALID_NARRATIVE_JSON, "2026-01-01T00:00:00.000Z");
  check("parseNarrative: valid JSON → non-null", n !== null);
  if (n) {
    check("identity present", typeof n.identity === "string" && n.identity.length > 0);
    check("arc present", typeof n.arc === "string" && n.arc.length > 0);
    check("values is array", Array.isArray(n.values));
    check("pursuits is array", Array.isArray(n.pursuits));
    check("values clamped to <=4", n.values.length <= 4, `len=${n.values.length}`);
    check("pursuits clamped to <=4", n.pursuits.length <= 4, `len=${n.pursuits.length}`);
    check("updatedAt is ISO string", n.updatedAt === "2026-01-01T00:00:00.000Z");
  }
}

// Arrays longer than 4 are clamped
{
  const bigArr = JSON.stringify({
    identity: "I am …",
    arc: "I grew …",
    values: ["a", "b", "c", "d", "e", "f"],
    pursuits: ["x", "y", "z", "w", "v"],
  });
  const n = parseNarrative(bigArr);
  check("values array clamped to 4", n !== null && n.values.length === 4);
  check("pursuits array clamped to 4", n !== null && n.pursuits.length === 4);
}

// ── 3. parseNarrative: messy wrapped JSON + pure garbage ─────────────────────
{
  const messy = `Here is the result:\n\n${VALID_NARRATIVE_JSON}\n\nThat was the JSON.`;
  const n = parseNarrative(messy);
  check("messy wrapped JSON parses", n !== null, messy.slice(0, 60));
}
{
  const n = parseNarrative("not json at all");
  check("garbage input → null", n === null);
}
{
  const n = parseNarrative('{"other_key": "value"}');
  check("JSON missing identity/arc → null", n === null);
}

// ── 4. narrativePreamble ──────────────────────────────────────────────────────
{
  check("narrativePreamble(null) === ''", narrativePreamble(null) === "");
}
{
  const n = parseNarrative(VALID_NARRATIVE_JSON, "2026-01-01T00:00:00.000Z");
  if (n) {
    const pre = narrativePreamble(n);
    check("preamble is non-empty", pre.length > 0);
    check("preamble is first-person (starts with 'I ')", pre.startsWith("I "), pre.slice(0, 40));
    check(
      `preamble <= PREAMBLE_MAX_LEN (${PREAMBLE_MAX_LEN})`,
      pre.length <= PREAMBLE_MAX_LEN,
      `len=${pre.length}`,
    );

    // Custom maxLen
    const short = narrativePreamble(n, 20);
    check("custom maxLen is respected", short.length <= 20, `len=${short.length}`);
  }
}

// ── 5. synthesizeNarrative: scripted stub → non-null; getNarrative round-trips ─
{
  let cognitionEmitted = false;
  const off = getEventBus().on("cognition", (e) => {
    if (e.event.kind === "reflection") cognitionEmitted = true;
  });

  const stubConnector = {
    descriptor: { id: "stub", kind: "ollama" as const },
    send: async (_prompt: string) => VALID_NARRATIVE_JSON,
    stream: async function* () { yield ""; },
    listModels: async () => [],
    test: async () => ({ ok: true as const }),
  } as unknown as Connector;

  const result = await synthesizeNarrative({ connector: stubConnector, input: stubInput });
  off();

  check("synthesizeNarrative: result non-null", result.narrative !== null, JSON.stringify(result));
  check("synthesizeNarrative: no error reason on success", result.reason === undefined);
  if (result.narrative) {
    check("identity is correct", result.narrative.identity.includes("cognitive brain"));
  }

  const persisted = getNarrative();
  check("getNarrative round-trips persisted narrative", persisted !== null);
  if (persisted) {
    check("persisted identity matches", persisted.identity === result.narrative?.identity);
  }

  check("cognition 'reflection' event was emitted", cognitionEmitted);
}

// ── 6. null connector → no persist; prior narrative still readable ─────────────
{
  // We already have a persisted narrative from step 5.
  const beforeNull = getNarrative();
  check("prior narrative exists before null-connector call", beforeNull !== null);

  const nullResult = await synthesizeNarrative({ connector: null, input: stubInput });
  check("null connector → narrative: null", nullResult.narrative === null);
  check("null connector → reason: 'no connector'", nullResult.reason === "no connector");

  // Persisted narrative must be unchanged (persist-nothing contract)
  const afterNull = getNarrative();
  check("prior narrative unchanged after null-connector call", afterNull !== null);
  if (beforeNull && afterNull) {
    check("identity unchanged", afterNull.identity === beforeNull.identity);
  }
}

// ── 7. Failure isolation ───────────────────────────────────────────────────────

// 7a. Throwing connector → reason, no throw
{
  const throwingConnector = {
    descriptor: { id: "throw", kind: "ollama" as const },
    send: async () => { throw new Error("model exploded"); },
    stream: async function* () { yield ""; },
    listModels: async () => [],
    test: async () => ({ ok: true as const }),
  } as unknown as Connector;

  let threw = false;
  let throwResult: Awaited<ReturnType<typeof synthesizeNarrative>> | null = null;
  try {
    throwResult = await synthesizeNarrative({ connector: throwingConnector, input: stubInput });
  } catch {
    threw = true;
  }
  check("throwing connector does not throw to caller", !threw);
  check("throwing connector → reason set", throwResult?.reason !== undefined, JSON.stringify(throwResult));
  check("throwing connector → narrative null", throwResult?.narrative === null);
}

// 7b. Connector returning garbage → reason "unparseable"; nothing new persisted
{
  const narrativeBeforeGarbage = getNarrative();
  const garbageConnector = {
    descriptor: { id: "garbage", kind: "ollama" as const },
    send: async () => "not json at all — the model said something weird",
    stream: async function* () { yield ""; },
    listModels: async () => [],
    test: async () => ({ ok: true as const }),
  } as unknown as Connector;

  const garbageResult = await synthesizeNarrative({ connector: garbageConnector, input: stubInput });
  check("garbage response → reason 'unparseable'", garbageResult.reason === "unparseable");
  check("garbage response → narrative null", garbageResult.narrative === null);

  // KV should still be the pre-garbage value (validate-before-persist)
  const narrativeAfterGarbage = getNarrative();
  if (narrativeBeforeGarbage && narrativeAfterGarbage) {
    check(
      "garbage response does not overwrite persisted narrative",
      narrativeAfterGarbage.identity === narrativeBeforeGarbage.identity,
    );
  }
}

// 7c. Broken brain_metadata table → getNarrative returns null, synthesizeNarrative
//     does not throw.
{
  db.exec("DROP TABLE IF EXISTS brain_metadata");

  let getThrew = false;
  let getNarrativeResult: SelfNarrative | null = undefined as unknown as SelfNarrative | null;
  try {
    getNarrativeResult = getNarrative();
  } catch {
    getThrew = true;
  }
  check("getNarrative with dropped table does not throw", !getThrew);
  check("getNarrative with dropped table returns null", getNarrativeResult === null);

  const stubConnector2 = {
    descriptor: { id: "stub2", kind: "ollama" as const },
    send: async () => VALID_NARRATIVE_JSON,
    stream: async function* () { yield ""; },
    listModels: async () => [],
    test: async () => ({ ok: true as const }),
  } as unknown as Connector;

  let synthThrew = false;
  let synthResult: Awaited<ReturnType<typeof synthesizeNarrative>> | null = null;
  try {
    synthResult = await synthesizeNarrative({ connector: stubConnector2, input: stubInput });
  } catch {
    synthThrew = true;
  }
  check("synthesizeNarrative with dropped table does not throw", !synthThrew);
  // It may return null (save failed) or non-null (parse OK but save silently failed)
  // — either is acceptable; what matters is no throw.
  check(
    "synthesizeNarrative with dropped table returns some result object",
    synthResult !== null,
    JSON.stringify(synthResult),
  );
}

// ── Summary ───────────────────────────────────────────────────────────────────
const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
