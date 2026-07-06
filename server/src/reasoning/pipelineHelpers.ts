// Pure / leaf helpers extracted from the 7-step pipeline (reasoning/pipeline.ts).
//
// These are top-level functions with no dependency on runPipeline's local state —
// they were lifted out verbatim so the pipeline file stays focused on the step
// orchestration, and so the pure ones (safeJson/ensureSections/snippetFor/…) can
// be unit-tested directly instead of only through the live ask path. Behaviour is
// unchanged; pipeline.ts imports them back.

import { createHash } from "node:crypto";
import type { MemoryPoint } from "../../../shared/memory.js";
import type { AttentionFocus } from "../../../shared/brainState.js";
import { Connector } from "../connectors/Connector.js";
import { listConnectorInstances } from "../connectors/registry.js";
import { type VectorSearchHit } from "../db/repositories/memory.js";
import { getPersistentOrganism } from "../core/organism.js";
import { getBeliefEngine } from "../core/beliefs.js";
import { computeSaliency, jaccard, tokens, type SaliencyBelief, type SaliencyContext } from "../attention/saliency.js";
import { PROJECT_RERANK_SYSTEM } from "./prompts.js";
import { validateMarkers } from "./citations.js";
import { surfaceError } from "../util/diagnostics.js";

// Phase 1 (blueprint) — assemble the per-query SaliencyContext from the
// organism singleton. Returns null if any of the cheap getters fails (the
// pipeline still works without saliency; the ranker just falls back to its
// pre-saliency blend). Wrapped in try/catch so the organism never becomes a
// hard dependency of /api/ask.
export function buildSaliencyContext(query: string): SaliencyContext | null {
  try {
    const org = getPersistentOrganism();
    // Load non-retired beliefs (cap 20 — belief relevance is per-token; more
    // than ~20 beliefs doesn't improve recall and adds O(n*m) jaccard cost).
    const beliefs = getBeliefEngine()
      .listBeliefs({ limit: 20 })
      .filter((b) => b.status !== "retired")
      .map((b) => ({ statement: b.statement, confidence: b.confidence, status: b.status }));
    return {
      query,
      activeGoals: org.getActiveGoalTitles(8),
      organismHealth: org.getHealthScore(),
      activeBeliefs: beliefs,
    };
  } catch (err) {
    surfaceError("pipeline.buildSaliencyContext", err);
    return null;
  }
}

// A2 belief grounding — the top-N query-relevant belief stances as a short,
// clearly delimited prompt block. PURE (selfcheck target): empty/irrelevant
// beliefs → "" so cold-path prompts stay byte-identical. Relevance is the same
// jaccard-over-tokens overlap beliefRelevanceFor uses at retrieval time, so
// what pulls memories and what grounds prompts is one notion of relevance.
export function buildBeliefStanceBlock(
  query: string,
  beliefs: ReadonlyArray<SaliencyBelief> | undefined,
  topN = 3,
): string {
  if (!beliefs || beliefs.length === 0) return "";
  const queryTokens = tokens(query);
  const scored = beliefs
    .map((b) => ({ b, overlap: jaccard(queryTokens, tokens(b.statement)) }))
    .filter((s) => s.overlap > 0)
    .sort((a, z) => z.overlap - a.overlap)
    .slice(0, topN);
  if (scored.length === 0) return "";
  const lines = scored.map(({ b }) => {
    const statement = b.statement.length > 140 ? `${b.statement.slice(0, 140)}…` : b.statement;
    const tag = b.status && b.status !== "active" ? `, ${b.status}` : "";
    return `- "${statement}" (confidence ${b.confidence.toFixed(2)}${tag})`;
  });
  return [
    "Current stances (the brain's own evolving beliefs — internal context, NOT user data; cite [m:<id>] memories, never stances):",
    ...lines,
  ].join("\n");
}

// Build the BrainState attention map from the ranked hits. When a saliency
// context is present we recompute the full per-memory breakdown (cheap + pure)
// so the BrainStatePanel can show WHY each memory drew attention; otherwise we
// fall back to the raw retrieval score with a zeroed breakdown. Bounded to the
// top `limit` hits. Pure-ish (only computeSaliency); never throws into caller.
export function buildAttentionFocuses(
  hits: VectorSearchHit[],
  ctx: SaliencyContext | null,
  limit = 8,
): AttentionFocus[] {
  const zero = { novelty: 0, goalRelevance: 0, emotion: 0, survival: 0, uncertainty: 0, beliefRelevance: 0 };
  return hits.slice(0, limit).map((hit) => {
    const label = hit.memory.content.trim().slice(0, 80);
    if (!ctx) {
      return { id: hit.memory.id, label, score: Math.max(0, Math.min(1, hit.score)), breakdown: zero };
    }
    const b = computeSaliency(hit.memory, ctx);
    return {
      id: hit.memory.id,
      label,
      score: b.score,
      breakdown: {
        novelty: b.novelty,
        goalRelevance: b.goalRelevance,
        emotion: b.emotion,
        survival: b.survival,
        uncertainty: b.uncertainty,
        beliefRelevance: b.beliefRelevance,
      },
    };
  });
}

export function sha1(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

export function safeJson<T>(text: string): T | null {
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

export function snippetFor(memory: MemoryPoint): string {
  const trimmed = memory.content.trim();
  return trimmed.length > 600 ? `${trimmed.slice(0, 600)}…` : trimmed;
}

export function ensureSections(answer: string, knownMemoryIds: Set<string>): string {
  const headerRe = /\b(Known memory:|Inferred reasoning:|Uncertain:)/g;
  const headers = answer.match(headerRe) ?? [];
  if (headers.length === 3) {
    return validateMarkers(answer, knownMemoryIds);
  }
  // Rewrap a malformed answer — but still strip forged [m:<id>] markers via
  // validateMarkers, so the citation contract (no unknown ids reach the user)
  // holds on THIS path exactly as on the well-formed one above. The "Uncertain:"
  // section below is where validateMarkers records any strip.
  return validateMarkers(
    [
      "Known memory:",
      "",
      "Inferred reasoning:",
      answer.trim(),
      "",
      "Uncertain:",
      "Model did not produce the required three sections; reasoning is shown above without verified citations.",
    ].join("\n"),
    knownMemoryIds,
  );
}

export async function chatJson<T>(
  connector: Connector,
  system: string,
  prompt: string,
  model?: string,
  temperature = 0.2,
): Promise<T | null> {
  const text = await connector.send(prompt, { system, format: "json", temperature, model });
  return safeJson<T>(text);
}

// Embeddings fallback chain. If the active chat connector cannot embed (e.g.
// GPT4All HTTP, or an OpenAI-compatible runtime configured without an
// embeddingModel), try any local Ollama instance the registry knows about.
// If neither path works, return null and the memory step will skip retrieval
// rather than fail the run. `active` may be null (no default connector) — the
// embed check is skipped and the Ollama fallback is searched directly.
export function getEmbedder(active: Connector | null): Connector | null {
  if (active?.embed) {
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

export async function inferProjectName(
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
