// imaginative-planning selfcheck — gate for the H3 "imagination → decision"
// slice (advisory foresight in the agent loop).
//
// Hermetic (temp DB via BRAIN_DB_PATH, scripted connector, NO network/LLM):
//   (A) assessForesight (pure): warn only when failure rate ≥ threshold AND
//       confidence ≥ floor; null/NaN never warn; boundary inclusive.
//   (B) cold-ledger floor — foresee() on an action with no failure history is
//       null (no advisory; the loop behaves exactly as today).
//   (C) the embodiment path feeds foresight: recordActionOutcome failures →
//       foresee warns; a mostly-successful action never warns.
//   (D) foresightActive gating: static flag OFF + maturation OFF → inactive;
//       static ON → active; maturation path earns it at stage 6, not before.
//   (E) loop integration (REAL runAgentLoop + scripted connector): with the
//       flag ON a warn-worthy tool is deferred ONE round with a FORESIGHT note,
//       an insisting repeat call EXECUTES (advisory, never a veto), and the
//       deferred round never reached the executor (audit count proves it).
//   (F) flag-OFF parity: the same script executes on the FIRST call with no
//       foresight frames.
//
// Run: npm --prefix server run imaginativeplanning:selfcheck

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "brain-foresightcheck-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");
process.env.LOCAL_ONLY = "true";
process.env.PERCEPTION_WORKER_URL = "http://127.0.0.1:1";

const { openDb } = await import("../src/db/sqlite.js");
const { CONFIG } = await import("../src/config.js");
const ip = await import("../src/reasoning/imaginativePlanning.js");
const { recordActionOutcome } = await import("../src/actions/consequences.js");
const { startAgentRun, runAgentLoop, __setAgentConnector } = await import("../src/reasoning/agentLoop.js");
const { listActionLog } = await import("../src/db/repositories/actions.js");
type Connector = import("../src/connectors/Connector.js").Connector;
type AgentEvent = import("../../shared/agent.js").AgentEvent;
type PipelineEvent = import("../../shared/pipeline.js").PipelineEvent;
type Frame = AgentEvent | PipelineEvent;

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

const db = openDb();
function setStage(stage: number): void {
  db.prepare(
    "INSERT INTO brain_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run("developmental-stage-v1", JSON.stringify({ stage, reachedAt: "2026-06-17T00:00:00.000Z", history: [] }));
}

function scripted(responses: string[]): Connector {
  let i = 0;
  return {
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
      const r = responses[Math.min(i, responses.length - 1)] ?? "{}";
      i++;
      return r;
    },
    async *stream() {
      yield "";
    },
    async test() {
      return { ok: true };
    },
  } satisfies Connector;
}

function collector(): { emit: (f: Frame) => void; frames: Frame[] } {
  const frames: Frame[] = [];
  return { emit: (f) => frames.push(f), frames };
}
function agentEvents(frames: Frame[]): AgentEvent[] {
  return frames.filter((f): f is AgentEvent => "type" in f);
}
function toolResults(frames: Frame[], actionId: string): AgentEvent[] {
  return agentEvents(frames).filter((f) => f.type === "tool-result" && f.tool?.actionId === actionId);
}
function foresightThoughts(frames: Frame[]): AgentEvent[] {
  return agentEvents(frames).filter((f) => f.type === "thought" && (f.text ?? "").includes("FORESIGHT"));
}
function metricsStatus(frames: Frame[]): string | undefined {
  return agentEvents(frames).find((f) => f.type === "metrics")?.metrics?.status;
}

// Keep energy + maturation out of the way unless a section opts in.
CONFIG.energyBudget = false;
CONFIG.maturation = false;
CONFIG.imaginativePlanning = false;

// =============================================================================
// (A) assessForesight — pure
// =============================================================================
check("warns on high failure + trusted estimate", ip.assessForesight(0.9, 0.6) === true);
check(
  "boundary inclusive (exactly threshold + floor warns)",
  ip.assessForesight(ip.FORESIGHT_FAILURE_THRESHOLD, ip.FORESIGHT_MIN_CONFIDENCE) === true,
);
check("cold floor: high failure but low confidence never warns", ip.assessForesight(0.9, 0.45) === false);
check("healthy action: high confidence but low failure never warns", ip.assessForesight(0.5, 0.99) === false);
check("null failure rate never warns", ip.assessForesight(null, 1) === false);
check("NaN inputs never warn", ip.assessForesight(Number.NaN, 1) === false && ip.assessForesight(0.9, Number.NaN) === false);
check(
  "foresightFromForecast: no failure link → null (cold ledger)",
  ip.foresightFromForecast("x", { causeClass: "action:x", effects: [], expectedFailureRate: null, failureConfidence: 0 }) ===
    null,
);
const note = ip.foresightNote({
  actionId: "write-file",
  causeClass: "action:write-file",
  expectedFailureRate: 0.8,
  failureConfidence: 0.63,
  warn: true,
});
check("foresightNote names the action, the rate, and the way to insist", /write-file/.test(note) && /80%/.test(note) && /again/.test(note));

