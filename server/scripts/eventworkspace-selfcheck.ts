// event-driven workspace selfcheck — gate for the H4 slice.
//
// Hermetic (temp DB via BRAIN_DB_PATH; injected scripted connector — no LLM).
// Covers requestWorkspaceCycle's GATING (the tonic timer + the bid/thought
// machinery are covered by workspace:selfcheck):
//   (A) flag off → strict no-op (null).
//   (B) fires when allowed (returns a report; with a seeded open question +
//       injected connector it produces a real micro-thought).
//   (C) REFRACTORY blocks a second event cycle inside the window.
//   (D) a cycle is allowed again after the refractory window.
//   (E) the energy gate does not false-block at full (rested) energy.
//
// Run: npm --prefix server run eventworkspace:selfcheck

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connector } from "../src/connectors/Connector.js";

const tmp = mkdtempSync(join(tmpdir(), "brain-eventwscheck-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");
process.env.PERCEPTION_WORKER_URL = "http://127.0.0.1:1";

const { openDb } = await import("../src/db/sqlite.js");
const { CONFIG } = await import("../src/config.js");
const { requestWorkspaceCycle, _resetWorkspaceEventForTest, WORKSPACE_REFRACTORY_MS } = await import(
  "../src/core/workspace.js"
);
const { getBrainState } = await import("../src/core/brainState.js");

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

openDb();
const conn = { send: async () => "One careful step of thought about it." } as unknown as Connector;
// Seed an open question so a fired cycle has a real bid → a real micro-thought.
getBrainState().noteOpenQuestion("why does the cold-start cache miss happen", "test-conv");

// =============================================================================
// (A) flag off → no-op
// =============================================================================
CONFIG.workspaceEventDriven = false;
const off = await requestWorkspaceCycle("test", { connector: conn }, 1_000_000);
check("requestWorkspaceCycle is a no-op when WORKSPACE_EVENT_DRIVEN is off", off === null);

// =============================================================================
// (B) fires when allowed
// =============================================================================
CONFIG.workspaceEventDriven = true;
CONFIG.energyBudget = false;
_resetWorkspaceEventForTest();
const t0 = 1_000_000;
const first = await requestWorkspaceCycle("high-uncertainty", { connector: conn }, t0);
check("fires when allowed (returns a report, not the refractory null)", first !== null, JSON.stringify(first));
check(
  "the event cycle ran the workspace end-to-end (bid → micro-thought)",
  !!first && first.thought !== null && first.thought.length > 0,
  JSON.stringify(first),
);

// =============================================================================
// (C) refractory blocks a second cycle inside the window
// =============================================================================
const second = await requestWorkspaceCycle("immune:high", { connector: conn }, t0 + 1_000);
check("REFRACTORY blocks a second event cycle within the window", second === null);

// =============================================================================
// (D) allowed again after the window
// =============================================================================
const third = await requestWorkspaceCycle("immune:high", { connector: conn }, t0 + WORKSPACE_REFRACTORY_MS + 1);
check("a cycle is allowed again after the refractory window elapses", third !== null);

// =============================================================================
// (E) energy gate does not false-block at full (rested) energy
// =============================================================================
CONFIG.energyBudget = true;
_resetWorkspaceEventForTest();
const rested = await requestWorkspaceCycle("test", { connector: conn }, t0 + 10_000_000);
check("at full (rested) energy the energy gate does NOT block the cycle", rested !== null, JSON.stringify(rested));
CONFIG.energyBudget = false;

// =============================================================================
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
