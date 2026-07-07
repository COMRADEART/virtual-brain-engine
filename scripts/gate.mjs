#!/usr/bin/env node
// Phase 0 — green-build composite gate.
//
// Runs frontend typecheck, server typecheck, the selfchecks
// (router, ranker, agents, safety, twin, memory, perception, attention, graph,
// worldmodel, learning, civilization, evolution, actions, ingest,
// learningloop, models), the server unit tests, the frontend unit tests, and a
// server smoke that BOOTS the real server and
// sweeps every GET endpoint (the runtime check the gate used to lack — it is
// how a dead-on-boot server shipped green). All run as ISOLATED
// subprocesses so a Windows libuv shutdown abort in one selfcheck cannot
// kill the chain via `&&` short-circuit. Each step's PASS/FAIL is judged by
// looking for explicit success markers in stdout AS WELL AS the exit code —
// a 0 exit OR a clean "ALL CHECKS PASSED" / `"result": "PASS"` line counts
// as success.
//
// Exits 0 on full green; exits non-zero with a summary on any failure.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), "..");

const isWindows = process.platform === "win32";
const npmCmd = isWindows ? "npm.cmd" : "npm";

// Each step: a label, the command, and the args. We use the npm scripts that
// already exist in the two package.jsons rather than re-spelling them here.
const steps = [
  // Errors-only lint (warnings are the burn-down baseline, not gate-blocking).
  { label: "lint (errors only)", args: ["run", "gate:lint"] },
  { label: "frontend typecheck", args: ["run", "gate:frontend"] },
  { label: "server typecheck",   args: ["run", "gate:server"] },
  { label: "router selfcheck",   args: ["--prefix", "server", "run", "router:selfcheck"] },
  { label: "ranker selfcheck",   args: ["--prefix", "server", "run", "ranker:selfcheck"] },
  { label: "agents selfcheck",   args: ["--prefix", "server", "run", "agents:selfcheck"] },
  { label: "safety selfcheck",   args: ["--prefix", "server", "run", "safety:selfcheck"] },
  { label: "twin selfcheck",     args: ["--prefix", "server", "run", "twin:selfcheck"] },
  { label: "memory selfcheck",   args: ["--prefix", "server", "run", "memory:selfcheck"] },
  { label: "perception selfcheck", args: ["--prefix", "server", "run", "perception:selfcheck"] },
  { label: "attention selfcheck",  args: ["--prefix", "server", "run", "attention:selfcheck"] },
  { label: "graph selfcheck",      args: ["--prefix", "server", "run", "graph:selfcheck"] },
  { label: "worldmodel selfcheck", args: ["--prefix", "server", "run", "worldmodel:selfcheck"] },
  { label: "learning selfcheck",   args: ["--prefix", "server", "run", "learning:selfcheck"] },
  { label: "ownmodel selfcheck",   args: ["--prefix", "server", "run", "ownmodel:selfcheck"] },
  { label: "civilization selfcheck", args: ["--prefix", "server", "run", "civilization:selfcheck"] },
  { label: "evolution selfcheck", args: ["--prefix", "server", "run", "evolution:selfcheck"] },
  { label: "actions selfcheck",   args: ["--prefix", "server", "run", "actions:selfcheck"] },
  { label: "ingest selfcheck",    args: ["--prefix", "server", "run", "ingest:selfcheck"] },
  { label: "learningloop selfcheck", args: ["--prefix", "server", "run", "learningloop:selfcheck"] },
  { label: "models selfcheck",    args: ["--prefix", "server", "run", "models:selfcheck"] },
  { label: "websearch selfcheck",  args: ["--prefix", "server", "run", "websearch:selfcheck"] },
  { label: "deepresearch selfcheck", args: ["--prefix", "server", "run", "deepresearch:selfcheck"] },
  { label: "rag selfcheck",        args: ["--prefix", "server", "run", "rag:selfcheck"] },
  { label: "rl selfcheck",         args: ["--prefix", "server", "run", "rl:selfcheck"] },
  { label: "agent selfcheck",      args: ["--prefix", "server", "run", "agent:selfcheck"] },
  { label: "brainstate selfcheck", args: ["--prefix", "server", "run", "brainstate:selfcheck"] },
  { label: "dedup selfcheck", args: ["--prefix", "server", "run", "dedup:selfcheck"] },
  { label: "conversation-context selfcheck", args: ["--prefix", "server", "run", "conversationcontext:selfcheck"] },
  { label: "continuity selfcheck", args: ["--prefix", "server", "run", "continuity:selfcheck"] },
  { label: "voice selfcheck", args: ["--prefix", "server", "run", "voice:selfcheck"] },
  { label: "faithfulness selfcheck", args: ["--prefix", "server", "run", "faithfulness:selfcheck"] },
  { label: "github selfcheck",     args: ["--prefix", "server", "run", "github:selfcheck"] },
  { label: "keyrotation selfcheck", args: ["--prefix", "server", "run", "keyrotation:selfcheck"] },
  { label: "backup selfcheck", args: ["--prefix", "server", "run", "backup:selfcheck"] },
  { label: "injection selfcheck", args: ["--prefix", "server", "run", "injection:selfcheck"] },
  { label: "neuromod selfcheck", args: ["--prefix", "server", "run", "neuromod:selfcheck"] },
  { label: "hebbian selfcheck", args: ["--prefix", "server", "run", "hebbian:selfcheck"] },
  { label: "predictive selfcheck", args: ["--prefix", "server", "run", "predictive:selfcheck"] },
  { label: "selfmodel selfcheck", args: ["--prefix", "server", "run", "selfmodel:selfcheck"] },
  { label: "sleep selfcheck", args: ["--prefix", "server", "run", "sleep:selfcheck"] },
  { label: "workspace selfcheck", args: ["--prefix", "server", "run", "workspace:selfcheck"] },
  { label: "embodiment selfcheck", args: ["--prefix", "server", "run", "embodiment:selfcheck"] },
  { label: "episodes selfcheck", args: ["--prefix", "server", "run", "episodes:selfcheck"] },
  { label: "beliefs selfcheck", args: ["--prefix", "server", "run", "beliefs:selfcheck"] },
  { label: "goals selfcheck", args: ["--prefix", "server", "run", "goals:selfcheck"] },
  { label: "pursuit selfcheck", args: ["--prefix", "server", "run", "pursuit:selfcheck"] },
  { label: "procedural selfcheck", args: ["--prefix", "server", "run", "procedural:selfcheck"] },
  { label: "stages selfcheck", args: ["--prefix", "server", "run", "stages:selfcheck"] },
  { label: "mind selfcheck", args: ["--prefix", "server", "run", "mind:selfcheck"] },
  { label: "usermodel selfcheck", args: ["--prefix", "server", "run", "usermodel:selfcheck"] },
  { label: "memorydna selfcheck", args: ["--prefix", "server", "run", "memorydna:selfcheck"] },
  { label: "creativity selfcheck", args: ["--prefix", "server", "run", "creativity:selfcheck"] },
  { label: "hypotheses selfcheck", args: ["--prefix", "server", "run", "hypotheses:selfcheck"] },
  { label: "fastpath selfcheck", args: ["--prefix", "server", "run", "fastpath:selfcheck"] },
  { label: "parallelreason selfcheck", args: ["--prefix", "server", "run", "parallelreason:selfcheck"] },
  { label: "combinedreason selfcheck", args: ["--prefix", "server", "run", "combinedreason:selfcheck"] },
  { label: "adaptivedepth selfcheck", args: ["--prefix", "server", "run", "adaptivedepth:selfcheck"] },
  { label: "narrative selfcheck", args: ["--prefix", "server", "run", "narrative:selfcheck"] },
  { label: "monologue selfcheck", args: ["--prefix", "server", "run", "monologue:selfcheck"] },
  { label: "settings selfcheck", args: ["--prefix", "server", "run", "settings:selfcheck"] },
  { label: "fileingest selfcheck", args: ["--prefix", "server", "run", "fileingest:selfcheck"] },
  { label: "spine selfcheck", args: ["--prefix", "server", "run", "spine:selfcheck"] },
  { label: "coding selfcheck", args: ["--prefix", "server", "run", "coding:selfcheck"] },
  { label: "mcp selfcheck", args: ["--prefix", "server", "run", "mcp:selfcheck"] },
  { label: "mcpmarket selfcheck", args: ["--prefix", "server", "run", "mcpmarket:selfcheck"] },
  { label: "airllm selfcheck", args: ["--prefix", "server", "run", "airllm:selfcheck"] },
  { label: "turbovec selfcheck", args: ["--prefix", "server", "run", "turbovec:selfcheck"] },
  { label: "substrate selfcheck", args: ["--prefix", "server", "run", "substrate:selfcheck"] },
  { label: "observability selfcheck", args: ["--prefix", "server", "run", "observability:selfcheck"] },
  { label: "activeinference selfcheck", args: ["--prefix", "server", "run", "activeinference:selfcheck"] },
  { label: "energybudget selfcheck", args: ["--prefix", "server", "run", "energybudget:selfcheck"] },
  { label: "maturation selfcheck", args: ["--prefix", "server", "run", "maturation:selfcheck"] },
  { label: "eventworkspace selfcheck", args: ["--prefix", "server", "run", "eventworkspace:selfcheck"] },
  { label: "person selfcheck", args: ["--prefix", "server", "run", "person:selfcheck"] },
  { label: "frontend unit tests",  args: ["run", "test:unit"] },
  // Server unit tests (tsx --test "src/**/*.test.ts" — memory + route tests).
  // Hermetic: each test points openDb() at its own temp BRAIN_DB_PATH; no LLM,
  // no network. Exits 0 cleanly on Windows (unlike the selfcheck scripts, the
  // node:test runner tears down without the libuv abort), so it's clean-exit
  // gated, not PASS-marker gated.
  { label: "server unit tests",   args: ["--prefix", "server", "run", "test"] },
  // Boots the real server and sweeps every GET endpoint. Heaviest step → last,
  // so the fast static checks fail first. No LLM required (the /api/ask pipeline
  // is covered by the opt-in ask:smoke tail below).
  { label: "server smoke",         args: ["run", "server:smoke"] },
];