// =============================================================================
// (B) cold-ledger floor — never-run action foresees nothing
// =============================================================================
check("foresee() on an action with no history is null", ip.foresee("never-run-action") === null);

// =============================================================================
// (C) the embodiment path feeds foresight
// =============================================================================
for (let i = 0; i < 5; i++) {
  recordActionOutcome({ actionId: "system-info", ok: false, before: null, after: null });
  recordActionOutcome({ actionId: "search-memory", ok: true, before: null, after: null });
}
const bad = ip.foresee("system-info");
check(
  "5 observed failures → foresee warns (rate ≈ 0.86, confidence ≈ 0.63)",
  bad !== null && bad.warn === true && bad.expectedFailureRate > 0.8 && bad.failureConfidence > 0.6,
  JSON.stringify(bad),
);
const good = ip.foresee("search-memory");
check("5 observed successes → foresee sees it but never warns", good !== null && good.warn === false, JSON.stringify(good));

// =============================================================================
// (D) foresightActive — static flag + maturation gating
// =============================================================================
check("flag OFF + maturation OFF → inactive", ip.foresightActive() === false);
CONFIG.imaginativePlanning = true;
check("static flag ON → active (env override wins)", ip.foresightActive() === true);
CONFIG.imaginativePlanning = false;
CONFIG.maturation = true;
setStage(5);
check("maturation path: still LOCKED at stage 5", ip.foresightActive() === false);
setStage(6);
check("maturation path: EARNED at stage 6 (self-model maturity)", ip.foresightActive() === true);
setStage(1);
CONFIG.maturation = false;

// =============================================================================
// (E) loop integration — defer once, insist executes, executor untouched
// =============================================================================
{
  CONFIG.imaginativePlanning = true;
  __setAgentConnector(
    scripted([
      '{"thought":"check the system","tool":{"action":"system-info","args":{}},"final":""}',
      '{"thought":"I understand the risk, proceeding","tool":{"action":"system-info","args":{}},"final":""}',
      '{"thought":"done","tool":null,"final":"System checked."}',
    ]),
  );
  const c = collector();
  const run = startAgentRun({ prompt: "check my system status", mode: "ask", scope: [] });
  await runAgentLoop(run, c.emit);
  check("foresight note surfaced as a thought frame", foresightThoughts(c.frames).length === 1);
  const tr = toolResults(c.frames, "system-info");
  check("deferred ONE round, insisting repeat EXECUTED (1 tool-result, ok)", tr.length === 1 && tr[0].tool?.ok === true);
  const audited = listActionLog(200).filter((e) => e.actionId === "system-info");
  check("deferred round never reached the executor (exactly 1 audit row)", audited.length === 1, `n=${audited.length}`);
  const pipeFrames = c.frames.filter((f): f is PipelineEvent => !("type" in f));
  check(
    "deferral flashes error-detection (pipeline frame carries the foresight detail)",
    pipeFrames.some((f) => f.step === "error" && (f.detail ?? "").includes("foresight")),
  );
  check("run still finishes (status done)", metricsStatus(c.frames) === "done");
  CONFIG.imaginativePlanning = false;
}

// =============================================================================
// (F) flag-OFF parity — same history, no foresight, first call executes
// =============================================================================
{
  __setAgentConnector(
    scripted([
      '{"thought":"check the system","tool":{"action":"system-info","args":{}},"final":""}',
      '{"thought":"done","tool":null,"final":"System checked."}',
    ]),
  );
  const c = collector();
  const run = startAgentRun({ prompt: "check my system status", mode: "ask", scope: [] });
  await runAgentLoop(run, c.emit);
  check("flag OFF: no foresight frames despite the failure history", foresightThoughts(c.frames).length === 0);
  const tr = toolResults(c.frames, "system-info");
  check("flag OFF: first call executes immediately (parity with today)", tr.length === 1 && tr[0].tool?.ok === true);
  const audited = listActionLog(200).filter((e) => e.actionId === "system-info");
  check("flag OFF: executor reached exactly once more (2 audit rows total)", audited.length === 2, `n=${audited.length}`);
  __setAgentConnector(null);
}

// =============================================================================
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
