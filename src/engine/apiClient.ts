// Thin typed wrapper around the local /api surface. Same goal as ollamaClient.ts
// but pointed at our Express server (default http://127.0.0.1:8787).

import type { ConnectorDescriptor } from "../../shared/connector";
import type {
  CognitiveAbstraction,
  ImaginationMode,
  ImaginationSession,
  ImaginationSnapshot,
  PredictionReflection,
} from "../../shared/imagination";
import type {
  EvolutionComponentKind,
  EvolutionExperiment,
  EvolutionMutation,
  EvolutionSnapshot,
} from "../../shared/evolution";
import type {
  OrganismSnapshot,
  PersistentGoal,
  ResearchSession,
  SubBrain,
} from "../../shared/organism";
import type {
  Conversation,
  ConversationMessage,
  MemoryPoint,
  MemoryRelation,
  MemorySourceType,
} from "../../shared/memory";

export interface ModelUsageEntry {
  id: string;
  runId: string;
  connectorId: string;
  provider: "local" | "remote";
  model: string;
  keyIndex: number | null;
  fallback: boolean;
  latencyMs: number;
  error: string | null;
  createdAt: string;
}

// ── Mind panel view types — structural mirrors of the server response shapes
// (routes/brain.ts). Local interfaces per the ModelUsageEntry precedent: the
// server modules aren't importable from the browser bundle.
export interface BeliefView {
  id: string;
  statement: string;
  confidence: number;
  domain: string | null;
  status: "active" | "contested" | "weakening" | "retired";
  evidenceCount: number;
  lastUpdated: string;
}

export interface BeliefStatsView {
  total: number;
  active: number;
  contested: number;
  weakening: number;
  retired: number;
  avgConfidence: number;
}

export interface BrainBeliefsView {
  stats: BeliefStatsView;
  beliefs: BeliefView[];
}

export interface GoalNodeView {
  goal: {
    id: string;
    title: string;
    status: string;
    progress: number;
    priority: number;
  };
  depth: number;
  level: string;
  children: GoalNodeView[];
}

export interface BrainGoalTreeView {
  depth: number;
  tree: GoalNodeView[];
}

export interface GoalPursuitReportView {
  pursued: boolean;
  goalId?: string;
  title?: string;
  status?: string;
  reason?: string;
}

export interface ProcedureView {
  id: string;
  title: string;
  steps: string[];
  successCount: number;
  failureCount: number;
  score: number;
  lastUsedAt: string | null;
}

export interface EpisodeView {
  id: string;
  startedAt: string;
  endedAt: string;
  title: string;
  itemCount: number;
}

export interface ModulatorStatusView {
  levels: Record<string, number>;
  baseline: Record<string, number>;
  learningRateScale: number;
  underStress: boolean;
  pulses: number;
}

export interface MaturationFeatureView {
  feature: string;
  active: boolean;
  staticFlag: boolean;
  requiredStage: number;
  matured: boolean;
  expensive: boolean;
  reason: string;
}

export interface MaturationStatusView {
  enabled: boolean;
  stage: number;
  features: MaturationFeatureView[];
}

export interface SelfRepresentationView {
  name: string;
  identity: string;
  doing: string;
  why: string;
  becoming: string;
  character: string;
  emotion: { name: string; value: number };
  stage: { stage: number; name: string };
  goals: string[];
  beliefs: string[];
  strongestSkill: string | null;
  weakestSkill: string | null;
}

export interface NarrativeView {
  identity: string;
  arc: string;
  values: string[];
  pursuits: string[];
  updatedAt: string;
}
import type {
  CaptionRequest,
  CaptionResult,
  TranscribeRequest,
  TranscribeResult,
  WorkerStatus,
} from "../../shared/perception";
import type { PipelineEvent } from "../../shared/pipeline";
import type { BrainStateSnapshot } from "../../shared/brainState";
import type { KernelStatusInfo } from "../../shared/cognition";
import type { SelfConsciousnessState } from "../../shared/selfConsciousness";
import type { LearningStatus, LlmTrainerStatus } from "../../shared/learning";
import type { ActionLogEntry, ActionResolveResult, ActionResult, ActionRiskTier, ActionSpec } from "../../shared/actions";
import type { AgentConfirmDecision, AgentConfirmMode, AgentStreamFrame } from "../../shared/agent";
import type { SpineSnapshot, SpineEvent, SpinalPersonaId } from "../../shared/spine";
import type { SpeakResponse, SpeechKind } from "../../shared/voice";

// A frame on the /api/spine/dispatch SSE stream: a spine-event envelope, or any
// agent-loop / pipeline frame (the deliberate tract reuses the agent loop).
export type SpineStreamFrame =
  | { type: "spine"; event: SpineEvent; timestamp: string }
  | AgentStreamFrame;
