// Model Hub contract (zero runtime deps). "Download a model and wire it into the
// brain": browse installed Ollama models, pull new ones (progress streams over
// the bus + flashes the `model-hub` cortex), and select one as the CHAT model.
//
// SCOPE: chat models only. The embedding model is deliberately NOT selectable
// here — memory_vec is a fixed float[EMBEDDING_DIM] table, so swapping the
// embedder mid-life would make every vector search throw a dim mismatch. Changing
// embeddings is a separate, re-embed-everything operation, not a one-click pull.

export interface SuggestedModel {
  name: string; // exact `ollama pull` tag
  label: string;
  note: string;
}

export interface ModelPullState {
  active: boolean;
  model: string | null;
  status: string; // latest human-readable phase ("pulling manifest", "downloading", "success", …)
  percent: number | null; // 0..1 across all layers; null while indeterminate (manifest phase)
  done: boolean;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

// Per-cortex model routing: the MoE router classifies each query into a profile;
// each profile can be assigned a specific installed CHAT model. Unassigned →
// the default chat model (so an empty config reproduces prior behaviour exactly).
export type ModelProfile = "fast" | "code" | "deep" | "default";

export const MODEL_PROFILES: ModelProfile[] = ["fast", "code", "deep", "default"];

export const MODEL_PROFILE_LABELS: Record<ModelProfile, string> = {
  fast: "Quick lookups (shallow route)",
  code: "Code / project queries",
  deep: "Hard multi-step reasoning",
  default: "Everything else",
};

export interface ModelRoutingView {
  profiles: ModelProfile[];
  // Only assigned profiles are present; the rest fall back to the chat model.
  assignments: Partial<Record<ModelProfile, string>>;
  available: string[];
}

// A remote provider (NVIDIA NIM, Gemini, etc.) and its available models.
export interface RemoteProviderModel {
  id: string; // connector id (e.g. "nvidia", "google-gemini")
  name: string; // display name (e.g. "NVIDIA NIM (remote)")
  baseUrl: string;
  models: string[]; // model IDs returned by GET /v1/models
  currentModel: string | null; // the model currently assigned to this connector
  error: string | null; // non-null when the model list couldn't be fetched
}

export interface ModelsView {
  // Resolved loopback Ollama daemon, or null when none is reachable/local.
  base: string | null;
  // Currently configured chat model (the default connector's model).
  chatModel: string | null;
  installed: string[];
  suggested: SuggestedModel[];
  pull: ModelPullState;
  // Models from enabled remote providers (NVIDIA NIM, Gemini, etc.).
  remoteProviders: RemoteProviderModel[];
}
