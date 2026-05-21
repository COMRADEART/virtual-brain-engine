import { ulid } from "ulid";
import type { Conversation, ConversationMessage } from "../../../../shared/memory.js";
import { openDb } from "../sqlite.js";

interface ConversationRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  pipeline_run_id: string | null;
}

function rowToConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMessage(row: MessageRow): ConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    pipelineRunId: row.pipeline_run_id,
  };
}

export function ensureConversation(conversationId: string | undefined, prompt: string): Conversation {
  const db = openDb();
  if (conversationId) {
    const existing = db
      .prepare<[string], ConversationRow>(`SELECT * FROM conversations WHERE id = ?`)
      .get(conversationId);
    if (existing) {
      return rowToConversation(existing);
    }
  }
  const id = conversationId ?? ulid();
  const now = new Date().toISOString();
  const title = prompt.slice(0, 80).trim() || "New conversation";
  db.prepare(
    `INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run(id, title, now, now);
  return { id, title, createdAt: now, updatedAt: now };
}

export function listConversations(limit = 50): Conversation[] {
  const db = openDb();
  const rows = db
    .prepare<[number], ConversationRow>(
      `SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(limit);
  return rows.map(rowToConversation);
}

export function listMessages(conversationId: string, limit = 100, offset = 0): ConversationMessage[] {
  const db = openDb();
  const rows = db
    .prepare<[string, number, number], MessageRow>(
      `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?`,
    )
    .all(conversationId, limit, offset);
  return rows.map(rowToMessage);
}

export function getConversation(id: string): Conversation | null {
  const db = openDb();
  const row = db
    .prepare<[string], ConversationRow>(`SELECT * FROM conversations WHERE id = ?`)
    .get(id);
  return row ? rowToConversation(row) : null;
}

export function insertMessage(input: {
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  pipelineRunId?: string | null;
}): ConversationMessage {
  const db = openDb();
  const id = ulid();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, created_at, pipeline_run_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.conversationId, input.role, input.content, now, input.pipelineRunId ?? null);
  db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(
    now,
    input.conversationId,
  );
  return {
    id,
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    createdAt: now,
    pipelineRunId: input.pipelineRunId ?? null,
  };
}

export interface PipelineRunRecord {
  id: string;
  conversationId: string;
  prompt: string;
  answer: string | null;
  status: "pending" | "complete" | "error";
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export function createPipelineRun(input: { conversationId: string; prompt: string }): PipelineRunRecord {
  const db = openDb();
  const id = ulid();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO pipeline_runs (id, conversation_id, prompt, status, started_at)
     VALUES (?, ?, ?, 'pending', ?)`,
  ).run(id, input.conversationId, input.prompt, now);
  return {
    id,
    conversationId: input.conversationId,
    prompt: input.prompt,
    answer: null,
    status: "pending",
    startedAt: now,
    finishedAt: null,
    error: null,
  };
}

export function completePipelineRun(id: string, answer: string): void {
  const db = openDb();
  db.prepare(
    `UPDATE pipeline_runs SET answer = ?, status = 'complete', finished_at = ? WHERE id = ?`,
  ).run(answer, new Date().toISOString(), id);
}

export function failPipelineRun(id: string, error: string): void {
  const db = openDb();
  db.prepare(
    `UPDATE pipeline_runs SET status = 'error', finished_at = ?, error = ? WHERE id = ?`,
  ).run(new Date().toISOString(), error, id);
}