// Opt-in runtime tail (Plan Civil — Phase 0 "verification floor"). The default
// gate keeps its zero-config, no-LLM contract; setting GATE_ASK_SMOKE=1 appends
// a LIVE `POST /api/ask` that boots the server and asserts the 7-step pipeline
// completes end-to-end. ask-smoke.mjs SKIPS cleanly (exit 0, "result":"SKIP")
// when no chat model is reachable, so it's safe even on a connector-less CI box.
if (process.env.GATE_ASK_SMOKE === "1") {
  steps.push({ label: "ask smoke (live /api/ask)", args: ["run", "ask:smoke"] });
  steps.push({ label: "ws smoke (live /api/ask -> /ws/brain broadcast)", args: ["run", "ws:smoke"] });
  steps.push({ label: "agent smoke (live /api/agent main-thinking)", args: ["run", "agent:smoke"] });
  steps.push({ label: "actions smoke (live /api/actions/resolve)", args: ["run", "actions:smoke"] });
  steps.push({ label: "models smoke (live ollama pull)", args: ["run", "models:smoke"] });
  steps.push({ label: "web smoke (egress gate + live fetch)", args: ["run", "web:smoke"] });
  steps.push({ label: "websearch smoke (egress gate + live search)", args: ["run", "websearch:smoke"] });
  steps.push({ label: "github smoke (egress gate + live discovery)", args: ["run", "github:smoke"] });
  steps.push({ label: "person smoke (live watch daemon + executeAction round-trip)", args: ["run", "person:smoke"] });
  steps.push({ label: "deepresearch smoke (live /api/research/deep)", args: ["run", "deepresearch:smoke"] });
}

