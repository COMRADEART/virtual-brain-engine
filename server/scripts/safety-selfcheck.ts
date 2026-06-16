// Autonomous-agent safety gate selfcheck. HERMETIC: temp DB via BRAIN_DB_PATH
// (set BEFORE importing config-dependent modules), no network, no LLM.
//
// WHY THIS EXISTS — core/safety.ts is the gate the AgentRuntime consults before
// every autonomous agent's act() (runtime.ts: `if (safety.permitAndAudit(...))`).
// It shipped Phase-1 allow-all with NO selfcheck (absent from the gate list), so
// the seam was unverified: nobody had proven the runtime actually honors a deny,
// or that the audit row faithfully records the decision. This file is that
// runnable check. It does NOT build an allowlist policy over the labels that
// flow here ("act", "promote-ranker-weights") — those are internal cognitive
// acts, and the dangerous effector (shell/files/web) is a separate, already-gated
// path (actions/executor.ts + actions:selfcheck). The `allowed` column remains
// the hook a future deny policy slots into; this check proves that hook works.
//
// Run: npm --prefix server run safety:selfcheck
//
// Asserts:
//   Allow  — createSafetyGate permits (Phase 1) AND writes agent_audit(allowed=1).
//   Deny   — a gate returning false makes AgentRuntime SKIP act() (the seam).
//   Audit  — a deny still records agent_audit(allowed=0) (the future-policy path).
//   Memory — createMemorySafetyGate records calls + permits (self-check gate).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import type { Agent } from "../src/agents/Agent.js";
import type { SafetyGate } from "../src/core/safety.js";

// Redirect the DB to a throwaway dir BEFORE importing config-dependent modules.
const tmp = mkdtempSync(join(tmpdir(), "brain-safetycheck-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const { openDb } = await import("../src/db/sqlite.js");
const { createSafetyGate, createMemorySafetyGate } = await import("../src/core/safety.js");
const { getEventBus } = await import("../src/core/eventBus.js");
const { AgentRuntime } = await import("../src/agents/runtime.js");

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

// --- T1: production gate permits + audits allowed=1 ----------------------------
const gate = createSafetyGate();
const allowed = gate.permitAndAudit("probe", "act", "init-cycle");
check("production gate permits (Phase 1 allow-all)", allowed === true);
const row = openDb().prepare(
  `SELECT agent, action, allowed, detail FROM agent_audit
   WHERE agent = ? ORDER BY created_at DESC LIMIT 1`,
).get("probe") as
  | { agent: string; action: string; allowed: number; detail: string | null }
  | undefined;
check(
  "permitAndAudit writes agent_audit (allowed=1, detail preserved)",
  !!row && row.allowed === 1 && row.action === "act" && row.detail === "init-cycle",
  row ? JSON.stringify(row) : "(no row)",
);

// --- T2 + T3: a deny gate skips act() AND audits allowed=0 ---------------------
// This is the seam. A future allowlist slotting into createSafetyGate would
// return false on a rejected action; this proves the runtime honors that and the
// deny is still auditable.
let actCalls = 0;
const fakeAgent: Agent = {
  name: () => "probe",
  capabilities: () => [],
  init: async () => {},
  handleEvent: async () => {},
  think: async () => {},
  act: async () => { actCalls++; },
  shutdown: async () => {},
};
const denyGate: SafetyGate = {
  permitAndAudit(agent, action, detail) {
    try {
      openDb().prepare(
        `INSERT INTO agent_audit (id, agent, action, allowed, detail, created_at)
         VALUES (?, ?, ?, 0, ?, ?)`,
      ).run(ulid(), agent, action, detail ?? null, new Date().toISOString());
    } catch {
      /* audit must never block the agent loop */
    }
    return false;
  },
};
const runtime = new AgentRuntime({ bus: getEventBus(), safety: denyGate });
runtime.register(fakeAgent);
await runtime.cycleOnce();
check("deny gate makes AgentRuntime SKIP act()", actCalls === 0, `actCalls=${actCalls}`);

const denyRow = openDb().prepare(
  `SELECT allowed FROM agent_audit WHERE agent = ? AND allowed = 0 ORDER BY created_at DESC LIMIT 1`,
).get("probe") as { allowed: number } | undefined;
check("deny is audited as allowed=0 (future-policy path)", !!denyRow && denyRow.allowed === 0);

// --- T4: memory gate (used by the agents self-check) records + permits ----------
const mem = createMemorySafetyGate();
const m = mem.permitAndAudit("probe", "act");
check(
  "createMemorySafetyGate records the call + permits",
  m === true && mem.calls.length === 1 && mem.calls[0].agent === "probe",
);

// Best-effort cleanup (openDb singleton holds the file open on Windows).
try {
  const { rmSync } = await import("node:fs");
  rmSync(tmp, { recursive: true, force: true });
} catch {
  /* tmpdir is OS-managed */
}

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);