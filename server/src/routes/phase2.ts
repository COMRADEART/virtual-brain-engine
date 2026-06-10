// Phase 2 cognitive surface for the WEB app. The desktop (Tauri) build serves
// these from the 7 Rust crates (brain-*-engine, see src-tauri/src/phase2.rs);
// apiClient routes every phase2* call to invokeTauri(...) when inTauri(), so this
// router is ONLY the browser fallback.
//
// Endpoints with a genuine Node backing return REAL data:
//   - status counts           -> memory_points / memory_relations
//   - semantic ingest/search  -> upsertMemoryPoint + sqlite-vec vectorSearch
//   - knowledge graph         -> memory_points (nodes) + memory_relations (edges)
//   - context.related_memories-> vector/keyword search
//
// The features that exist only as Rust crates (workflow engine, temporal
// timeline, personality model, autonomous scheduler) return type-correct,
// shaped-but-empty values. That keeps the UI crash-free and honest — it shows
// real numbers where we have them and no fabricated activity where we don't.
// These panes are desktop-only; closing that gap on the web side is Phase 4.

import { Router } from "express";
import { z } from "zod";
import { createHash } from "node:crypto";
import type {
  AutonomousTask,
  ContextSnapshot,
  GraphSnapshotOutput,
  PersonalityState,
  Phase2Status,
  SemanticMemoryRecord,
  SemanticSearchHit,
  SemanticSearchOutput,
  TemporalEvent,
  WorkflowSnapshotOutput,
  WorkflowTask,
} from "../../../shared/phase2.js";
import {
  getMemoryCount,
  getRelationCount,
  keywordSearch,
  listRecentMemories,
  listRelationsAmong,
  upsertMemoryPoint,
  vectorSearch,
  type VectorSearchHit,
} from "../db/repositories/memory.js";
import { getDefaultConnectorInstance } from "../connectors/registry.js";
import { CONFIG } from "../config.js";

export const phase2Router = Router();

const BACKEND = "LocalSqlite" as const;

function nowIso(): string {
  return new Date().toISOString();
}

// A real mood model is a Rust crate (brain-personality-engine); the web fallback
// reports a neutral idle state, labelled so the UI can tell it apart.
function webFallbackMood(): PersonalityState {
  return {
    mood: "idle",
    arousal: 0.3,
    focus: 0.5,
    confidence: 0.5,
    current_project: null,
    activity_label: "web fallback",
    notification: null,
    traits: {},
    updated_at: nowIso(),
  };
}

// Embed via the active connector; null when no embeddings are available
// (chat-only runtime or server offline). Mirrors the pipeline's degrade-don't-fail rule.
async function tryEmbed(text: string): Promise<number[] | null> {
  const connector = getDefaultConnectorInstance();
  if (!connector?.embed) {
    return null;
  }
  try {
    const values = await connector.embed(text);
    return values.length === CONFIG.embeddingDim ? values : null;
  } catch {
    return null;
  }
}

function hitToSemantic(hit: VectorSearchHit): SemanticSearchHit {
  const m = hit.memory;
  return {
    memory_id: m.id,
    score: hit.score,
    content_preview: m.content.slice(0, 200),
    project_name: m.projectName,
    source_path: m.filePath,
    memory_type: m.sourceType,
    reasons: [],
  };
}

// ── Status (REAL counts) ────────────────────────────────────────────────────
phase2Router.get("/phase2/status", (_req, res) => {
  const status: Phase2Status = {
    semantic_memories: getMemoryCount(),
    graph_nodes: getMemoryCount(), // every memory point is a graph node
    graph_edges: getRelationCount(),
    timeline_events: 0,
    pending_workflows: 0,
    autonomous_tasks: 0,
    backend: BACKEND,
    mood: webFallbackMood(),
    generated_at: nowIso(),
  };
  res.json(status);
});

// ── Semantic memory (REAL) ──────────────────────────────────────────────────
const ingestSchema = z.object({
  content: z.string().min(1).max(8000),
  memoryType: z.string().optional(),
  projectName: z.string().optional(),
  sourcePath: z.string().optional(),
  tags: z.array(z.string()).optional(),
  importance: z.number().min(0).max(1).optional(),
});

phase2Router.post("/phase2/semantic/ingest", async (req, res) => {
  const parsed = ingestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const input = parsed.data;
  const embedding = await tryEmbed(input.content);
  const tags = input.tags ?? [];
  const point = upsertMemoryPoint({
    sourceType: "manual",
    filePath: input.sourcePath ?? null,
    projectName: input.projectName ?? null,
    title: input.content.slice(0, 80),
    content: input.content,
    contentHash: createHash("sha1").update(input.content).digest("hex"),
    embedding: embedding ?? undefined,
    importance: input.importance ?? 0.5,
    metadata: { memoryType: input.memoryType ?? "manual", tags },
  });
  const record: SemanticMemoryRecord = {
    id: point.id,
    content: point.content,
    memory_type: input.memoryType ?? "manual",
    project_name: point.projectName,
    source_path: point.filePath,
    tags,
    importance: point.importance,
    created_at: point.createdAt,
    embedding: {
      model: CONFIG.ollamaEmbeddingModel,
      dimensions: embedding?.length ?? 0,
      values: embedding ?? [],
    },
  };
  res.json({ memory: record, graph_nodes_touched: 0 });
});

const searchSchema = z.object({
  query: z.string().min(1).max(2000),
  limit: z.number().int().min(1).max(50).optional(),
  minScore: z.number().min(0).max(1).optional(),
  projectName: z.string().optional(),
  memoryType: z.string().optional(),
});

