import type {
  LogicalRegionId,
  PipelineEvent,
  PipelineStatus,
  PipelineStepId,
} from "../../../shared/pipeline.js";
import type { MemoryPoint } from "../../../shared/memory.js";
import {
  insertRelation,
  upsertMemoryPoint,
  vectorSearch,
  type VectorSearchHit,
} from "../db/repositories/memory.js";
import {
  completePipelineRun,
  createPipelineRun,
  ensureConversation,
  failPipelineRun,
  insertMessage,
} from "../db/repositories/conversations.js";
import { getDefaultConnectorInstance, listConnectorInstances } from "../connectors/registry.js";
import { Connector, ConnectorError } from "../connectors/Connector.js";
import { broadcast } from "../ws/brainBus.js";
import {
  ERROR_SYSTEM,
  PROJECT_RERANK_SYSTEM,
  REASONING_SYSTEM,
  buildResponseSystem,
} from "./prompts.js";
import { createHash } from "node:crypto";

export interface AskRequest {
  prompt: string;
  conversationId?: string;
}

export type EmitFn = (event: PipelineEvent) => void;

const STEP_REGIONS: Record<PipelineStepId, LogicalRegionId[]> = {
  input: ["model-hub"],
  memory: ["memory-core", "file-memory"],
  reasoning: ["reasoning-cortex"],
  project: ["project-cortex"],
  error: ["error-detection-center"],
  response: ["response-center"],
  learning: ["learning-feedback-center"],
};

