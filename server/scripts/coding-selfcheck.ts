// Coding-mastery selfcheck — hermetic (throwaway DB via BRAIN_DB_PATH, a scripted
// connector for the agent loop, trivial `exit N` shell commands as the build/test
// stand-ins, NO LLM, NO network, NO project files touched). Run:
//   npm --prefix server run coding:selfcheck
//
// Asserts:
//   (A) PURE applyEdits — single edit, uniqueness requirement, all:true, not-found
//       and identical-text hard errors.
//   (B) PURE verify gate — assertVerified passed/failed/unverified ordering vs the
//       last edit; sessionMutatedCode; the action-id classifiers; verifyResultPassed.
//   (C) END-TO-END honesty gate — drive the real agent loop (scripted) through
//       edit → run-tests(exit 1) → edit → run-tests(exit 0) → final and assert the
//       final frame is verified="passed" with NO caveat; a run that ends on a
//       failing test is verified="failed" WITH a "NOT VERIFIED" caveat; a run that
//       edits but never tests is verified="unverified".
//   (D) THE TRUST BOUNDARY — every coding action runs through executeAction (the
//       run-tests rows are AUDITED in action_log as session-scope), and run-tests
//       is confirm-tier so it is REFUSED in safe-only mode (no process spawned).
//   (E) apply-patch really edits a guarded temp file, and refuses a sensitive path.

import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

