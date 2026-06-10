// Audit trail for the command/action layer. One row per execute attempt that
// passed the allowlist + arg-validation + confirm gates (see actions/executor).
// Distinct from `agent_audit` (the autonomous-agent allow-all trail) because a
// user command carries args, a confirm state, and a result the generic table
// can't express — and Phase 4 will mine this for learning signal.

import { ulid } from "ulid";
import { openDb } from "../sqlite.js";
import type { ActionAuthorization, ActionLogEntry, ActionRiskTier } from "../../../../shared/actions.js";

export interface ActionLogInput {
  actionId: string;
  args: Record<string, unknown>;
  risk: ActionRiskTier;
  confirmed: boolean;
  // How the action was authorised. Optional for back-compat with the few
  // callers that predate the agent loop; defaults to a value derived from
  // `confirmed` + `risk` so the column is never written as a bare "none" for a
  // genuinely-authorised action.
  authorizedVia?: ActionAuthorization;
  ok: boolean;
  summary: string;
}

interface ActionLogRow {
  id: string;
  action_id: string;
  args: string;
  risk: string;
  confirmed: number;
  authorized_via: string;
  ok: number;
  summary: string;
  created_at: string;
}

function deriveAuthorizedVia(input: ActionLogInput): ActionAuthorization {
  if (input.authorizedVia) return input.authorizedVia;
  if (input.confirmed) return "confirm-token";
  return input.risk === "safe" ? "safe" : "none";
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
    authorizedVia: (row.authorized_via || "none") as ActionAuthorization,
    ok: row.ok === 1,
    summary: row.summary,
    createdAt: row.created_at,
  };
}

export function insertActionLog(input: ActionLogInput): ActionLogEntry {
  const db = openDb();
  const id = ulid();
  const createdAt = new Date().toISOString();
  const authorizedVia = deriveAuthorizedVia(input);
  db.prepare(
    `INSERT INTO action_log (id, action_id, args, risk, confirmed, authorized_via, ok, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.actionId,
    JSON.stringify(input.args),
    input.risk,
    input.confirmed ? 1 : 0,
    authorizedVia,
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
    authorizedVia,
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