import type { FileIngestResult, IngestItem, IngestRunResult, IngestSourceId, IngestStatus } from "../../shared/ingest";
import type { SettingsView, UpdateSettingsResult } from "../../shared/settings";
import type { ModelPullState, ModelsView } from "../../shared/models";
import type { WebResearchView, WebSearchOutcome } from "../../shared/web";
import type { DeepResearchEvent } from "../../shared/research";
import type { SwarmConsensusRound, SwarmNodeDescriptor, SwarmSnapshot, SwarmTask } from "../../shared/swarm";
import type { TwinView, SimulationResult } from "../../shared/twin";
import type {
  AutonomousTask,
  ContextSnapshot,
  GraphSnapshotOutput,
  PersonalityState,
  Phase2Status,
  SemanticMemoryRecord,
  SemanticSearchOutput,
  TemporalEvent,
  WorkflowSnapshotOutput,
  WorkflowTask,
} from "../../shared/phase2";

export interface DiscoveredRuntime {
  kind: "ollama" | "lmstudio" | "llamacpp" | "jan" | "gpt4all" | "vllm" | "tgi";
  label: string;
  baseUrl: string;
  state: "ok" | "ok-no-model" | "unreachable";
  models: string[];
  embedsAvailable: boolean;
  connectorKind: ConnectorDescriptor["kind"];
  message?: string;
}

// Tauri v2 dropped window.__TAURI__; the canonical detection is the
// __TAURI_INTERNALS__ injection. We also accept the public isTauri() helper
// when it loads. Module-level cache so we don't re-probe on every API call.
function inTauri(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const w = window as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  return Boolean(w.__TAURI_INTERNALS__ ?? w.__TAURI__);
}

async function invokeTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  // Lazy import so the @tauri-apps/api dependency only loads when actually
  // running under Tauri.
  const mod = (await import("@tauri-apps/api/core")) as {
    invoke: <R>(cmd: string, a?: Record<string, unknown>) => Promise<R>;
  };
  return mod.invoke<T>(command, args);
}

function getBaseUrl(): string {
  const fromEnv = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_BRAIN_API_URL;
  if (fromEnv) {
    return fromEnv.replace(/\/$/, "");
  }
  return "http://127.0.0.1:8787";
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "content-type": "application/json", "X-Brain-Local": "1", ...(init?.headers ?? {}) },
      ...init,
    });
  } catch (err) {
    throw new ApiError(0, err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(res.status, text || res.statusText);
  }
  return (await res.json()) as T;
}

