// SFT pair repository (Learning Lab — the data flywheel). A 👍 on an answer
// promotes that run's (prompt, answer) into a durable instruction pair; a 👎
// retracts it (the user changed their mind, or rated 👍 by mistake). The
// export shape matches what an instruction-SFT trainer expects (JSONL of
// {instruction, response}).

import { ulid } from "ulid";
import { openDb } from "../sqlite.js";

export interface SftPair {
  id: string;
  runId: string;
  conversationId: string | null;
  prompt: string;
  answer: string;
  createdAt: string;
}

/**
 * Promote a 👍-rated run into an SFT pair. Reads the prompt/answer straight
 * from pipeline_runs (the source of truth) rather than trusting the caller.
 * Idempotent per run (UNIQUE run_id, INSERT OR IGNORE). Returns true when a
 * new pair was captured.
 */
export function captureSftPair(runId: string): boolean {
  const db = openDb();
  const run = db
    .prepare<[string], { conversation_id: string | null; prompt: string; answer: string | null }>(
      `SELECT conversation_id, prompt, answer FROM pipeline_runs WHERE id = ?`,
    )
    .get(runId);
  if (!run || !run.answer || run.answer.trim().length === 0) return false;
  const now = new Date().toISOString();
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO sft_pairs (id, run_id, conversation_id, prompt, answer, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(ulid(), runId, run.conversation_id, run.prompt, run.answer, now);
  return res.changes > 0;
}

/** A 👎 after a 👍 retracts the pair. Returns true when something was removed. */
export function retractSftPair(runId: string): boolean {
  const res = openDb().prepare(`DELETE FROM sft_pairs WHERE run_id = ?`).run(runId);
  return res.changes > 0;
}

export function countSftPairs(): number {
  const row = openDb().prepare(`SELECT COUNT(*) AS n FROM sft_pairs`).get() as { n: number };
  return row.n;
}

export function listSftPairs(limit = 10_000): SftPair[] {
  const rows = openDb()
    .prepare<[number], {
      id: string;
      run_id: string;
      conversation_id: string | null;
      prompt: string;
      answer: string;
      created_at: string;
    }>(`SELECT id, run_id, conversation_id, prompt, answer, created_at
        FROM sft_pairs ORDER BY created_at ASC LIMIT ?`)
    .all(Math.max(1, limit));
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    conversationId: r.conversation_id,
    prompt: r.prompt,
    answer: r.answer,
    createdAt: r.created_at,
  }));
}

/** JSONL export, one {instruction, response} object per line — trainer-ready. */
export function exportSftJsonl(limit = 10_000): string {
  return listSftPairs(limit)
    .map((p) => JSON.stringify({ instruction: p.prompt, response: p.answer }))
    .join("\n");
}
