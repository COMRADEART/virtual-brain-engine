// Learning Lab contract (zero runtime deps — pure types).
//
// Surfaces the brain's OWN online learning to the UI: the from-scratch
// learning-to-rank model that trains on implicit citations + explicit feedback,
// and the optional from-scratch PyTorch LLM trainer (Phase C) that trains on
// the user's own memory corpus.

export interface RankerWeight {
  /** Human-readable feature name (rankerModel.FEATURE_LABELS). */
  label: string;
  /** The learned weight. Sign + magnitude show what the model values. */
  weight: number;
}

export interface LossPoint {
  trainedCount: number;
  loss: number;
  /** 'citation' (implicit) or 'feedback' (explicit 👍/👎). */
  kind: string;
  createdAt: string;
}

export interface RankerLearningStatus {
  version: number;
  /** Number of citation-bearing queries trained on so far. */
  trainedCount: number;
  /** Queries needed before the learned model fully replaces the heuristic. */
  warmAt: number;
  /** Blend toward the learned model: min(1, trainedCount / warmAt). */
  alpha: number;
  warm: boolean;
  weights: RankerWeight[];
}

export type LlmTrainerState = "idle" | "running" | "done" | "error" | "unavailable";

export interface LlmTrainerStatus {
  state: LlmTrainerState;
  step: number;
  totalSteps: number;
  /** Latest training loss (cross-entropy), null before the first eval. */
  loss: number | null;
  /** Latest validation loss, null before the first eval. */
  valLoss: number | null;
  /** A short generated text sample from the current model. */
  sample: string | null;
  vocabSize: number | null;
  /** Model parameter count. */
  params: number | null;
  /** Characters of personal corpus the model trained on. */
  corpusChars: number | null;
  message: string | null;
  updatedAt: string | null;
}

export interface FeedbackStats {
  up: number;
  down: number;
  total: number;
  lastAt: string | null;
}

// Phase 4 — learning from USE. Aggregates signal from the new surfaces (the
// command/action layer + computer-wide ingestion) and the explicit
// usefulness verdicts the user gives on surfaced memories/actions, so the loop
// "the brain improves from how you use it" is observable.
export interface UsageSummary {
  // Executed commands (from action_log): how many ran and how many succeeded.
  actions: { total: number; ok: number; successRate: number };
  // Computer-wide ingestion volume (from ingest_log).
  ingest: { totalIngested: number };
  // 👍/👎 the user gave on a surfaced memory's usefulness (nudges importance —
  // a live ranker feature — so this directly shapes future retrieval).
  memoryFeedback: { up: number; down: number };
  // 👍/👎 on whether a resolved command was the right one (resolver-training
  // dataset for a future learned resolver).
  actionFeedback: { up: number; down: number };
}

export interface LearningStatus {
  ranker: RankerLearningStatus;
  loss: LossPoint[];
  feedback: FeedbackStats;
  llm: LlmTrainerStatus;
  usage: UsageSummary;
}
