// Autonomous-agent safety gate — the seam the AgentRuntime consults before
// every agent's act() (runtime.ts: `if (safety.permitAndAudit(agent.name(),
// "act"))`). Two call sites pass labels through it: the runtime's generic
// "act", and evolutionOptimizer's "promote-ranker-weights".
//
// TRUST MODEL — this gates the AUTONOMOUS agents (IdleAgent, systemSensor,
// observer, summary, scheduler), whose act() emits thoughts / collects metrics
// / maintains internal state. They NEVER reach a dangerous effector: a grep of
// agents/ and core/ shows zero executeAction calls. The dangerous effector path
// (shell / files / web) is the separate, USER-driven actions/executor.ts layer
// — a real allowlist (registry + zod + confirm token + action_log audit),
// verified by actions:selfcheck. So this gate's `allowed` column is the hook
// for a FUTURE deny policy IF autonomous agents ever gain effector capability;
// today it records every autonomous act as an append-only audit trail. Building
// a permission policy over the labels "act" / "promote-ranker-weights" would
// gate non-dangerous internal cognitive acts — that is deferred until there is
// something dangerous to gate, not built speculatively.
//
// VERIFIED by `npm run safety:selfcheck`: the production gate audits allowed=1,
// a deny gate makes the runtime SKIP act() (the seam is real), and a deny
// audits allowed=0 (the path a future allowlist takes). Flipping the policy to
// deny lives entirely behind permitAndAudit — no agent code changes.

import { ulid } from "ulid";
import { openDb } from "../db/sqlite.js";

export interface SafetyGate {
  /**
   * Decide whether `agent` may perform `action`, and record the decision.
   * Phase 1 always returns true.
   */
  permitAndAudit(agent: string, action: string, detail?: string): boolean;
}

/** DB-backed gate used in production (writes to the `agent_audit` table). */
export function createSafetyGate(): SafetyGate {
  return {
    permitAndAudit(agent: string, action: string, detail?: string): boolean {
      const allowed = true; // Phase 1: allow-all. Future allowlist slots in here.
      try {
        const db = openDb();
        db.prepare(
          `INSERT INTO agent_audit (id, agent, action, allowed, detail, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(ulid(), agent, action, allowed ? 1 : 0, detail ?? null, new Date().toISOString());
      } catch (err) {
        // Auditing must never block the agent loop; log and continue.
        console.warn("[safety] audit write failed:", err);
      }
      return allowed;
    },
  };
}

/** In-memory gate for the self-check (no DB). Records calls for assertions. */
export function createMemorySafetyGate(): SafetyGate & { calls: Array<{ agent: string; action: string }> } {
  const calls: Array<{ agent: string; action: string }> = [];
  return {
    calls,
    permitAndAudit(agent: string, action: string): boolean {
      calls.push({ agent, action });
      return true;
    },
  };
}
