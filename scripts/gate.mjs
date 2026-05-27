#!/usr/bin/env node
// Phase 0 — green-build composite gate.
//
// Runs frontend typecheck, server typecheck, and the six selfchecks
// (ranker, agents, twin, memory, perception, attention) as ISOLATED
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
  { label: "frontend typecheck", args: ["run", "gate:frontend"] },
  { label: "server typecheck",   args: ["run", "gate:server"] },
  { label: "ranker selfcheck",   args: ["--prefix", "server", "run", "ranker:selfcheck"] },
  { label: "agents selfcheck",   args: ["--prefix", "server", "run", "agents:selfcheck"] },
  { label: "twin selfcheck",     args: ["--prefix", "server", "run", "twin:selfcheck"] },
  { label: "memory selfcheck",   args: ["--prefix", "server", "run", "memory:selfcheck"] },
  { label: "perception selfcheck", args: ["--prefix", "server", "run", "perception:selfcheck"] },
  { label: "attention selfcheck",  args: ["--prefix", "server", "run", "attention:selfcheck"] },
  { label: "graph selfcheck",      args: ["--prefix", "server", "run", "graph:selfcheck"] },
  { label: "frontend unit tests",  args: ["run", "test:unit"] },
];

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
