// Agentic loop ("main thinking") selfcheck. HERMETIC: a SCRIPTED stub connector
// stands in for the LLM (no network, no Ollama), and the DB is a throwaway temp
// file via BRAIN_DB_PATH (set BEFORE importing config-dependent modules). The
// loop never touches the network: the only confirm-tier action executed is
// `create-note` (a pure DB insert), so scope/ask-approve paths are proven
// without side effects on the real machine.
//
// Run: npm --prefix server run agent:selfcheck
//
// Asserts:
//   Triage    — plain question → pipeline; URL / path / action verb → loop.
//   Loop core — a safe tool runs through the executor, then the model finishes
//               (model-decides-done); the final answer is emitted.
//   Modes     — TRUST BOUNDARY across all 3 confirm modes:
//                 ask       → confirm-tier PAUSES (nothing executed); resume
//                             DENY runs nothing; resume APPROVE executes with an
//                             HONEST confirm token (confirmed=1, via confirm-token).
//                 scope     → confirm-tier within the granted ceiling runs via
//                             the session-scope channel (confirmed=0,
//                             authorized_via='session-scope' — NOT a forged token).
//                 safe-only → confirm-tier is REFUSED (nothing executed).
//   Stall     — a model that repeats one tool forever is broken out of and the
//               run TERMINATES (never spins to the round cap).
//   Audit     — action_log records the honest authorized_via for each path.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Redirect the DB to a throwaway dir BEFORE importing config-dependent modules.
const tmp = mkdtempSync(join(tmpdir(), "brain-agentcheck-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");
process.env.LOCAL_ONLY = "true"; // egress stays gated regardless of what the loop picks
process.env.PERCEPTION_WORKER_URL = "http://127.0.0.1:1"; // unreachable → vision worker-down path

const { openDb } = await import("../src/db/sqlite.js");
const { CONFIG } = await import("../src/config.js");
const { triage } = await import("../src/reasoning/triage.js");
const {
  startAgentRun,
  runAgentLoop,
  resumeAgentRun,
  getAgentRun,
  __setAgentConnector,
  captionReferenceImages,
  describeResultImages,
  extractResultImages,
} = await import("../src/reasoning/agentLoop.js");
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

openDb(); // schema.sql (action_log + authorized_via) + migrations

// A connector whose send() returns the next scripted JSON response (and repeats
// the last one once the script is exhausted — so a force-answer round still gets
// a response). Only send() is exercised.
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

// Like scripted(), but send() THROWS for the first `throwsFirst` calls before
// returning the scripted responses — exercises robustSend's retry/backoff.
function scriptedFlaky(responses: string[], throwsFirst: number): Connector {
  let calls = 0;
  let i = 0;
  return {
    descriptor: {
      id: "stub-flaky",
      name: "stub-flaky",
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
      calls++;
      if (calls <= throwsFirst) throw new Error("transient connector failure");
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
function finalText(frames: Frame[]): string | undefined {
  return agentEvents(frames).find((f) => f.type === "final")?.text;
}
function metricsStatus(frames: Frame[]): string | undefined {
  return agentEvents(frames).find((f) => f.type === "metrics")?.metrics?.status;
}

// ── Triage (pure) ───────────────────────────────────────────────────────────
check("triage: plain question → pipeline", triage("What is the capital of France?") === "pipeline");
check("triage: 'who am I?' → pipeline", triage("who am I?") === "pipeline");
check("triage: URL → loop", triage("clone https://github.com/x/y") === "loop");
check("triage: file path → loop", triage("read the file C:\\tmp\\notes.txt") === "loop");
check("triage: action verb → loop", triage("open the downloads folder") === "loop");
check("triage: 'research X' → loop", triage("research quantum computing for me") === "loop");

// ── Loop core: safe tool → model finishes ────────────────────────────────────
{
  __setAgentConnector(
    scripted([
      '{"thought":"search memory","tool":{"action":"search-memory","args":{"query":"cats"}},"final":""}',
      '{"thought":"answer","tool":null,"final":"You have no memories about cats."}',
    ]),
  );
  const c = collector();
  const run = startAgentRun({ prompt: "what do I know about cats", mode: "ask", scope: [] });
  await runAgentLoop(run, c.emit);
  const tr = toolResults(c.frames, "search-memory");
  check("loop: safe tool ran through executor", tr.length === 1 && tr[0].tool?.ok === true);
  check("loop: safe tool audited via='safe'", tr[0]?.tool?.authorizedVia === "safe");
  check("loop: model-decides-done emits a final answer", (finalText(c.frames) ?? "").includes("cats"));
  check("loop: run completed (status done)", metricsStatus(c.frames) === "done");
  check("loop: run was not left parked", getAgentRun(run.runId) === undefined);
}

// ── safe-only: confirm-tier refused ──────────────────────────────────────────
{
  __setAgentConnector(
    scripted([
      '{"thought":"save a note","tool":{"action":"create-note","args":{"content":"safe-only test note"}},"final":""}',
      '{"thought":"done","tool":null,"final":"I could not save that without permission."}',
    ]),
  );
  const c = collector();
  const run = startAgentRun({ prompt: "note: safe-only test note", mode: "safe-only", scope: [] });
  await runAgentLoop(run, c.emit);
  const tr = toolResults(c.frames, "create-note");
  check("safe-only: confirm-tier refused (not ok)", tr.length === 1 && tr[0].tool?.ok === false);
  check("safe-only: loop still finishes", metricsStatus(c.frames) !== undefined && finalText(c.frames) !== undefined);
  const ran = listActionLog(100).some((e) => e.actionId === "create-note" && e.summary.includes("safe-only test note") && e.ok);
  check("safe-only: nothing was actually executed", ran === false);
}

// ── scope: confirm-tier runs via the honest session-scope channel ────────────
{
  __setAgentConnector(
    scripted([
      '{"thought":"save a note","tool":{"action":"create-note","args":{"content":"scope milk note"}},"final":""}',
      '{"thought":"done","tool":null,"final":"Saved the note."}',
    ]),
  );
  const c = collector();
  const run = startAgentRun({ prompt: "note: scope milk note", mode: "scope", scope: ["safe", "confirm"] });
  await runAgentLoop(run, c.emit);
  const tr = toolResults(c.frames, "create-note");
  check("scope: confirm-tier executed within ceiling", tr.length === 1 && tr[0].tool?.ok === true);
  check("scope: tool reports via='session-scope'", tr[0]?.tool?.authorizedVia === "session-scope");
  const row = listActionLog(100).find((e) => e.actionId === "create-note" && e.ok && e.summary.includes("scope milk note"));
  check("scope: audited authorized_via='session-scope'", row?.authorizedVia === "session-scope");
  check("scope: audited confirmed=false (no forged token)", row?.confirmed === false);
}

// ── scope: a confirm-tier action OUTSIDE the ceiling is refused ──────────────
{
  __setAgentConnector(
    scripted([
      '{"thought":"save a note","tool":{"action":"create-note","args":{"content":"outside scope note"}},"final":""}',
      '{"thought":"done","tool":null,"final":"skipped."}',
    ]),
  );
  const c = collector();
  // scope grants only "safe" — a confirm-tier action is NOT covered.
  const run = startAgentRun({ prompt: "note: outside scope note", mode: "scope", scope: ["safe"] });
  await runAgentLoop(run, c.emit);
  const tr = toolResults(c.frames, "create-note");
  check("scope: action outside ceiling refused", tr.length === 1 && tr[0].tool?.ok === false);
  const ran = listActionLog(200).some((e) => e.actionId === "create-note" && e.ok && e.summary.includes("outside scope note"));
  check("scope: out-of-ceiling action not executed", ran === false);
}

// ── ask: confirm-tier PAUSES; deny runs nothing ──────────────────────────────
{
  __setAgentConnector(
    scripted([
      '{"thought":"save a note","tool":{"action":"create-note","args":{"content":"ask-deny note"}},"final":""}',
      '{"thought":"done","tool":null,"final":"ok, skipped."}',
    ]),
  );
  const c = collector();
  const run = startAgentRun({ prompt: "note: ask-deny note", mode: "ask", scope: [] });
  await runAgentLoop(run, c.emit);
  const cr = agentEvents(c.frames).find((f) => f.type === "confirm-request");
  check("ask: confirm-tier emits a confirm-request", cr?.confirm?.actionId === "create-note");
  check("ask: run is parked awaiting confirmation", getAgentRun(run.runId)?.pending?.action === "create-note");
  check("ask: paused status emitted", metricsStatus(c.frames) === "paused");
  const ranBefore = listActionLog(200).some((e) => e.actionId === "create-note" && e.ok && e.summary.includes("ask-deny note"));
  check("ask: nothing executed while paused", ranBefore === false);
  // Deny → loop resumes and finishes without running the action.
  const c2 = collector();
  const resumed = await resumeAgentRun({ runId: run.runId, approve: false }, c2.emit);
  check("ask: deny resumes the run", resumed === true);
  check("ask: deny produces a final answer", finalText(c2.frames) !== undefined);
  const ranAfter = listActionLog(200).some((e) => e.actionId === "create-note" && e.ok && e.summary.includes("ask-deny note"));
  check("ask: denied action never executed", ranAfter === false);
}

// ── ask: approve executes with an HONEST confirm token ───────────────────────
{
  __setAgentConnector(
    scripted([
      '{"thought":"save a note","tool":{"action":"create-note","args":{"content":"ask-approve note"}},"final":""}',
      '{"thought":"done","tool":null,"final":"Saved."}',
    ]),
  );
  const c = collector();
  const run = startAgentRun({ prompt: "note: ask-approve note", mode: "ask", scope: [] });
  await runAgentLoop(run, c.emit);
  check("ask: parked before approval", getAgentRun(run.runId)?.pending?.action === "create-note");
  const c2 = collector();
  await resumeAgentRun({ runId: run.runId, approve: true }, c2.emit);
  const tr = toolResults(c2.frames, "create-note");
  check("ask: approve executes the action", tr.length === 1 && tr[0].tool?.ok === true);
  check("ask: approve reports via='confirm-token'", tr[0]?.tool?.authorizedVia === "confirm-token");
  const row = listActionLog(200).find((e) => e.actionId === "create-note" && e.ok && e.summary.includes("ask-approve note"));
  check("ask: audited confirmed=true via confirm-token", row?.confirmed === true && row?.authorizedVia === "confirm-token");
  check("ask: run cleared after completion", getAgentRun(run.runId) === undefined);
}

// ── Stall breaker: a model that loops forever is broken out of ───────────────
{
  // Always proposes the SAME tool, never finishes — the loop must converge.
  __setAgentConnector(
    scripted(['{"thought":"searching again","tool":{"action":"search-memory","args":{"query":"loop"}},"final":""}']),
  );
  const c = collector();
  const run = startAgentRun({ prompt: "spin forever", mode: "ask", scope: [] });
  await runAgentLoop(run, c.emit);
  const calls = toolResults(c.frames, "search-memory").length;
  check("stall: run terminates (metrics emitted)", metricsStatus(c.frames) !== undefined);
  check("stall: broken out well before the round cap", calls > 0 && calls <= 5, `executed ${calls}×`);
  check("stall: a final answer is still produced", finalText(c.frames) !== undefined);
  check("stall: run cleared", getAgentRun(run.runId) === undefined);
}

// ── Unknown tool is handled gracefully (no throw, no execution) ──────────────
{
  __setAgentConnector(
    scripted([
      '{"thought":"try a made-up tool","tool":{"action":"definitely-not-a-tool","args":{}},"final":""}',
      '{"thought":"done","tool":null,"final":"Could not do that."}',
    ]),
  );
  const c = collector();
  const run = startAgentRun({ prompt: "use a fake tool", mode: "scope", scope: ["safe", "confirm"] });
  await runAgentLoop(run, c.emit);
  const tr = toolResults(c.frames, "definitely-not-a-tool");
  check("unknown tool: reported as not-ok, loop continues", tr.length === 1 && tr[0].tool?.ok === false);
  check("unknown tool: loop still finishes", finalText(c.frames) !== undefined);
}

// ── "Do any task" run-command is confirm-tier and gated (never spawned) ──────
{
  // The universal shell tool must be CONFIRM-tier: in safe-only mode the loop
  // refuses it and returns BEFORE executeAction, so no child process is ever
  // spawned. This proves the broadest capability in the brain is gated like any
  // other confirm-tier action — hermetically, with zero real side effects.
  __setAgentConnector(
    scripted([
      '{"thought":"run a command","tool":{"action":"run-command","args":{"command":"echo hi"}},"final":""}',
      '{"thought":"done","tool":null,"final":"I could not run that without permission."}',
    ]),
  );
  const c = collector();
  const run = startAgentRun({ prompt: "run echo hi", mode: "safe-only", scope: [] });
  await runAgentLoop(run, c.emit);
  const tr = toolResults(c.frames, "run-command");
  check("run-command: confirm-tier refused in safe-only (never spawned)", tr.length === 1 && tr[0].tool?.ok === false);
  check("run-command: loop still finishes after refusal", finalText(c.frames) !== undefined);
}

// ── Resilience: a transient send() failure is RETRIED, not fatal ─────────────
{
  // First send() throws; robustSend retries and the second succeeds with a
  // direct final answer. The run must COMPLETE, not be deleted on the first throw.
  __setAgentConnector(
    scriptedFlaky(['{"thought":"answer","tool":null,"final":"Recovered after a transient failure."}'], 1),
  );
  const c = collector();
  const run = startAgentRun({ prompt: "answer me", mode: "ask", scope: [] });
  await runAgentLoop(run, c.emit);
  check("retry: a transient connector failure is retried, not fatal", metricsStatus(c.frames) === "done");
  check("retry: the recovered answer is produced", (finalText(c.frames) ?? "").includes("Recovered"));
  check("retry: run cleared after completion", getAgentRun(run.runId) === undefined);
}

// ── Creative capstone (E1/E2/E3): image input, visual feedback, round budget ──
// Hermetic: the perception worker is unreachable (set above), so every vision
// call takes its worker-down path — proving the feature degrades honestly, never
// throws, and never silently drops an image.
{
  const env = {
    content: [
      { type: "text", text: "rendered the scene" },
      { type: "image", data: "QUJD", mimeType: "image/png" },
    ],
  };
  const imgs = extractResultImages(env);
  check("creative: extractResultImages pulls the image block", imgs.length === 1 && imgs[0].base64 === "QUJD");
  check(
    "creative: extractResultImages ignores text-only / null results",
    extractResultImages({ content: [{ type: "text", text: "x" }] }).length === 0 && extractResultImages(null).length === 0,
  );

  CONFIG.creativeAgent = false;
  check("creative: visual feedback is a no-op when CREATIVE_AGENT off", (await describeResultImages(env)) === "");

  CONFIG.creativeAgent = true;
  const note = await describeResultImages(env);
  check("creative: visual feedback notes a captured image (worker down)", /captured an image/.test(note), note);
  check("creative: the intermediate artifact was pinned to disk", /artifacts[\\/]/.test(note), note);

  const refCtx = await captionReferenceImages([{ base64: "QUJD" }]);
  check(
    "creative: a reference image becomes captioned task context (worker-down note)",
    /Reference image 1:/.test(refCtx) && /unavailable|could not/.test(refCtx),
    refCtx,
  );

  const r1 = startAgentRun({ prompt: "model a character", mode: "safe-only", scope: [], maxRounds: 25 });
  check("creative: a per-run maxRounds override is respected", r1.maxRounds === 25);
  const r2 = startAgentRun({ prompt: "model a character", mode: "safe-only", scope: [] });
  check("creative: the creative default round ceiling is applied", r2.maxRounds === CONFIG.agentCreativeMaxRounds);
  CONFIG.creativeAgent = false;
}

// ── H3 advisory foresight: the causal map informs the loop before it acts ────
{
  const { foresightLine } = await import("../src/actions/consequences.js");
  const { recordObservation } = await import("../src/core/causalMap.js");

  // Pure formatter.
  check("foresight: empty effects → empty line", foresightLine("run-command", []) === "");
  const link = (effectClass: string, strength: number, confidence: number, observations = 5) => ({
    causeClass: "action:x",
    effectClass,
    observations,
    occurrences: Math.round(strength * observations),
    strength,
    confidence,
    lastObservedAt: "",
    source: "t",
  });
  check(
    "foresight: sub-confidence links filtered out",
    foresightLine("x", [link("success", 0.9, 0.1)]) === "",
  );
  const multi = foresightLine("x", [
    link("success", 0.82, 0.9, 17),
    link("state-changed", 0.64, 0.8),
    link("failure", 0.2, 0.7),
  ]);
  check("foresight: caps at top-2 effects", (multi.match(/%/g) ?? []).length === 2, multi);
  check("foresight: single bounded line", !multi.includes("\n") && multi.length <= 180 && multi.startsWith("Foresight: x"));

  // A prompt-capturing scripted connector — proves what the MODEL actually saw.
  function scriptedCapture(responses: string[], prompts: string[]): Connector {
    let i = 0;
    return {
      descriptor: {
        id: "stub-capture",
        name: "stub-capture",
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
      async send(prompt: string) {
        prompts.push(prompt);
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
  const script = [
    '{"thought":"check the system","tool":{"action":"system-info","args":{}},"final":""}',
    '{"thought":"done","tool":null,"final":"System looks healthy."}',
  ];

  // Seed empirical history for system-info (confidence 1−e^(−3/5) ≈ 0.45 > 0.2).
  for (let n = 0; n < 3; n++) {
    recordObservation({ causeClass: "action:system-info", effectClass: "success", occurred: true, source: "selfcheck" });
  }

  // Feature OFF (static flag off + fresh young brain) → prompts are untouched.
  {
    const prompts: string[] = [];
    __setAgentConnector(scriptedCapture(script, prompts));
    const run = startAgentRun({ prompt: "how is the system doing", mode: "safe-only", scope: [] });
    await runAgentLoop(run, collector().emit);
    check("foresight: absent when the imagination feature is inactive", prompts.every((p) => !p.includes("Foresight:")));
  }

  // Feature ON → the round-2 prompt carries exactly one foresight line.
  CONFIG.enablePerRequestImagination = true;
  {
    const prompts: string[] = [];
    __setAgentConnector(scriptedCapture(script, prompts));
    const run = startAgentRun({ prompt: "how is the system doing", mode: "safe-only", scope: [] });
    await runAgentLoop(run, collector().emit);
    const withLine = prompts.filter((p) => p.includes("Foresight: system-info"));
    check("foresight: the model sees the advisory once history exists", withLine.length >= 1, `prompts=${prompts.length}`);
    check(
      "foresight: shown once per action per run",
      (prompts[prompts.length - 1]?.match(/Foresight: system-info/g) ?? []).length === 1,
    );
  }

  // Feature ON but NO causal history for the action → harmless no-op.
  {
    const prompts: string[] = [];
    __setAgentConnector(
      scriptedCapture(
        [
          '{"thought":"look","tool":{"action":"recent-memories","args":{}},"final":""}',
          '{"thought":"done","tool":null,"final":"Nothing recent."}',
        ],
        prompts,
      ),
    );
    const run = startAgentRun({ prompt: "anything new in memory", mode: "safe-only", scope: [] });
    await runAgentLoop(run, collector().emit);
    check("foresight: unseeded action stays untouched and the run completes", prompts.every((p) => !p.includes("Foresight:")));
  }
  CONFIG.enablePerRequestImagination = false;
}

__setAgentConnector(null);

console.log(JSON.stringify({ failures, result: failures === 0 ? "PASS" : "FAIL" }));
process.exit(failures === 0 ? 0 : 1);
