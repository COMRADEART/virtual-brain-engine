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

export interface LearningStatus {
  ranker: RankerLearningStatus;
  loss: LossPoint[];
  feedback: FeedbackStats;
  llm: LlmTrainerStatus;
}