phase2Router.post("/phase2/semantic/search", async (req, res) => {
  const parsed = searchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { query, limit = 10, minScore = 0, projectName } = parsed.data;
  const embedding = await tryEmbed(query);
  const raw: VectorSearchHit[] = embedding
    ? vectorSearch(embedding, limit, projectName ? { projectName } : undefined)
    : keywordSearch(query, limit);
  const hits = raw.filter((h) => h.score >= minScore).map(hitToSemantic);
  const out: SemanticSearchOutput = {
    hits,
    searched: getMemoryCount(),
    backend: BACKEND,
  };
  res.json(out);
});

// ── Knowledge graph (REAL) ──────────────────────────────────────────────────
phase2Router.post("/phase2/graph", (req, res) => {
  const projectName =
    typeof req.body?.projectName === "string" ? (req.body.projectName as string) : undefined;
  const points = listRecentMemories(60).filter((m) => !projectName || m.projectName === projectName);
  const ids = points.map((m) => m.id);
  const edges = listRelationsAmong(ids);
  const out: GraphSnapshotOutput = {
    nodes: points.map((m) => ({
      id: m.id,
      kind: m.sourceType,
      label: m.title ?? m.content.slice(0, 40),
      project: m.projectName,
      metadata: {},
      updatedAt: m.updatedAt,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      fromId: e.fromId,
      toId: e.toId,
      kind: e.kind,
      weight: e.weight,
      metadata: {},
      updatedAt: e.createdAt,
    })),
  };
  res.json(out);
});

// ── Context (related_memories REAL; intent/summary are Rust-only) ────────────
phase2Router.post("/phase2/context", async (req, res) => {
  const prompt = typeof req.body?.prompt === "string" ? (req.body.prompt as string) : "";
  const projectName =
    typeof req.body?.projectName === "string" ? (req.body.projectName as string) : null;
  let related: ContextSnapshot["related_memories"] = [];
  if (prompt) {
    const embedding = await tryEmbed(prompt);
    const raw = embedding ? vectorSearch(embedding, 5) : keywordSearch(prompt, 5);
    related = raw.map((h) => ({ id: h.memory.id, score: h.score, reason: "semantic match" }));
  }
  const snapshot: ContextSnapshot = {
    id: nowIso(),
    project_path: typeof req.body?.projectPath === "string" ? (req.body.projectPath as string) : null,
    project_name: projectName,
    active_files: Array.isArray(req.body?.activeFiles) ? (req.body.activeFiles as string[]) : [],
    related_memories: related,
    relevant_tools: [],
    likely_intent: "",
    confidence: related.length > 0 ? 0.4 : 0,
    summary: "",
    created_at: nowIso(),
  };
  res.json(snapshot);
});

// ── Desktop-only features: type-correct empty/static web fallbacks ──────────
// Backed by Rust crates in the Tauri build; the browser cannot run a workflow
// engine / temporal store / personality model / scheduler. Shaped-but-empty
// responses keep the UI crash-free without fabricating activity.

phase2Router.post("/phase2/timeline", (_req, res) => {
  res.json([] as TemporalEvent[]);
});

phase2Router.post("/phase2/timeline/record", (req, res) => {
  // Echo a shaped event (id: "" marks it non-persisted) so the caller's
  // optimistic UI has an object; there is no Node temporal store to write to.
  const body = (req.body ?? {}) as Record<string, unknown>;
  const event: TemporalEvent = {
    id: "",
    project_name: typeof body.projectName === "string" ? body.projectName : null,
    kind: (typeof body.kind === "string" ? body.kind : "memory-created") as TemporalEvent["kind"],
    title: typeof body.title === "string" ? body.title : "",
    detail: typeof body.detail === "string" ? body.detail : "",
    related_path: typeof body.relatedPath === "string" ? body.relatedPath : null,
    related_memory_id: typeof body.relatedMemoryId === "string" ? body.relatedMemoryId : null,
    importance: typeof body.importance === "number" ? body.importance : 0.5,
    occurred_at: nowIso(),
  };
  res.json(event);
});

phase2Router.get("/phase2/workflows", (_req, res) => {
  const snapshot: WorkflowSnapshotOutput = { tasks: [], logs: [] };
  res.json(snapshot);
});

function shapedTask(): WorkflowTask {
  return {
    id: "",
    workflow_id: null,
    agent: "",
    action: "",
    priority: 0,
    state: "pending",
    payload: {},
    attempts: 0,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

phase2Router.post("/phase2/workflows/enqueue", (_req, res) => {
  res.json(shapedTask());
});

phase2Router.post("/phase2/workflows/next", (_req, res) => {
  res.json(null);
});

phase2Router.post("/phase2/workflows/complete", (_req, res) => {
  res.json(null);
});

phase2Router.get("/phase2/pet", (_req, res) => {
  res.json(webFallbackMood());
});

phase2Router.post("/phase2/pet/update", (_req, res) => {
  res.json(webFallbackMood());
});

phase2Router.post("/phase2/autonomous/schedule", (_req, res) => {
  const task: AutonomousTask = {
    id: "",
    kind: "",
    title: "",
    schedule: null,
    next_run_at: nowIso(),
    last_run_at: null,
    priority: 0,
    enabled: false,
    payload: {},
  };
  res.json(task);
});

phase2Router.get("/phase2/autonomous/due", (_req, res) => {
  res.json([] as AutonomousTask[]);
});
