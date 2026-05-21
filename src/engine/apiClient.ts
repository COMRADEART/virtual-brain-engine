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
import type { PipelineEvent } from "../../shared/pipeline";
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
};

export function brainApiBaseUrl(): string {
  return getBaseUrl();
}
