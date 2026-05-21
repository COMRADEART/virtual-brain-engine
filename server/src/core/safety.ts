// Thin Phase-1 safety layer for the agentic runtime.
//
// report.txt asks for a full permission system + command allowlist + dangerous
// command confirmation + API vault. Per the approved plan those are DEFERRED;
// Phase 1 ships only an audit trail + an allow-all gate so the seam exists and
// every agent action is recorded. The runtime calls `permitAndAudit` before
// each agent's act() — flipping a future allowlist to deny lives entirely
// behind this interface, no agent code changes.

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
