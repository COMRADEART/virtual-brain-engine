// Autonomous goal-pursuit (A1) selfcheck — hermetic (throwaway DB via
// BRAIN_DB_PATH, scripted stub connector via __setAgentConnector, NO LLM,
// NO network). Mirrors agent-selfcheck.ts.
//
// Run: npm --prefix server run pursuit:selfcheck
//
// Asserts:
//   (A) PURE truth table for autoPursuitDecision: each gate (flag, in-flight,
//       quiet, rate, stage, energy) individually blocks; all-clear goes.
//   (B) Stage gate over the temp DB: a persisted stage-1 brain skips with a
//       stage reason (the gate is REAL when the tracker is healthy).
//   (C) Empty goal tree at stage 5: probe returns "no actionable goal" and
//       does NOT burn the rate budget.
//   (D) Fires when every gate passes: seeded goal + stage 5 + scripted
//       final-answer connector → pursued:true status done; the run took NO
//       confirm-tier action (safe-only invariant holds — action_log clean).
//   (E) A successful pursuit burns the rate budget: the very next tick is
//       rate-limited.
//   (F) Never throws: with goal_history dropped the tick still resolves with
//       a reason.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

// Throwaway DB BEFORE importing anything that opens it.
const tmp = mkdtempSync(join(tmpdir(), "brain-pursuit-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");
process.env.LOCAL_ONLY = "true";
process.env.PERCEPTION_WORKER_URL = "http://127.0.0.1:1";

const { openDb } = await import("../src/db/sqlite.js");
const { CONFIG } = await import("../src/config.js");
const {
  autoPursuitDecision,
  autoPursuitTick,
  __resetAutoPursuitForTests,
  PURSUIT_QUIET_MS,
} = await import("../src/reasoning/goalPursuit.js");
const { __setAgentConnector } = await import("../src/reasoning/agentLoop.js");
const { getPersistentOrganism } = await import("../src/core/organism.js");
const { listActionLog } = await import("../src/db/repositories/actions.js");
type Connector = import("../src/connectors/Connector.js").Connector;

const db = openDb();

function setStage(stage: number): void {
  db.prepare(
    "INSERT INTO brain_metadata (key, value) VALUES ('developmental-stage-v1', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(JSON.stringify({ stage, reachedAt: "2026-06-17T00:00:00.000Z", history: [] }));
}

// -----------------------------------------------------------------------------
// (A) PURE decision truth table.
// -----------------------------------------------------------------------------

const allClear = {
  enabled: true,
  quietMs: PURSUIT_QUIET_MS + 1,
  sinceLastPursuitMs: 61 * 60_000,
  intervalMs: 60 * 60_000,
  stageOk: true,
  energyOk: true,
  inFlight: false,
};
check("(A) all gates clear → go", autoPursuitDecision(allClear).go === true);
check("(A) disabled flag blocks", autoPursuitDecision({ ...allClear, enabled: false }).go === false);
check("(A) in-flight blocks", autoPursuitDecision({ ...allClear, inFlight: true }).go === false);
check(
  "(A) not-quiet blocks",
  autoPursuitDecision({ ...allClear, quietMs: PURSUIT_QUIET_MS - 1 }).go === false,
);
check(
  "(A) rate limit blocks",
  autoPursuitDecision({ ...allClear, sinceLastPursuitMs: 59 * 60_000 }).go === false,
);
check("(A) stage gate blocks", autoPursuitDecision({ ...allClear, stageOk: false }).go === false);
check("(A) energy gate blocks", autoPursuitDecision({ ...allClear, energyOk: false }).go === false);
check(
  "(A) every no-go carries a reason",
  ([
    { ...allClear, enabled: false },
    { ...allClear, inFlight: true },
    { ...allClear, quietMs: 0 },
    { ...allClear, sinceLastPursuitMs: 0 },
    { ...allClear, stageOk: false },
    { ...allClear, energyOk: false },
  ] as const).every((g) => autoPursuitDecision(g).reason.length > 0),
);

// -----------------------------------------------------------------------------
// (B) Stage gate over the temp DB. The pursuit stage gate is fail-CLOSED
// (unlike stageAllows): a truly fresh brain persists NO stage row until its
// first advance, and an autonomous LLM-spending feature must read that as NO —
// otherwise pursuit fires ~90s after every fresh boot (the organism seeds
// goals). Then: a persisted YOUNG brain is genuinely gated too.
// -----------------------------------------------------------------------------

CONFIG.goalPursuitAuto = true;
__resetAutoPursuitForTests();
{
  const report = await autoPursuitTick();
  check(
    "(B) fresh brain with NO persisted stage row skips (fail-closed)",
    report.pursued === false && /stage/i.test(report.reason ?? ""),
    report.reason ?? "",
  );
}
setStage(1);
__resetAutoPursuitForTests();
{
  const report = await autoPursuitTick();
  check("(B) stage-1 brain skips with a stage reason", report.pursued === false && /stage/i.test(report.reason ?? ""), report.reason ?? "");
}

// -----------------------------------------------------------------------------
// (C) Empty goal tree at stage 5 — probe skips and does NOT burn the budget.
// -----------------------------------------------------------------------------

setStage(5);
__resetAutoPursuitForTests();
{
  const report = await autoPursuitTick();
  check("(C) empty tree → no actionable goal", report.pursued === false && /goal/i.test(report.reason ?? ""), report.reason ?? "");
}

// -----------------------------------------------------------------------------
// (D) Fires when every gate passes — safe-only, and the probe above didn't
// burn the rate budget (no reset between (C) and (D)).
// -----------------------------------------------------------------------------

const stub: Connector = {
  descriptor: {
    id: "stub",
    name: "stub",
    kind: "ollama",
    enabled: true,
    state: "ok",
    createdAt: "",
    updatedAt: "",
    isLocal: true,
  },
  async listModels() {
    return [];
  },
  async send() {
    return '{"thought":"I looked at the goal and it is satisfied for now.","tool":null,"final":"Reviewed the goal; nothing actionable beyond notes."}';
  },
  async *stream() {
    yield "";
  },
  async test() {
    return { ok: true };
  },
} satisfies Connector;
__setAgentConnector(stub);

getPersistentOrganism().createGoal({ title: "Keep the memory corpus healthy and well distilled", priority: 80 });
{
  const report = await autoPursuitTick();
  check("(D) pursuit fires when gates pass", report.pursued === true, JSON.stringify(report));
  check("(D) the scripted run completed (model declared done)", report.status === "done", report.status ?? "");
  const confirmTier = listActionLog(50).filter(
    (r) => r.authorizedVia === "confirm-token" || r.authorizedVia === "session-scope",
  );
  check("(D) safe-only invariant: no confirm-tier action ran", confirmTier.length === 0, `rows=${confirmTier.length}`);
}

// -----------------------------------------------------------------------------
// (E) A successful pursuit burns the rate budget.
// -----------------------------------------------------------------------------

{
  const report = await autoPursuitTick();
  check("(E) next tick is rate-limited", report.pursued === false && /rate/i.test(report.reason ?? ""), report.reason ?? "");
}

// -----------------------------------------------------------------------------
// (F) Never throws — broken goal store still resolves with a reason.
// -----------------------------------------------------------------------------

__resetAutoPursuitForTests();
db.exec("DROP TABLE IF EXISTS goal_history");
{
  let threw = false;
  let report: Awaited<ReturnType<typeof autoPursuitTick>> | null = null;
  try {
    report = await autoPursuitTick();
  } catch {
    threw = true;
  }
  check("(F) tick never throws with a broken goal store", threw === false && report !== null && Boolean(report.reason ?? report.status), JSON.stringify(report));
}

__setAgentConnector(null);

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
