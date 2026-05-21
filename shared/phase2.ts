export type Phase2Mood = "focused" | "curious" | "idle" | "excited" | "analyzing" | "assisting";

export interface PersonalityState {
  mood: Phase2Mood;
  arousal: number;
  focus: number;
  confidence: number;
  current_project?: string | null;
  activity_label: string;
  notification?: string | null;
  traits: Record<string, number>;
  updated_at: string;
}

export interface Phase2Status {
  semantic_memories: number;
  graph_nodes: number;
  graph_edges: number;
  timeline_events: number;
  pending_workflows: number;
  autonomous_tasks: number;
  backend: "LocalSqlite" | { Qdrant: { base_url: string; collection: string } };
  mood: PersonalityState;
  generated_at: string;
}

export interface EmbeddingVector {
  model: string;
  dimensions: number;
  values: number[];
}

export interface SemanticMemoryRecord {
  id: string;
  content: string;
  memory_type: string;
  project_name?: string | null;
  source_path?: string | null;
  tags: string[];
  importance: number;
  created_at: string;
  embedding: EmbeddingVector;
}

export interface SemanticSearchHit {
  memory_id: string;
  score: number;
  content_preview: string;
  project_name?: string | null;
  source_path?: string | null;
  memory_type: string;
  reasons: string[];
}

export interface SemanticSearchOutput {
  hits: SemanticSearchHit[];
  searched: number;
  backend: Phase2Status["backend"];
}

export interface GraphNodeDto {
  id: string;
  kind: string;
  label: string;
  project?: string | null;
  metadata: Record<string, unknown>;
  updatedAt: string;
}

export interface GraphEdgeDto {
  id: string;
  fromId: string;
  toId: string;
  kind: string;
  weight: number;
  metadata: Record<string, unknown>;
  updatedAt: string;
}

export interface GraphSnapshotOutput {
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
}

export interface MemoryReference {
  id: string;
  score: number;
  reason: string;
}

export interface ContextSnapshot {
  id: string;
  project_path?: string | null;
  project_name?: string | null;
  active_files: string[];
  related_memories: MemoryReference[];
  relevant_tools: string[];
  likely_intent: string;
  confidence: number;
  summary: string;
  created_at: string;
}

export type TemporalEventKind =
  | "session-started"
  | "session-ended"
  | "file-modified"
  | "summary-created"
  | "memory-created"
  | "workflow-ran"
  | "bug-observed"
  | "commit-created"
  | "milestone-reached";

export interface TemporalEvent {
  id: string;
  project_name?: string | null;
  kind: TemporalEventKind;
  title: string;
  detail: string;
  related_path?: string | null;
  related_memory_id?: string | null;
  importance: number;
  occurred_at: string;
}

export type TaskState = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface WorkflowTask {
  id: string;
  workflow_id?: string | null;
  agent: string;
  action: string;
  priority: number;
  state: TaskState;
  payload: Record<string, unknown>;
  attempts: number;
  created_at: string;
  updated_at: string;
}

export interface WorkflowLogDto {
  id: string;
  taskId: string;
  agent: string;
  event: string;
  detail: string;
  createdAt: string;
}

export interface WorkflowSnapshotOutput {
  tasks: WorkflowTask[];
  logs: WorkflowLogDto[];
}

export interface AutonomousTask {
  id: string;
  kind: string;
  title: string;
  schedule: unknown;
  next_run_at: string;
  last_run_at?: string | null;
  priority: number;
  enabled: boolean;
  payload: Record<string, unknown>;
}
