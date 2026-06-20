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
  /** "cuda" or "cpu" — what the worker is training on. */
  device: string | null;
  /** Absolute path of the persisted checkpoint once one exists (survives worker restarts). */
  checkpointPath: string | null;
  message: string | null;
  updatedAt: string | null;
}

/** Result of sampling from the persisted from-scratch brain model. */
export interface LlmGenerateResult {
  ok: boolean;
  text: string | null;
  latencyMs: number | null;
  params: number | null;
  device: string | null;
  error: string | null;
}

// Phase D — the brain's OWN model. A LoRA continued-pretraining pass over a
// small open base (default Qwen2.5-0.5B) on the brain's memory corpus, merged
// and served through Ollama as an opt-in connector. Distinct from the Phase C
// from-scratch trainer (LlmTrainerStatus): this produces a model the brain can
// actually reason with — adapts VOICE/domain; RAG stays the knowledge path.
export type OwnModelState =
  | "idle"
  | "running"
  | "merging"
  | "done"
  | "error"
  | "unavailable";

export interface OwnModelStatus {
  state: OwnModelState;
  step: number;
  totalSteps: number;
  /** Latest accumulated training loss, null before the first step. */
  loss: number | null;
  /** HF base model id being adapted (e.g. "Qwen/Qwen2.5-0.5B"). */
  baseModel: string | null;
  /** Absolute path of the merged HF model dir once training completes. */
  outputDir: string | null;
  /** Absolute path of the exported GGUF (what Ollama imports), once available. */
  ggufPath: string | null;
  /** Ollama model name once served (e.g. "mango"). */
  modelName: string | null;
  /** True once the merged model has been imported into Ollama + seeded as a connector. */
  served: boolean;
  /** Characters of personal corpus the model trained on. */
  corpusChars: number | null;
  /** Trainable (LoRA) parameter count. */
  trainableParams: number | null;
  /** "cuda" or "cpu" — what the worker trained on. */
  device: string | null;
  message: string | null;
  updatedAt: string | null;
}

// AirLLM — high-parameter inference on a small GPU (layer-by-layer offloading).
// Inference-only. Two roles: query a large model directly (/airllm/generate) and
// act as the distillation TEACHER for the mango own-model trainer (the big model
// authors clean answers from the corpus; the small student trains on them).
export type AirllmState =
  | "idle"
  | "loading"
  | "ready"
  | "generating"
  | "error"
  | "unavailable";

export interface AirllmStatus {
  state: AirllmState;
  /** Loaded HF model id (e.g. "Qwen/Qwen2.5-7B-Instruct"), null before first load. */
  model: string | null;
  /** Quantization in effect: "4bit" | "8bit" | null (none). */
  compression: string | null;
  /** "cuda" | "cpu". */
  device: string | null;
  message: string | null;
  updatedAt: string | null;
}

export interface AirllmGenerateResult {
  ok: boolean;
  /** The generated text. "" is a valid (degenerate) success — distinct from a
   * failure (ok:false). null only when there was no generation at all. */
  text: string | null;
  model: string | null;
  device: string | null;
  latencyMs: number | null;
  /** True when the prompt exceeded the engine's input token cap and was clipped. */
  truncated: boolean;
  error: string | null;
}

// turbovec — an OPTIONAL alternative vector index hosted on the Python worker
// sidecar (TurboQuant, ~16x compression at 2-bit, SIMD ARM/x86). OFF by default
// (TURBOVEC); the in-process sqlite-vec index stays the default and the hot path
// falls back to it on ANY turbovec error/miss. At personal-brain scale (~9k
// vectors) turbovec's compression+SIMD is a forward-looking experiment — its
// value arrives past ~100k vectors (see memory/turbovec-deferred.md).
export type TurbovecState = "ready" | "unavailable" | "error";

export interface TurbovecStatus {
  state: TurbovecState;
  /** Mirrors CONFIG.turbovecEnabled so the UI can show "off" without a probe. */
  enabled: boolean;
  /** Index dimensionality (matches EMBEDDING_DIM once the first vector is added). */
  dim: number | null;
  /** Quantization width in use: 2 or 4. */
  bitWidth: number | null;
  /** Vectors currently held in the worker's in-memory index. */
  count: number;
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