const tmp = mkdtempSync(join(tmpdir(), "brain-coding-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");
process.env.ALLOW_SHELL = "true"; // build/test actions must be in the registry

const {
  applyEdits,
  assertVerified,
  sessionMutatedCode,
  isMutatingActionId,
  isVerifyActionId,
  verifyResultPassed,
} = await import("../../shared/coding.js");
import type { CodingTrailEntry } from "../../shared/coding.js";
const { startAgentRun, runAgentLoop, __setAgentConnector } = await import("../src/reasoning/agentLoop.js");
const { isAgentEvent } = await import("../../shared/agent.js");
import type { AgentConfirmMode, AgentEvent, AgentStreamFrame } from "../../shared/agent.js";
import type { ActionRiskTier } from "../../shared/actions.js";
const { getActionDef } = await import("../src/actions/registry.js");
const { openDb } = await import("../src/db/sqlite.js");
type Connector = import("../src/connectors/Connector.js").Connector;

const db = openDb();

function scripted(responses: string[]): Connector {
  let i = 0;
  return {
    descriptor: {
      id: "stub", name: "stub", kind: "ollama", enabled: true, state: "ok",
      createdAt: "", updatedAt: "", isLocal: true,
    },
    async listModels() { return []; },
    async send() { const r = responses[Math.min(i, responses.length - 1)] ?? "{}"; i++; return r; },
    async *stream() { yield ""; },
    async test() { return { ok: true }; },
  } satisfies Connector;
}

// Drive a full agent run to completion, returning the captured frames.
async function runLoop(
  scripts: string[],
  mode: AgentConfirmMode,
  scope: ActionRiskTier[],
): Promise<AgentStreamFrame[]> {
  __setAgentConnector(scripted(scripts));
  const frames: AgentStreamFrame[] = [];
  const run = startAgentRun({ prompt: "fix the failing test", mode, scope });
  await runAgentLoop(run, (f) => frames.push(f));
  __setAgentConnector(null);
  return frames;
}

function finalFrame(frames: AgentStreamFrame[]): AgentEvent | undefined {
  return frames.find((f): f is AgentEvent => isAgentEvent(f) && f.type === "final");
}

function makeFile(name: string, content: string): string {
  const p = join(tmp, name);
  writeFileSync(p, content, "utf8");
  return p;
}

// JSON for one scripted round: a tool call, or a final answer.
const toolTurn = (action: string, args: Record<string, unknown>): string =>
  JSON.stringify({ thought: action, tool: { action, args }, final: "" });
const finalTurn = (text: string): string => JSON.stringify({ thought: "done", tool: null, final: text });

// -----------------------------------------------------------------------------
// (A) PURE applyEdits.
// -----------------------------------------------------------------------------
{
  const r1 = applyEdits('const x = "alpha";', [{ find: "alpha", replace: "beta" }]);
  check("(A) single edit applies", r1.ok && r1.content === 'const x = "beta";' && r1.applied === 1);
  const r2 = applyEdits("a a a", [{ find: "a", replace: "b" }]);
  check("(A) ambiguous find is refused without all:true", r2.ok === false && /matches 3/.test(r2.error ?? ""));
  const r3 = applyEdits("a a a", [{ find: "a", replace: "b", all: true }]);
  check("(A) all:true replaces every occurrence", r3.ok && r3.content === "b b b" && r3.applied === 3);
  const r4 = applyEdits("hello", [{ find: "world", replace: "x" }]);
  check("(A) find-not-present is a hard error", r4.ok === false && /not present/.test(r4.error ?? ""));
  const r5 = applyEdits("hello", [{ find: "hello", replace: "hello" }]);
  check("(A) identical find/replace is refused", r5.ok === false);
  const r6 = applyEdits("x", []);
  check("(A) empty edit list is refused", r6.ok === false);
}

// -----------------------------------------------------------------------------
// (B) PURE verify gate.
// -----------------------------------------------------------------------------
{
  const T = (action: string, ok: boolean, mutating: boolean, verify: boolean, verifyPassed: boolean): CodingTrailEntry =>
    ({ action, ok, mutating, verify, verifyPassed });
  const passed = [T("apply-patch", true, true, false, false), T("run-tests", true, false, true, true)];
  check("(B) verify after last edit, exit 0 → passed", assertVerified(passed) === "passed");
  const failed = [T("apply-patch", true, true, false, false), T("run-tests", true, false, true, false)];
  check("(B) verify after last edit, non-zero → failed", assertVerified(failed) === "failed");
  const stale = [T("run-tests", true, false, true, true), T("apply-patch", true, true, false, false)];
  check("(B) edit AFTER the passing test → unverified", assertVerified(stale) === "unverified");
  const noTest = [T("apply-patch", true, true, false, false)];
  check("(B) edit with no test → unverified", assertVerified(noTest) === "unverified");
  check("(B) sessionMutatedCode true when an edit succeeded", sessionMutatedCode(passed) === true);
  check("(B) sessionMutatedCode false with no successful edit",
    sessionMutatedCode([T("run-tests", true, false, true, true)]) === false);
  check("(B) classifiers", isMutatingActionId("apply-patch") && isMutatingActionId("write-file") &&
    isVerifyActionId("run-tests") && isVerifyActionId("run-build") && !isVerifyActionId("read-file"));
  check("(B) verifyResultPassed reads passed/exitCode",
    verifyResultPassed({ passed: true }) && verifyResultPassed({ exitCode: 0 }) &&
    !verifyResultPassed({ exitCode: 1 }) && !verifyResultPassed(null));
}

// -----------------------------------------------------------------------------
// (C) END-TO-END honesty gate (real loop + real executor + trivial shell).
// -----------------------------------------------------------------------------
{
  // PASS: edit → test fail → edit → test pass → final.
  const f1 = makeFile("pass.txt", "value = alpha");
  const passFrames = await runLoop(
    [
      toolTurn("apply-patch", { path: f1, edits: [{ find: "alpha", replace: "beta" }] }),
      toolTurn("run-tests", { cwd: tmp, command: "exit 1" }),
      toolTurn("apply-patch", { path: f1, edits: [{ find: "beta", replace: "gamma" }] }),
      toolTurn("run-tests", { cwd: tmp, command: "exit 0" }),
      finalTurn("Fixed it."),
    ],
    "scope",
    ["confirm"],
  );
  const pf = finalFrame(passFrames);
  check("(C) PASS run: final verified=passed", pf?.verified === "passed", JSON.stringify({ v: pf?.verified }));
  check("(C) PASS run: no caveat appended", !!pf && !/NOT VERIFIED/.test(pf.text ?? ""));
  check("(C) PASS run: the file was actually edited", readFileSync(f1, "utf8") === "value = gamma");

  // FAIL: edit → test fail → final.
  const f2 = makeFile("fail.txt", "value = alpha");
  const failFrames = await runLoop(
    [
      toolTurn("apply-patch", { path: f2, edits: [{ find: "alpha", replace: "beta" }] }),
      toolTurn("run-tests", { cwd: tmp, command: "exit 1" }),
      finalTurn("I changed it."),
    ],
    "scope",
    ["confirm"],
  );
  const ff = finalFrame(failFrames);
  check("(C) failing-test run: final verified=failed", ff?.verified === "failed", JSON.stringify({ v: ff?.verified }));
  check("(C) failing-test run: caveat appended", !!ff && /NOT VERIFIED/.test(ff.text ?? ""));

  // UNVERIFIED: edit → final (never tested).
  const f3 = makeFile("unv.txt", "value = alpha");
  const unvFrames = await runLoop(
    [toolTurn("apply-patch", { path: f3, edits: [{ find: "alpha", replace: "beta" }] }), finalTurn("Done, I think.")],
    "scope",
    ["confirm"],
  );
  const uf = finalFrame(unvFrames);
  check("(C) UNVERIFIED run: verified=unverified", uf?.verified === "unverified", JSON.stringify({ v: uf?.verified }));
  check("(C) UNVERIFIED run: caveat appended", !!uf && /NOT VERIFIED/.test(uf.text ?? ""));

  // Non-coding run: a pure deep-reason-free answer never stamps verified.
  const plain = await runLoop([finalTurn("Just an answer.")], "scope", ["confirm"]);
  check("(C) non-coding run: verified absent", finalFrame(plain)?.verified === undefined);
}

// -----------------------------------------------------------------------------
// (D) THE TRUST BOUNDARY — audit parity + safe-only refusal.
// -----------------------------------------------------------------------------
{
  const rows = db
    .prepare("SELECT action_id, authorized_via, ok FROM action_log WHERE action_id = 'run-tests'")
    .all() as Array<{ action_id: string; authorized_via: string; ok: number }>;
  check("(D) run-tests runs were AUDITED in action_log", rows.length >= 3, `rows=${rows.length}`);
  check("(D) audited honestly as session-scope (not a forged token)",
    rows.length > 0 && rows.every((r) => r.authorized_via === "session-scope"));

  const before = (db.prepare("SELECT COUNT(*) c FROM action_log WHERE action_id = 'run-tests'").get() as { c: number }).c;
  const safeFrames = await runLoop(
    [toolTurn("run-tests", { cwd: tmp, command: "exit 0" }), finalTurn("blocked")],
    "safe-only",
    [],
  );
  const refused = safeFrames.find(
    (f): f is AgentEvent => isAgentEvent(f) && f.type === "tool-result" && f.tool?.actionId === "run-tests",
  );
  check("(D) run-tests is REFUSED in safe-only mode", refused?.tool?.ok === false && /permission|safe-only/i.test(refused?.tool?.error ?? ""));
  const after = (db.prepare("SELECT COUNT(*) c FROM action_log WHERE action_id = 'run-tests'").get() as { c: number }).c;
  check("(D) safe-only refusal spawned NO process (no new audit row)", after === before, `${before}→${after}`);
  check("(D) run-tests / run-build are confirm-tier in the registry",
    getActionDef("run-tests")?.risk === "confirm" && getActionDef("run-build")?.risk === "confirm");
}

// -----------------------------------------------------------------------------
// (E) apply-patch path guard.
// -----------------------------------------------------------------------------
{
  const { executeAction } = await import("../src/actions/executor.js");
  const { mintConfirmToken } = await import("../src/actions/confirmTokens.js");
  // Refuses a relative path before any fs touch.
  const rel = await executeAction({ actionId: "apply-patch", args: { path: "relative.txt", edits: [{ find: "a", replace: "b" }] }, sessionScope: { allow: ["confirm"] } });
  check("(E) apply-patch refuses a relative path", rel.ok === false && /absolute/.test(rel.error ?? ""));
  // A real guarded edit via a confirm token round-trips.
  const f = makeFile("patch.txt", "one two three");
  const tok = mintConfirmToken("apply-patch", { path: f, edits: [{ find: "two", replace: "2" }] });
  const ok = await executeAction({ actionId: "apply-patch", args: { path: f, edits: [{ find: "two", replace: "2" }] }, confirmToken: tok });
  check("(E) apply-patch edits a guarded file with a confirm token", ok.ok === true && readFileSync(f, "utf8") === "one 2 three");
}

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
