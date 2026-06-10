// Embodiment (action → consequence) selfcheck — hermetic (throwaway DB,
// no LLM, no network; the only fs touched is the temp dir).
//
// Run: npm --prefix server run embodiment:selfcheck
//
// Asserts:
//   (A) PURE: stateChanged handles null/mismatched probes (null = "couldn't
//       observe", never a fake no) and detects fingerprint changes.
//   (B) probeState: fs probe fingerprints a file before/after a write
//       (different) and reports "absent" for a missing path; memory probe
//       counts memories; unprobeable actions → null.
//   (C) recordActionOutcome writes success/failure (always) and state-changed
//       (only when both probes exist) into causal_links with the
//       action-executor source; repeat observations accumulate Laplace stats.
//   (D) The REAL executor path: executeAction("search-memory") lands an
//       `action:search-memory` success observation; a confirm-tier action via
//       sessionScope ("create-note") lands `state-changed` occurred=true
//       (the note changed the memory count — observed, not assumed).
//   (E) Failure isolation: with causal_links dropped, nothing throws.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

const tmp = mkdtempSync(join(tmpdir(), "brain-embodiment-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const { probeState, stateChanged, recordActionOutcome, CAUSAL_SOURCE } = await import(
  "../src/actions/consequences.js"
);
const { executeAction } = await import("../src/actions/executor.js");
const { getEffectsForCause, predictEffects } = await import("../src/core/causalMap.js");
const { openDb } = await import("../src/db/sqlite.js");

const db = openDb();

// -----------------------------------------------------------------------------
// (A) PURE stateChanged.
// -----------------------------------------------------------------------------

check("null probes → null (couldn't observe, never a fake no)", stateChanged(null, null) === null && stateChanged({ kind: "fs", fingerprint: "x" }, null) === null);
check("mismatched probe kinds → null", stateChanged({ kind: "fs", fingerprint: "a" }, { kind: "memory", fingerprint: "a" }) === null);
check("same fingerprint → unchanged", stateChanged({ kind: "fs", fingerprint: "a" }, { kind: "fs", fingerprint: "a" }) === false);
check("different fingerprint → changed", stateChanged({ kind: "fs", fingerprint: "a" }, { kind: "fs", fingerprint: "b" }) === true);

// -----------------------------------------------------------------------------
// (B) probeState.
// -----------------------------------------------------------------------------

{
  const filePath = join(tmp, "probe-target.txt");
  const missing = await probeState("write-file", { path: filePath });
  check("missing file probes as absent", missing?.kind === "fs" && missing.fingerprint === "absent");
  writeFileSync(filePath, "hello");
  const before = await probeState("write-file", { path: filePath });
  writeFileSync(filePath, "hello world, longer now");
  const after = await probeState("write-file", { path: filePath });
  check("fs probe fingerprints change across a write", stateChanged(before, after) === true);

  const mem = await probeState("create-note", {});
  check("memory probe counts memories", mem?.kind === "memory" && /^\d+$/.test(mem.fingerprint));
  check("unprobeable action → null", (await probeState("system-info", {})) === null);
}

// -----------------------------------------------------------------------------
// (C) recordActionOutcome → causal ledger.
// -----------------------------------------------------------------------------

{
  const written = recordActionOutcome({
    actionId: "test-action",
    ok: true,
    before: { kind: "fs", fingerprint: "a" },
    after: { kind: "fs", fingerprint: "b" },
  });
  check("3 effect observations when probes exist", written === 3);
  const effects = getEffectsForCause("action:test-action");
  check("ledger carries success/failure/state-changed", ["success", "failure", "state-changed"].every((e) => effects.some((l) => l.effectClass === e)));
  check("source is the action executor", effects.every((l) => l.source === CAUSAL_SOURCE));
  const success = effects.find((l) => l.effectClass === "success");
  check("Laplace stats sane after one ok observation", success?.observations === 1 && success.occurrences === 1 && success.strength > 0.5);

  // A failure observation moves P(failure | action) up.
  recordActionOutcome({ actionId: "test-action", ok: false, before: null, after: null });
  const forecast = predictEffects("action:test-action");
  check("forecast learns from the observed failure", (forecast.expectedFailureRate ?? 0) > 0.3 && forecast.failureConfidence > 0);
  check("null probes skip state-changed (still 2 obs)", getEffectsForCause("action:test-action").find((l) => l.effectClass === "state-changed")?.observations === 1);
}

// -----------------------------------------------------------------------------
// (D) The REAL executor path.
// -----------------------------------------------------------------------------

{
  const r = await executeAction({ actionId: "search-memory", args: { query: "anything" } });
  check("search-memory executes ok", r.ok === true, r.error ?? "");
  const effects = getEffectsForCause("action:search-memory");
  check("executor recorded the observed success", effects.find((l) => l.effectClass === "success")?.occurrences === 1);

  // Confirm-tier via the agent loop's session-scope channel — the note insert
  // must be OBSERVED as a memory-count change.
  const note = await executeAction({
    actionId: "create-note",
    args: { content: "embodiment selfcheck note" },
    sessionScope: { allow: ["confirm"] },
  });
  check("create-note executes under session scope", note.ok === true, note.error ?? "");
  const noteEffects = getEffectsForCause("action:create-note");
  const changed = noteEffects.find((l) => l.effectClass === "state-changed");
  check("the world change was OBSERVED (memory count moved)", changed?.occurrences === 1 && changed.observations === 1);
}

// -----------------------------------------------------------------------------
// (E) Failure isolation.
// -----------------------------------------------------------------------------

db.exec("DROP TABLE IF EXISTS causal_links");
let threw = false;
try {
  recordActionOutcome({ actionId: "x", ok: true, before: null, after: null });
  await executeAction({ actionId: "search-memory", args: { query: "still works" } });
} catch {
  threw = true;
}
check("nothing throws with causal_links gone (action still executes)", threw === false);

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
