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

// Memory DNA — the living per-memory attributes the master vision asks for
// beyond importance/decay/connections (already on memory_points): an affective
// VALENCE, a credibility/TRUST, and a source VERIFICATION label. Stored under
// `metadata.dna` (no migration); read back via memory/memoryDna.ts, which also
// infers these from provenance for memories written before the feature.
export type MemoryVerification =
  | "unverified" // raw, unconfirmed (e.g. fetched web text)
  | "web-corroborated" // came from a real fetched source (web/github), weak corroboration
  | "user-confirmed" // the user's own files / notes / a 👍'd answer
  | "self-derived"; // the brain's own reasoning / distillation

export interface MemoryDna {
  /** Affective valence at write time, [0,1] (0.5 = neutral). */
  emotion?: number;
  /** Source credibility / trust, [0,1]. Low trust gently down-ranks retrieval. */
  trust?: number;
  /** How the content was verified / where it came from. */
  verification?: MemoryVerification;
}

export type MemoryRelationKind =
  | "cites" // conversation message -> chunk it referenced
  | "derived-from" // summary -> source chunk
  | "follows" // chronological link
  | "contradicts"
  | "supports"
  | "belongs-to-conversation"
  | "associates" // Hebbian co-citation edge — strengthened when two memories are cited together, decays with disuse
  | "distilled-from"; // semantic (sleep-distilled) memory -> source episode

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
