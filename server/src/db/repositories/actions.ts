// Audit trail for the command/action layer. One row per execute attempt that
// passed the allowlist + arg-validation + confirm gates (see actions/executor).
// Distinct from `agent_audit` (the autonomous-agent allow-all trail) because a
// user command carries args, a confirm state, and a result the generic table
// can't express — and Phase 4 will mine this for learning signal.

import { ulid } from "ulid";
import { openDb } from "../sqlite.js";
import type { ActionLogEntry, ActionRiskTier } from "../../../../shared/actions.js";

export interface ActionLogInput {
  actionId: string;
  args: Record<string, unknown>;
  risk: ActionRiskTier;
  confirmed: boolean;
  ok: boolean;
  summary: string;
}

interface ActionLogRow {
  id: string;
  action_id: string;
  args: string;
  risk: string;
  confirmed: number;
  ok: number;
  summary: string;
  created_at: string;
}

function safeParseArgs(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function rowToEntry(row: ActionLogRow): ActionLogEntry {
  return {
    id: row.id,
    actionId: row.action_id,
    args: safeParseArgs(row.args),
    risk: row.risk as ActionRiskTier,
    confirmed: row.confirmed === 1,
    ok: row.ok === 1,
    summary: row.summary,
    createdAt: row.created_at,
  };
}

export function insertActionLog(input: ActionLogInput): ActionLogEntry {
  const db = openDb();
  const id = ulid();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO action_log (id, action_id, args, risk, confirmed, ok, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.actionId,
    JSON.stringify(input.args),
    input.risk,
    input.confirmed ? 1 : 0,
    input.ok ? 1 : 0,
    input.summary,
    createdAt,
  );
  return {
    id,
    actionId: input.actionId,
    args: input.args,
    risk: input.risk,
    confirmed: input.confirmed,
    ok: input.ok,
    summary: input.summary,
    createdAt,
  };
}

// Aggregate counts for the Learning Lab usage summary (Phase 4): how many
// commands ran and how many succeeded.
export function actionLogStats(): { total: number; ok: number } {
  const db = openDb();
  const row = db
    .prepare<[], { total: number; ok: number }>(
      `SELECT count(*) AS total, COALESCE(SUM(ok), 0) AS ok FROM action_log`,
    )
    .get();
  return { total: row?.total ?? 0, ok: row?.ok ?? 0 };
}

export function listActionLog(limit = 50): ActionLogEntry[] {
  const db = openDb();
  const rows = db
    .prepare<[number], ActionLogRow>(`SELECT * FROM action_log ORDER BY created_at DESC LIMIT ?`)
    .all(limit);
  return rows.map(rowToEntry);
}
