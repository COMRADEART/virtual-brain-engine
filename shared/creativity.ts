// Creativity engine — distant-concept recombination.
//
// Pure type contract (zero runtime deps). The engine lives in
// server/src/core/creativity.ts: it samples two semantically DISTANT memories,
// asks the connector to bridge them into one novel idea/hypothesis, and stores
// the result as a memory + a `creative_ideas` row + a cognition event. The
// Creativity cortex of the conscious workspace bids from the pending ideas.

export type CreativeIdeaStatus =
  | "pending" // freshly synthesized, not yet surfaced to consciousness
  | "surfaced" // won a workspace slot / shown
  | "kept"; // judged worth keeping

export interface CreativeIdea {
  id: string;
  /** The two source memories that were recombined. */
  seedMemoryIds: [string, string];
  /** The synthesized idea text. */
  idea: string;
  /** Lexical distance between the seeds, [0,1] — higher = more unexpected. */
  novelty: number;
  status: CreativeIdeaStatus;
  /** The stored memory the idea became (so it's retrievable), if persisted. */
  memoryId: string | null;
  createdAt: string;
}

export interface CreativityStats {
  total: number;
  pending: number;
  surfaced: number;
  kept: number;
  avgNovelty: number;
}