// Shared SSE reader: POST a JSON body, parse `event:`/`data:` blocks, and yield
// each parsed `data` payload until the `event: done` sentinel. Used by the
// agent-loop streams (POST /api/agent and /api/agent/confirm).
async function* sseStream<T>(path: string, body: unknown, signal?: AbortSignal): AsyncGenerator<T> {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", "X-Brain-Local": "1" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new ApiError(res.status, await res.text().catch(() => res.statusText));
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf("\n\n");
      while (sep >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const eventLine = block.split("\n").find((l) => l.startsWith("event:"));
        const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
        if (dataLine) {
          if (eventLine?.slice(6).trim() === "done") return;
          try {
            yield JSON.parse(dataLine.slice(5).trim()) as T;
          } catch {
            // ponytail: silently skip a malformed SSE data line. Ceiling: a dropped
            // mid-stream frame is lost (no stream-error surfaces). Acceptable because
            // every consumer's final `report`/`done` frame re-asserts full state, so a
            // dropped delta never corrupts the end result. Shared by all 4 SSE consumers.
          }
        }
        sep = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export interface HealthResponse {
  db: "ok" | "error";
  vector: "ok" | "unavailable";
  memoryCount: number;
  connectors: Array<{
    id: string;
    kind: ConnectorDescriptor["kind"];
    state: ConnectorDescriptor["state"];
    enabled: boolean;
    isDefault?: boolean;
    isLocal: boolean;
    baseUrl?: string;
  }>;
  // "local" when every enabled connector has a loopback/RFC1918 baseUrl (or no
  // baseUrl). "remote" when at least one enabled connector points off-machine.
  locality: "local" | "remote";
}

export const apiClient = {
  health(): Promise<HealthResponse> {
    return json<HealthResponse>("/api/health");
  },

  phase2Status(): Promise<Phase2Status> {
    if (inTauri()) return invokeTauri<Phase2Status>("phase2_status");
    return json<Phase2Status>("/api/phase2/status");
  },

  phase2SemanticIngest(input: {
    content: string;
    memoryType?: string;
    projectName?: string;
    sourcePath?: string;
    tags?: string[];
    importance?: number;
  }): Promise<{ memory: SemanticMemoryRecord; graph_nodes_touched: number }> {
    if (inTauri()) return invokeTauri("semantic_memory_ingest", { input });
    return json("/api/phase2/semantic/ingest", { method: "POST", body: JSON.stringify(input) });
  },

  phase2SemanticSearch(input: {
    query: string;
    limit?: number;
    minScore?: number;
    projectName?: string;
    memoryType?: string;
  }): Promise<SemanticSearchOutput> {
    if (inTauri()) return invokeTauri("semantic_memory_search", { input });
    return json("/api/phase2/semantic/search", { method: "POST", body: JSON.stringify(input) });
  },

  phase2Graph(projectName?: string): Promise<GraphSnapshotOutput> {
    const input = { projectName };
    if (inTauri()) return invokeTauri("knowledge_graph_snapshot", { input });
    return json("/api/phase2/graph", { method: "POST", body: JSON.stringify(input) });
  },

  phase2Context(input: {
    projectPath?: string;
    projectName?: string;
    activeFiles?: string[];
    prompt?: string;
  }): Promise<ContextSnapshot> {
    if (inTauri()) return invokeTauri("context_engine_snapshot", { input });
    return json("/api/phase2/context", { method: "POST", body: JSON.stringify(input) });
  },

  phase2Timeline(limit = 30, projectName?: string): Promise<TemporalEvent[]> {
    const input = { limit, projectName };
    if (inTauri()) return invokeTauri("project_timeline_recent", { input });
    return json("/api/phase2/timeline", { method: "POST", body: JSON.stringify(input) });
  },

  phase2RecordTimeline(input: {
    projectName?: string;
    kind: string;
    title: string;
    detail: string;
    relatedPath?: string;
    relatedMemoryId?: string;
    importance?: number;
  }): Promise<TemporalEvent> {
    if (inTauri()) return invokeTauri("record_project_timeline_event", { input });
    return json("/api/phase2/timeline/record", { method: "POST", body: JSON.stringify(input) });
  },

  phase2WorkflowSnapshot(): Promise<WorkflowSnapshotOutput> {
    if (inTauri()) return invokeTauri("workflow_snapshot");
    return json("/api/phase2/workflows");
  },

  phase2WorkflowEnqueue(input: {
    workflowId?: string;
    agent: string;
    action: string;
    priority?: number;
    payload?: Record<string, unknown>;
  }): Promise<WorkflowTask> {
    if (inTauri()) return invokeTauri("workflow_enqueue", { input });
    return json("/api/phase2/workflows/enqueue", { method: "POST", body: JSON.stringify(input) });
  },

  phase2WorkflowNext(): Promise<WorkflowTask | null> {
    if (inTauri()) return invokeTauri("workflow_next_task");
    return json("/api/phase2/workflows/next", { method: "POST" });
  },

  phase2WorkflowComplete(input: { taskId: string; detail?: string; failed?: boolean }): Promise<WorkflowTask | null> {
    if (inTauri()) return invokeTauri("workflow_complete", { input });
    return json("/api/phase2/workflows/complete", { method: "POST", body: JSON.stringify(input) });
  },

  phase2PetState(): Promise<PersonalityState> {
    if (inTauri()) return invokeTauri("pet_personality_state");
    return json("/api/phase2/pet");
  },

  phase2UpdatePet(input: {
    activity: string;
    workload?: number;
    agentCount?: number;
    errorCount?: number;
    projectName?: string;
    novelty?: number;
  }): Promise<PersonalityState> {
    if (inTauri()) return invokeTauri("update_pet_activity", { input });
    return json("/api/phase2/pet/update", { method: "POST", body: JSON.stringify(input) });
  },

  phase2ScheduleTask(input: {
    kind?: string;
    title: string;
    intervalMinutes?: number;
    priority?: number;
    payload?: Record<string, unknown>;
  }): Promise<AutonomousTask> {
    if (inTauri()) return invokeTauri("autonomous_schedule_task", { input });
    return json("/api/phase2/autonomous/schedule", { method: "POST", body: JSON.stringify(input) });
  },

  phase2DueTasks(): Promise<AutonomousTask[]> {
    if (inTauri()) return invokeTauri("autonomous_due_tasks");
    return json("/api/phase2/autonomous/due");
  },

  listConnectors(): Promise<{ connectors: ConnectorDescriptor[] }> {
    return json<{ connectors: ConnectorDescriptor[] }>("/api/connectors");
  },

  testConnector(id: string): Promise<{ ok: boolean; message?: string; models?: string[] }> {
    return json(`/api/connectors/${encodeURIComponent(id)}/test`, { method: "POST" });
  },

  searchMemory(query: string, opts: { limit?: number; kind?: MemorySourceType; project?: string } = {}): Promise<{
    hits: Array<{ score: number; matchType: "vector" | "keyword" | "hybrid"; memory: MemoryPoint }>;
    vectorError?: string;
  }> {
    const params = new URLSearchParams({ q: query });
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.kind) params.set("kind", opts.kind);
    if (opts.project) params.set("project", opts.project);
    return json(`/api/memory/search?${params.toString()}`);
  },

  recentMemories(limit = 20, kind?: MemorySourceType, offset = 0): Promise<{ memories: MemoryPoint[]; offset: number; limit: number }> {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (kind) params.set("kind", kind);
    return json(`/api/memory/recent?${params.toString()}`);
  },

  getMemory(id: string): Promise<{ memory: MemoryPoint; relations: MemoryRelation[] }> {
    return json(`/api/memory/${encodeURIComponent(id)}`);
  },

  deleteMemory(id: string): Promise<{ ok: boolean }> {
    return json(`/api/memory/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  // Dedup-merge audit trail + undo (memory transparency).
  memoryTombstones(limit = 100): Promise<{
    tombstones: Array<{
      id: string;
      keptId: string;
      reason: string;
      similarity: number | null;
      title: string | null;
      contentPreview: string;
      createdAt: string;
    }>;
  }> {
    return json(`/api/memory/tombstones?limit=${limit}`);
  },

  restoreTombstone(id: string): Promise<{ ok: boolean }> {
    return json(`/api/memory/tombstones/${encodeURIComponent(id)}/restore`, { method: "POST" });
  },

  /** Direct download URL for the plain-text memory corpus export (GET, no auth header needed). */
  memoryExportUrl(): string {
    return `${getBaseUrl()}/api/memory/export`;
  },

  triggerScan(): Promise<{ ok: boolean }> {
    return json(`/api/scan/run`, { method: "POST" });
  },

  discoverRuntimes(): Promise<{ runtimes: DiscoveredRuntime[] }> {
    // In Tauri, prefer the Rust-side probe -- it bypasses browser CORS, which
    // would otherwise block fetches to non-:8787 ports from a normal renderer.
    // The Node fallback is used in pure-web (Vite dev) mode.
    if (inTauri()) {
      return invokeTauri<{ runtimes: DiscoveredRuntime[] }>("probe_local_llms");
    }
    return json<{ runtimes: DiscoveredRuntime[] }>(`/api/connectors/discover`);
  },

  reconcileConnectors(): Promise<{ runtimes: DiscoveredRuntime[]; connectors: ConnectorDescriptor[] }> {
    return json(`/api/connectors/reconcile`, { method: "POST" });
  },

  selectConnector(input: {
    connectorId?: string;
    runtimeKind?: string;
    baseUrl?: string;
    kind?: ConnectorDescriptor["kind"];
    model?: string;
    embeddingModel?: string;
  }): Promise<{ connector: ConnectorDescriptor }> {
    return json(`/api/connectors/select`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  scanState(): Promise<{
    state: {
      running: boolean;
      processed: number;
      total: number;
      skipped: number;
      current: string | null;
      startedAt: string | null;
      finishedAt: string | null;
      lastError: string | null;
    };
  }> {
    return json(`/api/scan/state`);
  },

  listConversations(): Promise<{ conversations: Conversation[] }> {
    return json(`/api/conversations`);
  },

  getConversation(id: string): Promise<{ conversationId: string; messages: ConversationMessage[] }> {
    return json(`/api/conversations/${encodeURIComponent(id)}`);
  },

  // Digital Twin: latest snapshot + recent anomalies + live forecasts.
  twin(): Promise<TwinView> {
    return json<TwinView>(`/api/twin`);
  },

  // Predict the impact of an action WITHOUT running it (read-only).
  twinSimulate(action: string): Promise<SimulationResult> {
    return json<SimulationResult>(`/api/twin/simulate`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
  },

  swarm(): Promise<SwarmSnapshot> {
    return json<SwarmSnapshot>(`/api/swarm`);
  },

  swarmRegisterNode(input: Omit<SwarmNodeDescriptor, "registeredAt" | "lastHeartbeatAt" | "activeTasks" | "resources" | "health"> & {
    health?: SwarmNodeDescriptor["health"];
  }): Promise<{ node: SwarmNodeDescriptor; snapshot: SwarmSnapshot }> {
    return json(`/api/swarm/nodes`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  swarmRouteTask(input: {
    goal: string;
    requiredCapabilities: string[];
    priority?: number;
    privacyMode?: "local-first" | "offline-only" | "hybrid-allowed" | "cloud-allowed";
    payload?: Record<string, unknown>;
  }): Promise<{ task: SwarmTask; snapshot: SwarmSnapshot }> {
    return json(`/api/swarm/tasks`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  swarmRouteWorkflow(input: {
    goal: string;
    includeExecution?: boolean;
    priority?: number;
    privacyMode?: "local-first" | "offline-only" | "hybrid-allowed" | "cloud-allowed";
    payload?: Record<string, unknown>;
  }): Promise<{ tasks: SwarmTask[]; snapshot: SwarmSnapshot }> {
    return json(`/api/swarm/workflows`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  swarmConsensus(input: { question: string; taskId?: string }): Promise<{ round: SwarmConsensusRound; snapshot: SwarmSnapshot }> {
    return json(`/api/swarm/consensus`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  imagination(): Promise<ImaginationSnapshot> {
    return json<ImaginationSnapshot>(`/api/imagination`);
  },

  imaginationSimulate(input: {
    goal: string;
    action?: string;
    mode?: ImaginationMode;
    branchCount?: number;
    context?: Record<string, unknown>;
  }): Promise<{ session: ImaginationSession; snapshot: ImaginationSnapshot }> {
    return json(`/api/imagination/simulate`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  imaginationReflect(input: {
    sessionId: string;
    futureId: string;
    actualSummary: string;
    ok: boolean;
    actualDurationMs?: number;
    actualRisk?: number;
  }): Promise<{ reflection: PredictionReflection; snapshot: ImaginationSnapshot }> {
    return json(`/api/imagination/reflect`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  imaginationDream(): Promise<{ abstractions: CognitiveAbstraction[]; snapshot: ImaginationSnapshot }> {
    return json(`/api/imagination/dream`, { method: "POST" });
  },

  // ----- Phase 3 perception sidecar -----------------------------------------
  // probe is cheap (200ms timeout server-side). Safe to poll every 10s while a
  // perception panel is open; not on mount.
  perceptionStatus(): Promise<WorkerStatus> {
    return json<WorkerStatus>(`/api/perceive/status`);
  },

  perceptionTranscribe(req: TranscribeRequest): Promise<TranscribeResult> {
    return json(`/api/perceive/transcribe`, { method: "POST", body: JSON.stringify(req) });
  },

  perceptionCaption(req: CaptionRequest): Promise<CaptionResult> {
    return json(`/api/perceive/caption`, { method: "POST", body: JSON.stringify(req) });
  },

  evolution(): Promise<EvolutionSnapshot> {
    return json<EvolutionSnapshot>(`/api/evolution`);
  },

  evolutionEvaluate(): Promise<{ snapshot: EvolutionSnapshot }> {
    return json(`/api/evolution/evaluate`, { method: "POST" });
  },

  evolutionMutateWorkflow(input: {
    workflowId?: string;
    name?: string;
    goal: string;
    steps?: string[];
  }): Promise<{ mutation: EvolutionMutation; snapshot: EvolutionSnapshot }> {
    return json(`/api/evolution/mutate-workflow`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  evolutionEvolveSkill(input: {
    name?: string;
    goal?: string;
    sourceSkills?: string[];
  } = {}): Promise<{ mutation: EvolutionMutation; snapshot: EvolutionSnapshot }> {
    return json(`/api/evolution/evolve-skill`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  evolutionBenchmarkStrategies(input: {
    goal?: string;
  } = {}): Promise<{ snapshot: EvolutionSnapshot }> {
    return json(`/api/evolution/benchmark-strategies`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  evolutionExperiment(input: {
    name?: string;
    targetKind?: EvolutionComponentKind;
    hypothesis?: string;
  } = {}): Promise<{ experiment: EvolutionExperiment; snapshot: EvolutionSnapshot }> {
    return json(`/api/evolution/experiment`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  evolutionIdentity(): Promise<{ snapshot: EvolutionSnapshot }> {
    return json(`/api/evolution/identity`, { method: "POST" });
  },

  organism(): Promise<OrganismSnapshot> {
    return json<OrganismSnapshot>(`/api/organism`);
  },

  // Central cognitive loop — the unified BrainState snapshot (attention map +
  // working memory + goals + confidence + priorUncertainty + learning). Also
  // streams over the bus as { type: "brain-state" }; this is the poll fallback.
  brainState(): Promise<BrainStateSnapshot> {
    return json<BrainStateSnapshot>(`/api/brain/state`);
  },

  // Brain Kernel — the single status surface: every cognitive module's health
  // probe + the developmental stage (1-7) + recent bus activity.
  brainKernel(): Promise<KernelStatusInfo> {
    return json<KernelStatusInfo>(`/api/brain/kernel`);
  },

  // ── Mind panel introspection (read surfaces of routes/brain.ts) ────────────
  brainBeliefs(status?: "active" | "contested" | "weakening" | "retired"): Promise<BrainBeliefsView> {
    return json<BrainBeliefsView>(`/api/brain/beliefs${status ? `?status=${status}` : ""}`);
  },

  brainGoalTree(): Promise<BrainGoalTreeView> {
    return json<BrainGoalTreeView>(`/api/brain/goals/tree`);
  },

  brainGoalsPursue(): Promise<GoalPursuitReportView> {
    return json<GoalPursuitReportView>(`/api/brain/goals/pursue`, { method: "POST" });
  },

  brainProcedures(): Promise<{ procedures: ProcedureView[] }> {
    return json(`/api/brain/procedures`);
  },

  brainEpisodes(): Promise<{ episodes: EpisodeView[] }> {
    return json(`/api/brain/episodes`);
  },

  brainModulators(): Promise<ModulatorStatusView> {
    return json<ModulatorStatusView>(`/api/brain/modulators`);
  },

  brainMaturation(): Promise<MaturationStatusView> {
    return json<MaturationStatusView>(`/api/brain/maturation`);
  },

  brainSelf(): Promise<SelfRepresentationView> {
    return json<SelfRepresentationView>(`/api/brain/self`);
  },

  brainNarrative(): Promise<{ narrative: NarrativeView | null }> {
    return json(`/api/brain/narrative`);
  },

  // Self-Consciousness engine: the brain's model of itself — self-model,
  // metacognition, affect, inner monologue, self-predictions, autobiographical
  // memory. Also streams over the bus as { type: "self-snapshot" }.
  selfConsciousness(): Promise<SelfConsciousnessState> {
    return json<SelfConsciousnessState>(`/api/self/state`);
  },

  organismWake(): Promise<{ snapshot: OrganismSnapshot }> {
    return json(`/api/organism/wake`, { method: "POST" });
  },

  organismCreateGoal(input: {
    title: string;
    priority?: number;
    dependencies?: string[];
    subgoals?: string[];
    blockers?: string[];
    confidence?: number;
    estimatedCompletionAt?: string;
  }): Promise<{ goal: PersistentGoal; snapshot: OrganismSnapshot }> {
    return json(`/api/organism/goals`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  organismUpdateGoal(input: {
    goalId: string;
    status?: PersistentGoal["status"];
    progress?: number;
    blockers?: string[];
    confidence?: number;
    attempt?: {
      summary: string;
      outcome: "unknown" | "success" | "failed" | "partial";
    };
  }): Promise<{ goal: PersistentGoal; snapshot: OrganismSnapshot }> {
    return json(`/api/organism/goals/update`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  organismMaintenance(): Promise<{ snapshot: OrganismSnapshot }> {
    return json(`/api/organism/maintenance`, { method: "POST" });
  },

  organismDream(): Promise<{ snapshot: OrganismSnapshot }> {
    return json(`/api/organism/dream`, { method: "POST" });
  },

  organismResearch(input: {
    title?: string;
    hypothesis?: string;
  } = {}): Promise<{ session: ResearchSession; snapshot: OrganismSnapshot }> {
    return json(`/api/organism/research`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  organismCreateSubBrain(input: {
    name: string;
    specialization: string;
    inheritedMemoryScopes?: string[];
    inheritedSkills?: string[];
  }): Promise<{ subBrain: SubBrain; snapshot: OrganismSnapshot }> {
    return json(`/api/organism/subbrains`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  // Explicit answer feedback (Learning Lab). rating: +1 helpful / -1 not.
  // Retrains the online ranker against this run's features + nudges cited
  // memories' importance, server-side.
  sendFeedback(input: {
    runId: string;
    rating: 1 | -1;
    comment?: string;
    conversationId?: string;
  }): Promise<{
    ok: boolean;
    trained: boolean;
    citedCount: number;
    feedback: { up: number; down: number; total: number; lastAt: string | null };
  }> {
    return json(`/api/feedback`, { method: "POST", body: JSON.stringify(input) });
  },

  // Learning Lab snapshot: ranker warm-up + labelled weights + loss history +
  // feedback stats + from-scratch LLM trainer status + usage summary (Phase 4).
  learningStatus(): Promise<LearningStatus> {
    return json<LearningStatus>(`/api/learning/status`);
  },

  // Phase 4 — usefulness verdicts. A memory 👍/👎 nudges its importance (a live
  // ranker feature → shapes future retrieval); an action verdict is recorded as
  // resolver-training data. Surfaces (pet, command results) call these.
  sendMemoryFeedback(memoryId: string, rating: 1 | -1): Promise<{ ok: boolean; importance: number }> {
    return json(`/api/feedback/memory`, { method: "POST", body: JSON.stringify({ memoryId, rating }) });
  },

  sendActionFeedback(actionId: string, rating: 1 | -1): Promise<{ ok: boolean }> {
    return json(`/api/feedback/action`, { method: "POST", body: JSON.stringify({ actionId, rating }) });
  },

  // Kick the from-scratch PyTorch trainer (Phase C) on the worker sidecar.
  learningTrainLlm(input: { steps?: number; force?: boolean } = {}): Promise<LlmTrainerStatus> {
    return json<LlmTrainerStatus>(`/api/learning/llm/start`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  learningLlmStatus(): Promise<LlmTrainerStatus> {
    return json<LlmTrainerStatus>(`/api/learning/llm/status`);
  },

  // ----- Phase 3 command/action layer --------------------------------------
  // Allowlisted action specs (for the UI), NL→plan resolution, gated execution,
  // and the audit log. resolveAction NEVER executes; executeAction enforces the
  // confirm-token gate server-side (carry the token from resolveAction for
  // confirm-tier plans).
  listActions(): Promise<{ actions: ActionSpec[] }> {
    return json(`/api/actions`);
  },

  resolveAction(prompt: string): Promise<ActionResolveResult> {
    return json(`/api/actions/resolve`, { method: "POST", body: JSON.stringify({ prompt }) });
  },

  executeAction(input: {
    actionId: string;
    args?: Record<string, unknown>;
    confirmToken?: string;
  }): Promise<ActionResult> {
    return json(`/api/actions/execute`, { method: "POST", body: JSON.stringify(input) });
  },

  actionLog(limit = 50): Promise<{ log: ActionLogEntry[] }> {
    return json(`/api/actions/log?limit=${limit}`);
  },

  // ----- Phase 2 computer-wide memory ingestion ----------------------------
  // Sources are opt-in (default OFF). Governance (consent/exclude/redact/dedup/
  // audit) is enforced server-side; collectors just push items here.
  ingestStatus(): Promise<IngestStatus> {
    return json<IngestStatus>(`/api/ingest/status`);
  },

  ingestSetConsent(sourceId: IngestSourceId, enabled: boolean): Promise<{ ok: boolean; status: IngestStatus }> {
    return json(`/api/ingest/consent`, { method: "POST", body: JSON.stringify({ sourceId, enabled }) });
  },

  ingestPush(sourceId: IngestSourceId, items: IngestItem[]): Promise<IngestRunResult> {
    return json(`/api/ingest/push`, { method: "POST", body: JSON.stringify({ sourceId, items }) });
  },

  // "Learn from the internet": fetch a URL server-side and persist its readable
  // text into memory. Egress is gated by LOCAL_ONLY on the server — when the
  // brain is local-only this returns a `reason` instead of fetching. The pet's
  // command box reaches the same capability via the confirm-tier `learn-url`
  // action (resolveAction → executeAction).
  ingestWeb(url: string): Promise<IngestRunResult & { title: string | null }> {
    return json(`/api/ingest/web`, { method: "POST", body: JSON.stringify({ url }) });
  },

  // "Read any file into the brain": upload a file's base64 bytes; the server
  // extracts readable content (text/code directly, HTML/PDF/Office best-effort,
  // images via the perception worker's caption) and ingests it as governed,
  // retrievable memory. `dataBase64` may be a raw base64 string or a data: URL.
  ingestFile(input: { filename: string; mimeType?: string; dataBase64: string }): Promise<FileIngestResult> {
    return json(`/api/ingest/file`, { method: "POST", body: JSON.stringify(input) });
  },

  // ----- Runtime application settings (edit the brain's own knobs) ----------
  // GET returns the curated catalog + current effective values; POST applies a
  // validated patch to the live config (and persists it); reset restores the
  // .env baseline. Boot-time knobs are flagged requiresRestart in the view.
  getSettings(): Promise<SettingsView> {
    return json<SettingsView>(`/api/settings`);
  },

  updateSettings(patch: Record<string, boolean | number | string>): Promise<UpdateSettingsResult> {
    return json<UpdateSettingsResult>(`/api/settings`, { method: "POST", body: JSON.stringify({ patch }) });
  },

  resetSettings(): Promise<{ ok: boolean; view: SettingsView }> {
    return json(`/api/settings/reset`, { method: "POST" });
  },

  // ----- Hybrid web (FRIDAY online): local + internet side by side ----------
  // Both egress and are gated by LOCAL_ONLY server-side — they return
  // { ok:false, reason } (never a thrown error) when the brain is local-only.
  // webResearch also READS the top pages into memory (learns them). The pet's
  // command box reaches the same capability via the confirm-tier web-search /
  // research-web actions; /api/ask fuses web results automatically when hybrid
  // mode is on.
  webSearch(query: string, limit?: number): Promise<WebSearchOutcome> {
    return json(`/api/web/search`, { method: "POST", body: JSON.stringify({ query, limit }) });
  },

  webResearch(query: string, maxPages?: number): Promise<WebResearchView> {
    return json(`/api/web/research`, { method: "POST", body: JSON.stringify({ query, maxPages }) });
  },

  // ----- Deep Research (Fable-style /deep-research) -------------------------
  // POST /api/research/deep returns SSE. Yields DeepResearchEvent frames as the
  // engine plans sub-questions → gathers local memory + (egress-gated) web →
  // synthesizes cited findings → reflects → streams a final cited report (saved
  // to memory). Egress stays LOCAL_ONLY-gated server-side; on a local-only box it
  // degrades to a local-memory report. The 3D brain flashes from the bus as it runs.
  deepResearch(
    input: { question: string; conversationId?: string; maxRounds?: number; breadth?: number; maxPages?: number },
    signal?: AbortSignal,
  ): AsyncGenerator<DeepResearchEvent> {
    return sseStream<DeepResearchEvent>("/api/research/deep", input, signal);
  },

  // ----- Model Hub: download a chat model → wire it into the brain ----------
  // Pull progress also streams over the bus (type "model-pull") and flashes the
  // model-hub cortex; pull/status is the poll fallback. select sets the CHAT
  // model only (embeddings are fixed).
  models(): Promise<ModelsView> {
    return json<ModelsView>(`/api/models`);
  },

  pullModel(name: string): Promise<{ ok: boolean; pull: ModelPullState }> {
    return json(`/api/models/pull`, { method: "POST", body: JSON.stringify({ name }) });
  },

  modelPullStatus(): Promise<ModelPullState> {
    return json<ModelPullState>(`/api/models/pull/status`);
  },

  selectModel(name: string): Promise<{ ok: boolean }> {
    return json(`/api/models/select`, { method: "POST", body: JSON.stringify({ name }) });
  },

  selectRemoteModel(connectorId: string, model: string): Promise<{ ok: boolean; connector: ConnectorDescriptor }> {
    return json(`/api/models/select-remote`, { method: "POST", body: JSON.stringify({ connectorId, model }) });
  },

  refreshRemoteModels(): Promise<{ ok: boolean; remoteProviders: import("../../shared/models").RemoteProviderModel[] }> {
    return json(`/api/models/remote/refresh`, { method: "POST" });
  },

  getModelUsage(): Promise<{ totalRuns: number; localRuns: number; remoteRuns: number; fallbackRuns: number; recentRuns: ModelUsageEntry[] }> {
    return json(`/api/models/usage`);
  },

  getModelPerformanceStats(days?: number): Promise<{
    models: Array<{
      model: string; provider: string; runs: number;
      avgLatencyMs: number; minLatencyMs: number; maxLatencyMs: number;
      errorRate: number; fallbackRate: number;
      avgStepTimings: { memory_ms?: number; reasoning_ms?: number; error_ms?: number; response_ms?: number };
    }>;
    overall: { avgLatencyMs: number; p50LatencyMs: number; p95LatencyMs: number; totalRuns: number };
  }> {
    const qs = days ? `?days=${days}` : "";
    return json(`/api/models/stats${qs}`);
  },

  getRoutingInsights(): Promise<Array<{
    profile: string; model: string | null; runs: number;
    avgCitations: number; avgConfidence: number; avgLatencyMs: number; qualityScore: number;
  }>> {
    return json(`/api/models/routing-insights`);
  },

  getKeyStats(): Promise<Array<{
    keyIndex: number; runs: number; avgLatencyMs: number; errors: number; errorRate: number;
  }>> {
    return json(`/api/models/key-stats`);
  },

  getConfidenceCalibration(): Promise<Array<{
    bucket: number; avgCitations: number; runs: number;
  }>> {
    return json(`/api/models/calibration`);
  },

  getSearchQuality(): Promise<{
    avgRetrieved: number; avgCited: number; citationRate: number; runs: number;
  }> {
    return json(`/api/models/search-quality`);
  },

  getConnectorHealth(): Promise<Array<{
    connectorId: string; runs: number; errors: number; errorRate: number; avgLatencyMs: number; lastUsedAt: string | null;
  }>> {
    return json(`/api/models/connector-health`);
  },

  compareModels(models: string[]): Promise<Array<{
    model: string; runs: number; avgLatencyMs: number; minLatencyMs: number; maxLatencyMs: number;
    errors: number; errorRate: number; avgStepTimings: Record<string, number> | null;
  }>> {
    return json(`/api/models/compare?models=${encodeURIComponent(models.join(","))}`);
  },

  // POST /api/ask returns SSE. We parse "event:" + "data:" blocks and yield
  // each pipeline event as it arrives.
  async *ask(input: { prompt: string; conversationId?: string }, signal?: AbortSignal): AsyncGenerator<PipelineEvent> {
    const res = await fetch(`${getBaseUrl()}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", "X-Brain-Local": "1" },
      body: JSON.stringify(input),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new ApiError(res.status, await res.text().catch(() => res.statusText));
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let sep = buffer.indexOf("\n\n");
        while (sep >= 0) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const eventLine = block.split("\n").find((l) => l.startsWith("event:"));
          const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) {
            sep = buffer.indexOf("\n\n");
            continue;
          }
          if (eventLine?.includes("done")) {
            return;
          }
          try {
            const payload = JSON.parse(dataLine.slice(5).trim()) as PipelineEvent;
            yield payload;
          } catch {
            // skip malformed
          }
          sep = buffer.indexOf("\n\n");
        }
      }
    } finally {
      reader.releaseLock();
    }
  },

  // ----- Agentic loop: the brain's "main thinking" (FRIDAY) -----------------
  // POST /api/agent returns SSE. Triage sends a plain question to the 7-step
  // pipeline; a multi-step / tool / "do X" request runs the ReAct loop. Each
  // frame is an AgentEvent (has `type`) or a bare PipelineEvent (has `step`) —
  // discriminate on shape. A confirm-tier action mid-run yields a
  // `confirm-request` AgentEvent and pauses; resume with confirmAgent().
  agent(
    input: {
      prompt: string;
      conversationId?: string;
      confirmMode?: AgentConfirmMode;
      scope?: { allow: ActionRiskTier[] };
      forceLoop?: boolean;
    },
    signal?: AbortSignal,
  ): AsyncGenerator<AgentStreamFrame> {
    return sseStream<AgentStreamFrame>("/api/agent", input, signal);
  },

  // Approve/deny a paused confirm-tier action and resume the loop (continues
  // streaming the same kinds of frames).
  confirmAgent(input: AgentConfirmDecision, signal?: AbortSignal): AsyncGenerator<AgentStreamFrame> {
    return sseStream<AgentStreamFrame>("/api/agent/confirm", input, signal);
  },

  // ----- Spinal cord: the brain↔body conduit (reflex/program/deliberate) -----
  // GET the full status surface (queue, recent commands, reflexes, personas).
  spineState(): Promise<SpineSnapshot> {
    return json<SpineSnapshot>(`/api/spine/state`);
  },
  // POST /api/spine/dispatch (SSE): send ONE descending intent down the cord and
  // stream spine/agent/pipeline frames as it routes (reflex/program/deliberate).
  spineDispatch(
    input: {
      intent: string;
      personaId?: SpinalPersonaId;
      confirmMode?: AgentConfirmMode;
      scope?: { allow: ActionRiskTier[] };
    },
    signal?: AbortSignal,
  ): AsyncGenerator<SpineStreamFrame> {
    return sseStream<SpineStreamFrame>("/api/spine/dispatch", input, signal);
  },

  // The governed speak request. The SERVER applies the speech policy (enabled/
  // mode gate, sanitize, redact secrets, length cap) and returns either Bark
  // audio, governed text for the browser-TTS fallback, or a declined no-op.
  async voiceSpeak(req: {
    text: string;
    kind?: SpeechKind;
    persona?: SpinalPersonaId;
    voice?: string;
  }): Promise<SpeakResponse> {
    return json(`/api/voice/speak`, {
      method: "POST",
      body: JSON.stringify(req),
    });
  },
};

export function brainApiBaseUrl(): string {
  return getBaseUrl();
}