function sha1(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

function makeEvent(
  conversationId: string,
  runId: string,
  step: PipelineStepId,
  status: PipelineStatus,
  extra: Partial<PipelineEvent> = {},
): PipelineEvent {
  return {
    conversationId,
    runId,
    step,
    status,
    logicalRegions: STEP_REGIONS[step],
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

function emitAll(event: PipelineEvent, emit: EmitFn): void {
  emit(event);
  broadcast({ type: "pipeline", ...event });
}

function safeJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    // Try to recover by extracting the first {...} block.
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function snippetFor(memory: MemoryPoint): string {
  const trimmed = memory.content.trim();
  return trimmed.length > 600 ? `${trimmed.slice(0, 600)}…` : trimmed;
}

// Re-rank vector hits with a recency / importance bias. Pure local arithmetic.
function applyBoosts(hits: VectorSearchHit[]): VectorSearchHit[] {
  const now = Date.now();
  return [...hits]
    .map((hit) => {
      const ageDays = Math.max(0, (now - new Date(hit.memory.updatedAt).getTime()) / 86400000);
      const recency = 1 / (1 + ageDays / 14); // ~14d half-life
      const score = hit.score * 0.7 + recency * 0.15 + hit.memory.importance * 0.15;
      return { ...hit, score };
    })
    .sort((a, b) => b.score - a.score);
}

function ensureSections(answer: string, knownMemoryIds: Set<string>): string {
  const headerRe = /\b(Known memory:|Inferred reasoning:|Uncertain:)/g;
  const headers = answer.match(headerRe) ?? [];
  if (headers.length === 3) {
    return validateMarkers(answer, knownMemoryIds);
  }
  // Rewrap a malformed answer.
  return [
    "Known memory:",
    "",
    "Inferred reasoning:",
    answer.trim(),
    "",
    "Uncertain:",
    "Model did not produce the required three sections; reasoning is shown above without verified citations.",
  ].join("\n");
}

function validateMarkers(answer: string, knownIds: Set<string>): string {
  const markers = Array.from(answer.matchAll(/\[m:([A-Za-z0-9]+)\]/g)).map((m) => m[1]);
  const unknown = markers.filter((id) => !knownIds.has(id));
  if (unknown.length === 0) {
    return answer;
  }
  let cleaned = answer;
  for (const id of unknown) {
    cleaned = cleaned.split(`[m:${id}]`).join("");
  }
  // Append a note in the Uncertain section.
  const note = `Stripped ${unknown.length} unknown memory marker(s) from the model output.`;
  return cleaned.replace(/(Uncertain:\s*)/, `$1${note} `);
}

async function chatJson<T>(
  connector: Connector,
  system: string,
  prompt: string,
): Promise<T | null> {
  const text = await connector.send(prompt, { system, format: "json", temperature: 0.2 });
  return safeJson<T>(text);
}

// Embeddings fallback chain. If the active chat connector cannot embed (e.g.
// GPT4All HTTP, or an OpenAI-compatible runtime configured without an
// embeddingModel), try any local Ollama instance the registry knows about.
// If neither path works, return null and the memory step will skip retrieval
// rather than fail the run.
function getEmbedder(active: Connector): Connector | null {
  if (active.embed) {
    return active;
  }
  const ollama = listConnectorInstances().find(
    (c) =>
      c.descriptor.kind === "ollama" &&
      c.descriptor.enabled &&
      c.descriptor.state === "ok" &&
      c.descriptor.isLocal &&
      Boolean(c.embed),
  );
  return ollama ?? null;
}

async function inferProjectName(
  connector: Connector,
  prompt: string,
  hits: VectorSearchHit[],
): Promise<string | null> {
  const candidates = Array.from(
    new Set(hits.map((h) => h.memory.projectName).filter((p): p is string => Boolean(p))),
  );
  if (candidates.length === 0) {
    return null;
  }
  try {
    const result = await chatJson<{ projectName: string | null }>(
      connector,
      PROJECT_RERANK_SYSTEM,
      `Question: ${prompt}\nCandidates: ${JSON.stringify(candidates)}`,
    );
    return result?.projectName ?? null;
  } catch {
    return null;
  }
}

export async function runPipeline(req: AskRequest, emit: EmitFn): Promise<void> {
  const connector = getDefaultConnectorInstance();
  const conversation = ensureConversation(req.conversationId, req.prompt);
  const run = createPipelineRun({ conversationId: conversation.id, prompt: req.prompt });
  const runId = run.id;
  const cid = conversation.id;

  if (!connector) {
    emitAll(makeEvent(cid, runId, "input", "error", { detail: "No default connector configured" }), emit);
    failPipelineRun(runId, "no connector");
    return;
  }

  // 1. INPUT
  emitAll(makeEvent(cid, runId, "input", "start", { detail: "Validating prompt" }), emit);
  if (req.prompt.trim().length === 0) {
    emitAll(makeEvent(cid, runId, "input", "error", { detail: "Empty prompt" }), emit);
    failPipelineRun(runId, "empty prompt");
    return;
  }
  insertMessage({ conversationId: cid, role: "user", content: req.prompt, pipelineRunId: runId });
  emitAll(makeEvent(cid, runId, "input", "complete"), emit);

  // 2. MEMORY
  emitAll(makeEvent(cid, runId, "memory", "start", { detail: "Embedding question + searching memory" }), emit);
  let memoryHits: VectorSearchHit[] = [];
  let memoryError: string | undefined;
  const embedder = getEmbedder(connector);
  if (embedder?.embed) {
    try {
      const embedding = await embedder.embed(req.prompt);
      const raw = vectorSearch(embedding, 8);
      memoryHits = applyBoosts(raw);
    } catch (err) {
      memoryError = err instanceof Error ? err.message : String(err);
    }
  } else {
    // No connector can embed -- retrieval is skipped. The pipeline continues
    // and the response step will run without citations.
    memoryError = "No embeddings-capable runtime available — memory retrieval skipped";
  }
  const citations = memoryHits.map((hit) => ({
    memoryId: hit.memory.id,
    filePath: hit.memory.filePath ?? undefined,
    score: hit.score,
  }));
  const memoryDetail = memoryError
    ? memoryError
    : embedder && embedder !== connector
      ? `${memoryHits.length} memories retrieved (embeddings via ${embedder.descriptor.id})`
      : `${memoryHits.length} memories retrieved`;
  emitAll(
    makeEvent(cid, runId, "memory", "complete", {
      detail: memoryDetail,
      citations,
    }),
    emit,
  );

  // 3. REASONING
  emitAll(makeEvent(cid, runId, "reasoning", "start"), emit);
  const memoryList = memoryHits
    .map((hit) => `[m:${hit.memory.id}] (${hit.memory.filePath ?? "conv"}): ${snippetFor(hit.memory)}`)
    .join("\n\n");
  type ReasoningOut = { plan: string; openQuestions: string[] };
  let reasoning: ReasoningOut = { plan: "", openQuestions: [] };
  try {
    const parsed = await chatJson<ReasoningOut>(
      connector,
      REASONING_SYSTEM,
      `Question:\n${req.prompt}\n\nMemory snippets:\n${memoryList || "(empty)"}`,
    );
    if (parsed) {
      reasoning = {
        plan: parsed.plan ?? "",
        openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions : [],
      };
    }
  } catch (err) {
    emitAll(
      makeEvent(cid, runId, "reasoning", "error", {
        detail: err instanceof Error ? err.message : String(err),
      }),
      emit,
    );
    failPipelineRun(runId, "reasoning failed");
    return;
  }
  emitAll(
    makeEvent(cid, runId, "reasoning", "complete", { detail: reasoning.plan.slice(0, 200) }),
    emit,
  );

  // 4. PROJECT
  emitAll(makeEvent(cid, runId, "project", "start"), emit);
  let projectName: string | null = null;
  if (memoryHits.length > 0) {
    projectName = await inferProjectName(connector, req.prompt, memoryHits);
    if (projectName) {
      memoryHits = memoryHits
        .map((hit) => ({
          ...hit,
          score: hit.score * (hit.memory.projectName === projectName ? 1.4 : 0.8),
        }))
        .sort((a, b) => b.score - a.score);
    }
  }
  emitAll(
    makeEvent(cid, runId, "project", "complete", {
      detail: projectName ? `Re-ranked by project ${projectName}` : "No project re-rank",
    }),
    emit,
  );

  // 5. ERROR
  emitAll(makeEvent(cid, runId, "error", "start"), emit);
  type ErrorOut = { contradictions: string[]; missing: string[]; confidence: number };
  let errorReport: ErrorOut = { contradictions: [], missing: [], confidence: memoryHits.length > 0 ? 0.6 : 0.2 };
  try {
    const parsed = await chatJson<ErrorOut>(
      connector,
      ERROR_SYSTEM,
      `Question:\n${req.prompt}\n\nReasoning:\n${reasoning.plan}\n\nMemory:\n${memoryList || "(empty)"}`,
    );
    if (parsed) {
      errorReport = {
        contradictions: Array.isArray(parsed.contradictions) ? parsed.contradictions : [],
        missing: Array.isArray(parsed.missing) ? parsed.missing : [],
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : errorReport.confidence,
      };
    }
  } catch {
    // Soft-fail: error step is advisory.
  }
  emitAll(
    makeEvent(cid, runId, "error", "complete", {
      detail: `confidence ${errorReport.confidence.toFixed(2)}, ${errorReport.contradictions.length} contradictions`,
    }),
    emit,
  );

  // 6. RESPONSE
  emitAll(makeEvent(cid, runId, "response", "start"), emit);
  const knownIds = new Set(memoryHits.map((hit) => hit.memory.id));
  const responseSystem = buildResponseSystem(memoryHits.length > 0);
  const responsePrompt = [
    `User question:\n${req.prompt}`,
    `Memory snippets you may cite as [m:<id>] (do not invent new ids):`,
    memoryList || "(empty)",
    `Reasoning plan:\n${reasoning.plan}`,
    errorReport.contradictions.length > 0
      ? `Known contradictions:\n${errorReport.contradictions.join("\n")}`
      : "",
    errorReport.missing.length > 0
      ? `Missing data:\n${errorReport.missing.join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  let assembled = "";
  try {
    for await (const token of connector.stream(responsePrompt, {
      system: responseSystem,
      temperature: 0.3,
    })) {
      assembled += token;
      emitAll(makeEvent(cid, runId, "response", "progress", { tokensDelta: token }), emit);
    }
  } catch (err) {
    const message =
      err instanceof ConnectorError ? err.message : err instanceof Error ? err.message : String(err);
    emitAll(makeEvent(cid, runId, "response", "error", { detail: message }), emit);
    failPipelineRun(runId, message);
    return;
  }
  const finalAnswer = ensureSections(assembled.trim(), knownIds);
  emitAll(
    makeEvent(cid, runId, "response", "complete", { detail: `${finalAnswer.length} chars` }),
    emit,
  );

  // 7. LEARNING
  emitAll(makeEvent(cid, runId, "learning", "start"), emit);
  insertMessage({
    conversationId: cid,
    role: "assistant",
    content: finalAnswer,
    pipelineRunId: runId,
  });
  try {
    const learned = upsertMemoryPoint({
      sourceType: "conversation",
      filePath: null,
      projectName: projectName ?? "(conversation)",
      title: req.prompt.slice(0, 80),
      content: `Q: ${req.prompt}\nA: ${finalAnswer}`,
      contentHash: sha1(`${req.prompt}|${finalAnswer}`),
      importance: errorReport.confidence,
      metadata: { conversationId: cid, runId },
    });
    for (const hit of memoryHits.slice(0, 5)) {
      try {
        insertRelation(learned.id, hit.memory.id, "cites", hit.score);
      } catch {
        // ignore relation failures
      }
    }
  } catch (err) {
    // Learning is best-effort; surface but don't fail the run.
    console.warn("[pipeline] learning persistence failed:", err);
  }
  completePipelineRun(runId, finalAnswer);
  emitAll(
    makeEvent(cid, runId, "learning", "complete", {
      detail: "Stored conversation memory",
      finalAnswer,
    }),
    emit,
  );
}
