#!/usr/bin/env node
// Phase 0 — green-build composite gate.
//
// Runs frontend typecheck, server typecheck, the selfchecks
// (router, ranker, agents, twin, memory, perception, attention, graph,
// worldmodel, learning, civilization, evolution, actions, ingest,
// learningloop, models), the frontend unit tests, and a server
// smoke that BOOTS the real server and
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
  { label: "rag selfcheck",        args: ["--prefix", "server", "run", "rag:selfcheck"] },
  { label: "rl selfcheck",         args: ["--prefix", "server", "run", "rl:selfcheck"] },
  { label: "agent selfcheck",      args: ["--prefix", "server", "run", "agent:selfcheck"] },
  { label: "brainstate selfcheck", args: ["--prefix", "server", "run", "brainstate:selfcheck"] },
  { label: "dedup selfcheck", args: ["--prefix", "server", "run", "dedup:selfcheck"] },
  { label: "conversation-context selfcheck", args: ["--prefix", "server", "run", "conversationcontext:selfcheck"] },
  { label: "voice selfcheck", args: ["--prefix", "server", "run", "voice:selfcheck"] },
  { label: "faithfulness selfcheck", args: ["--prefix", "server", "run", "faithfulness:selfcheck"] },
  { label: "github selfcheck",     args: ["--prefix", "server", "run", "github:selfcheck"] },
  { label: "keyrotation selfcheck", args: ["--prefix", "server", "run", "keyrotation:selfcheck"] },
  { label: "backup selfcheck", args: ["--prefix", "server", "run", "backup:selfcheck"] },
  { label: "injection selfcheck", args: ["--prefix", "server", "run", "injection:selfcheck"] },
  { label: "frontend unit tests",  args: ["run", "test:unit"] },
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
  steps.push({ label: "agent smoke (live /api/agent main-thinking)", args: ["run", "agent:smoke"] });
  steps.push({ label: "actions smoke (live /api/actions/resolve)", args: ["run", "actions:smoke"] });
  steps.push({ label: "models smoke (live ollama pull)", args: ["run", "models:smoke"] });
  steps.push({ label: "web smoke (egress gate + live fetch)", args: ["run", "web:smoke"] });
  steps.push({ label: "websearch smoke (egress gate + live search)", args: ["run", "websearch:smoke"] });
  steps.push({ label: "github smoke (egress gate + live discovery)", args: ["run", "github:smoke"] });
}

if (!existsSync(resolve(repoRoot, "package.json"))) {
  console.error(`gate.mjs: cannot locate package.json under ${repoRoot}`);
  process.exit(2);
}

// A "PASS" marker in stdout overrides a non-zero exit code, but ONLY for
// the selfcheck steps — typechecks must exit 0. This is the Windows libuv
// teardown workaround: the checks succeed, then better-sqlite3 + tsx race
// during process exit. Don't paper over real failures: a "FAIL" line in the
// output forces a failure regardless of exit code.
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