if (!existsSync(resolve(repoRoot, "package.json"))) {
  console.error(`gate.mjs: cannot locate package.json under ${repoRoot}`);
  process.exit(2);
}

// A "PASS" marker in stdout overrides a non-zero exit code, but ONLY for
// the selfcheck steps — typechecks must exit 0. This is the Windows libuv
// teardown workaround: the checks succeed, then better-sqlite3 + tsx race
// during process exit. As of 2026-06 four selfchecks reproducibly land here —
// perception, learning, ownmodel, airllm — so the tolerance is load-bearing:
// removing it turns those four green-on-content selfchecks red on Windows
// (they PASS, then abort during teardown). Audit the live `npm run gate`
// output before tightening; only fold this branch out if zero selfchecks
// print "PASS (shutdown abort tolerated)". Don't paper over real failures:
// a "FAIL" line in the output forces a failure regardless of exit code.
const SUCCESS_RX = /(ALL CHECKS PASSED|"result"\s*:\s*"PASS"|"failures"\s*:\s*0)/;
const FAILURE_RX = /(\bFAIL\b|"result"\s*:\s*"FAIL"|"failures"\s*:\s*[1-9])/;

const results = [];
let anyHardFailure = false;

for (const step of steps) {
  const isTypecheck = step.label.endsWith("typecheck");
  process.stdout.write(`\n──── ${step.label} ────\n`);

  const res = spawnSync(npmCmd, step.args, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    shell: isWindows,
    env: process.env,
  });

  const stdout = res.stdout ? res.stdout.toString() : "";
  const stderr = res.stderr ? res.stderr.toString() : "";
  process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  const sawSuccess = SUCCESS_RX.test(stdout);
  const sawFailure = FAILURE_RX.test(stdout);
  const cleanExit = res.status === 0;

  let verdict;
  if (sawFailure) {
    verdict = "FAIL"; anyHardFailure = true;
  } else if (cleanExit) {
    verdict = "PASS";
  } else if (!isTypecheck && sawSuccess) {
    // Selfcheck printed success then crashed during shutdown — Windows libuv
    // race. Treat as pass; surface the abort for visibility.
    verdict = "PASS (shutdown abort tolerated)";
  } else {
    verdict = `FAIL (exit ${res.status})`;
    anyHardFailure = true;
  }
  results.push({ label: step.label, verdict });
  if (anyHardFailure) break;
}

console.log("\n──── gate summary ────");
for (const r of results) console.log(`  ${r.verdict.startsWith("PASS") ? "✓" : "✗"} ${r.label} — ${r.verdict}`);

if (anyHardFailure) {
  console.error("\ngate: FAIL");
  process.exit(1);
} else if (results.length < steps.length) {
  console.error("\ngate: incomplete");
  process.exit(2);
} else {
  console.log("\ngate: PASS");
  process.exit(0);
}
