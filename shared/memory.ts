// Memory schema shared between frontend (typed read models) and the Express
// server (writes + reads). Mirrors columns on `memory_points` / `memory_relations`.

export type MemorySourceType =
  | "chunk" // file scanner output
  | "conversation" // pipeline learning step
  | "manual"; // user-created note

export interface MemoryPoint {
  id: string; // ULID
  sourceType: MemorySourceType;
  filePath?: string | null;
  projectName?: string | null;
  title?: string | null;
  content: string;
  contentHash: string; // sha1 of `content`
  embeddingId: number | null; // rowid into memory_vec
  importance: number; // 0..1, learning step tunes this
  createdAt: string; // ISO
  updatedAt: string; // ISO
  metadata?: Record<string, unknown>;
}

export type MemoryRelationKind =
  | "cites" // conversation message -> chunk it referenced
  | "derived-from" // summary -> source chunk
  | "follows" // chronological link
  | "contradicts"
  | "supports"
  | "belongs-to-conversation";

export interface MemoryRelation {
  id: string;
  fromId: string;
  toId: string;
  kind: MemoryRelationKind;
  weight: number;
  createdAt: string;
}

export interface MemorySearchHit {
  memory: MemoryPoint;
  score: number; // vector cosine similarity, 0..1
  matchType: "vector" | "keyword" | "hybrid";
}

export interface MemorySearchRequest {
  query: string;
  limit?: number;
  sourceType?: MemorySourceType;
  projectName?: string;
  minScore?: number;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  pipelineRunId?: string | null;
}
