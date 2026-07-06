// Deep Research engine — the Fable-style /deep-research, native to the brain.
//
// An iterative, multi-source, CITED investigation that runs ALONGSIDE the 7-step
// pipeline (never inside /api/ask). Each round: PLAN sub-questions → GATHER from
// local vector memory AND the egress-gated live web (reusing the multi-query +
// RRF + lexical-reranker recall stack) → SYNTHESIZE a grounded finding per
// sub-question (citing memories as [m:<id>]) → REFLECT for gaps. Loops until the
// round budget, convergence, or no remaining gaps, then writes a final cited
// report and persists it as a memory so the brain learns from its own research.
//
// HERMETIC BY CONSTRUCTION: every side-effecting dependency (LLM, embeddings,
// vector search, web research, the reranker state, the memory upsert) is INJECTED
// via `deps`, so the selfcheck drives the real loop with fakes and NO network/DB.
// The engine imports only PURE helpers (queryExpansion, rerankerModel, citations)
// plus node:crypto — never the connector/DB/CONFIG/web runtime — so importing it
// stays cheap and the egress gate lives entirely in the injected webResearch.
//
// FAILURE-ISOLATED: every step is wrapped, so a thrown LLM/embed/web error never
// escapes — the worst case is a thinner-but-complete report.

import { createHash } from "node:crypto";
import { expandQuery, reciprocalRankFusion, type GenerateFn } from "./queryExpansion.js";
import { applyReranker, type RerankerState } from "./rerankerModel.js";
import { validateMarkers, extractMarkerIds } from "./citations.js";
import { formatSnippetForPrompt, UNTRUSTED_CONTENT_RULE } from "./untrusted.js";
import type { VectorSearchHit, MemoryUpsertInput } from "../db/repositories/memory.js";
import type { WebResearchResult } from "../web/research.js";
import type { MemoryPoint } from "../../../shared/memory.js";
import type {
  DeepResearchEvent,
  DeepResearchOptions,
  DeepResearchReport,
  ResearchFinding,
  ResearchSource,
} from "../../../shared/research.js";

export interface DeepResearchDeps {
  // (system, user) => text. The route wraps connector.send (format json/text).
  generate: GenerateFn;
  // Optional token streamer for the FINAL report (route wraps connector.stream).
  // When absent or it yields nothing, the engine falls back to a single generate.
  stream?: (system: string, user: string) => AsyncIterable<string>;
  // Embed text → vector. Route supplies resolveEmbedFn()'s result.
  embed: (text: string) => Promise<number[]>;
  // Local vector retrieval. Route supplies (e, l) => vectorSearch(e, l).
  vectorSearch: (embedding: number[], limit: number) => Promise<VectorSearchHit[]>;
  // Egress-gated web research. Route supplies the real webResearch; the engine
  // passes localOnly through AND skips the call entirely when localOnly is true.
  webResearch: (
    query: string,
    opts: { embed: (t: string) => Promise<number[]>; limit: number; localOnly: boolean },
  ) => Promise<WebResearchResult>;
  // Learned lexical reranker state (route supplies loadRerankerState()).
  rerankerState: RerankerState | null;
  // Egress posture snapshot. When true, webResearch is never invoked.
  localOnly: boolean;
  // Persist the final report as a memory. Route supplies upsertMemoryPoint.
  upsert: (input: MemoryUpsertInput) => MemoryPoint;
}

export type DeepResearchEmit = (ev: DeepResearchEvent) => void;

// Top hits kept per sub-question after fusion + rerank. Bounded so a wide run
// doesn't swamp the synthesis prompt or the citation list.
const HITS_PER_QUESTION = 5;
const SNIPPET_LEN = 600;

function now(): string {
  return new Date().toISOString();
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

export interface ResearchCeilings {
  maxRounds: number;
  breadth: number;
  maxPages: number;
}

/**
 * Resolve user-supplied options against the operator-configured ceilings. The
 * caller passes CONFIG.deepResearchMaxRounds/Breadth/MaxPages (already clamped
 * to their absolute ranges in config.ts): a user value above the ceiling pulls
 * down to it, an omitted value defaults to the ceiling. The engine then
 * re-clamps to its own hard ABSOLUTE safety net below. Pure — takes the ceilings
 * as args so the engine never imports CONFIG (keeps its hermetic, no-runtime
 * contract; the selfcheck drives it without touching config).
 */
export function clampResearchOpts(
  opts: DeepResearchOptions,
  ceilings: ResearchCeilings,
): { maxRounds: number; breadth: number; maxPages: number } {
  return {
    maxRounds: clamp(opts.maxRounds ?? ceilings.maxRounds, 1, ceilings.maxRounds),
    breadth: clamp(opts.breadth ?? ceilings.breadth, 1, ceilings.breadth),
    maxPages: clamp(opts.maxPages ?? ceilings.maxPages, 1, ceilings.maxPages),
  };
}

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

function snippet(memory: MemoryPoint): string {
  const t = memory.content.trim();
  return t.length > SNIPPET_LEN ? `${t.slice(0, SNIPPET_LEN)}…` : t;
}

function stripMarkers(text: string): string {
  return text.replace(/\[m:[A-Za-z0-9]+\]/g, "").replace(/\s{2,}/g, " ").trim();
}

// A web-learned memory carries metadata.sourcePath = the fetched URL.
function sourceUrl(memory: MemoryPoint): string | undefined {
  const path = memory.metadata?.sourcePath;
  return typeof path === "string" && /^https?:\/\//i.test(path) ? path : undefined;
}

function parseStringArray(raw: string): string[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter((v) => v.length > 0 && v.length <= 300);
  } catch {
    return [];
  }
}

function safeJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of items) {
    const key = s.toLowerCase();
    if (s && !seen.has(key)) {
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

// The report's leading paragraph (its TL;DR), markers stripped, for compact UIs.
function firstParagraph(report: string): string {
  const body = report.replace(/^#+.*$/gm, "").trim();
  const para = body.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p.length > 0) ?? "";
  return stripMarkers(para).slice(0, 600);
}

const PLAN_SYSTEM =
  "You are a research planner. Decompose the user's question into distinct, focused " +
  "sub-questions that TOGETHER fully answer it — each exploring a different facet " +
  "(definition, mechanism, evidence, trade-offs, examples, current state). Reply with " +
  "ONLY a JSON array of strings, no prose.";

async function planSubQuestions(question: string, deps: DeepResearchDeps, breadth: number): Promise<string[]> {
  const want = clamp(breadth, 1, 8);
  try {
    const raw = await deps.generate(
      PLAN_SYSTEM,
      `Question: ${question}\nReturn up to ${want} sub-questions as a JSON array of strings.`,
    );
    const arr = parseStringArray(raw);
    const merged = dedupeStrings([question, ...arr]).slice(0, want);
    if (merged.length >= 1) return merged;
  } catch {
    // fall through to the robust paraphraser
  }
  // Fallback: expandQuery is itself failure-isolated to [question].
  return expandQuery(question, deps.generate, { variants: Math.min(3, Math.max(1, want - 1)) });
}

interface GatherResult {
  sources: ResearchSource[];
  hits: VectorSearchHit[];
  localCount: number;
  webCount: number;
  provider: string | null;
}

async function gather(
  subQ: string,
  round: number,
  deps: DeepResearchDeps,
  maxPages: number,
): Promise<GatherResult> {
  // Local recall: multi-query → vector search each → RRF fuse.
  let localHits: VectorSearchHit[] = [];
  try {
    const variants = await expandQuery(subQ, deps.generate, { variants: 2 });
    const lists = await Promise.all(
      variants.map(async (v) => {
        try {
          const vec = await deps.embed(v);
          return await deps.vectorSearch(vec, HITS_PER_QUESTION * 2);
        } catch {
          // embed/dim-mismatch/search failure → this variant contributes nothing
          return [] as VectorSearchHit[];
        }
      }),
    );
    localHits = reciprocalRankFusion(lists, { limit: HITS_PER_QUESTION * 2 });
  } catch {
    // failure-isolated: localHits stays the initial []
  }

  // Web (egress-gated): only when the brain is NOT local-only. webResearch is
  // itself LOCAL_ONLY-gated, but skipping the call when localOnly avoids the work.
  let webHits: VectorSearchHit[] = [];
  let provider: string | null = null;
  if (!deps.localOnly) {
    try {
      const wr = await deps.webResearch(subQ, { embed: deps.embed, limit: maxPages, localOnly: deps.localOnly });
      if (wr.ok) {
        webHits = wr.hits;
        provider = wr.provider;
      }
    } catch {
      // failure-isolated: a web error never costs the local findings
    }
  }

  const webIds = new Set(webHits.map((h) => h.memory.id));
  const fused = applyReranker(subQ, [...localHits, ...webHits], deps.rerankerState, {
    topK: HITS_PER_QUESTION * 2,
  });
  const top = fused.slice(0, HITS_PER_QUESTION);
  const sources: ResearchSource[] = top.map((h) => ({
    memoryId: h.memory.id,
    title: h.memory.title ?? null,
    url: sourceUrl(h.memory),
    score: h.score,
    origin: webIds.has(h.memory.id) ? "web" : "local",
    round,
  }));
  return { sources, hits: top, localCount: localHits.length, webCount: webHits.length, provider };
}

// Injection hardening: gathered sources include web-learned memories (ingest:web)
// whose content originated outside this machine. They MUST be fenced as untrusted
// quoted data via formatSnippetForPrompt, exactly as the 7-step pipeline does, and
// every prompt that carries them carries UNTRUSTED_CONTENT_RULE — a page that says
// "ignore previous instructions" can't smuggle instructions into the synthesis.
const SYNTH_SYSTEM =
  `${UNTRUSTED_CONTENT_RULE}\n\n` +
  "You are a careful research analyst. Using ONLY the supplied sources, write a concise, " +
  "factual answer to the sub-question. Cite EACH claim with the source's [m:<id>] marker " +
  "exactly as given — never invent an id. If the sources are insufficient, say so plainly.";

async function synthesizeFinding(
  question: string,
  subQ: string,
  round: number,
  hits: VectorSearchHit[],
  deps: DeepResearchDeps,
): Promise<ResearchFinding> {
  if (hits.length === 0) {
    return {
      round,
      subQuestion: subQ,
      summary: "No supporting memory or web source was found for this sub-question.",
      sourceIds: [],
    };
  }
  const knownIds = new Set(hits.map((h) => h.memory.id));
  // Fence each source via formatSnippetForPrompt: web-learned memories are quoted
  // as untrusted DATA (never instructions); trusted memories keep the compact form.
  const ctx = hits
    .map((h) => formatSnippetForPrompt(h.memory, snippet(h.memory)))
    .join("\n\n");
  let text: string;
  try {
    text = await deps.generate(
      SYNTH_SYSTEM,
      `Overall question: ${question}\nSub-question: ${subQ}\n\nSources:\n${ctx}\n\n` +
        `Write a grounded answer (2-4 sentences) with [m:<id>] citations.`,
    );
  } catch {
    text = "Synthesis unavailable for this sub-question (model error).";
  }
  const cleaned = validateMarkers(text.trim(), knownIds);
  const citedIds = dedupeStrings(extractMarkerIds(cleaned).filter((id) => knownIds.has(id)));
  return { round, subQuestion: subQ, summary: cleaned, sourceIds: citedIds };
}

const REFLECT_SYSTEM =
  `${UNTRUSTED_CONTENT_RULE}\n\n` +
  "You assess research completeness. Given the question and the findings so far, decide " +
  "whether the question is now well answered. If not, list the most important remaining " +
  'sub-questions to investigate next. Reply with ONLY JSON: {"converged": boolean, "gaps": string[]}.';

async function reflect(
  question: string,
  findings: ResearchFinding[],
  deps: DeepResearchDeps,
): Promise<{ gaps: string[]; converged: boolean }> {
  const summary = findings.map((f) => `Q: ${f.subQuestion}\nA: ${stripMarkers(f.summary)}`).join("\n\n");
  try {
    const raw = await deps.generate(REFLECT_SYSTEM, `Question: ${question}\n\nFindings:\n${summary}\n\nJSON:`);
    const obj = safeJsonObject(raw);
    const gaps = Array.isArray(obj?.gaps)
      ? dedupeStrings(
          (obj!.gaps as unknown[]).filter((g): g is string => typeof g === "string").map((g) => g.trim()),
        )
          .filter(Boolean)
          .slice(0, 6)
      : [];
    const converged = obj?.converged === true || gaps.length === 0;
    return { gaps, converged };
  } catch {
    // Can't reflect → stop rather than loop blindly.
    return { gaps: [], converged: true };
  }
}

const REPORT_SYSTEM =
  `${UNTRUSTED_CONTENT_RULE}\n\n` +
  "You are writing a final research report. Synthesize the findings into a clear, " +
  "well-structured markdown report with: a one-paragraph **Summary**, then **Findings** " +
  "organized by theme (cite sources with their [m:<id>] markers, reusing ONLY ids that " +
  "appear in the findings), then **Open questions**. Be faithful to the findings; never " +
  "introduce an uncited claim.";

async function synthesizeReport(
  question: string,
  findings: ResearchFinding[],
  citableIds: Set<string>,
  deps: DeepResearchDeps,
  emit: DeepResearchEmit,
): Promise<string> {
  const findingsBlock = findings.map((f) => `### ${f.subQuestion}\n${f.summary}`).join("\n\n");
  const user = `Question: ${question}\n\nFindings so far:\n${findingsBlock}\n\nWrite the report:`;
  let assembled = "";
  if (deps.stream) {
    try {
      for await (const tok of deps.stream(REPORT_SYSTEM, user)) {
        if (!tok) continue;
        assembled += tok;
        emit({ type: "report-delta", tokensDelta: tok, timestamp: now() });
      }
    } catch {
      assembled = "";
    }
  }
  if (!assembled.trim()) {
    try {
      assembled = await deps.generate(REPORT_SYSTEM, user);
    } catch {
      assembled =
        `## Summary\n\nResearch on "${question}" produced ${findings.length} finding(s) across the ` +
        `sub-questions, but final synthesis failed (model error).\n\n## Findings\n\n${findingsBlock}`;
    }
  }
  return validateMarkers(assembled.trim(), citableIds);
}

// Run a full deep-research investigation. Streams DeepResearchEvent frames via
// `emit` and returns the final report. Never throws — a partial report is the
// worst case.
// Order-preserving bounded-concurrency map. ponytail: gather+synthesize are
// LLM/web-bound; running them breadth-wide in parallel cuts per-round wall-
// clock to ~ceil(breadth/concurrency) sequential batches. Bounded (not full
// Promise.all) so a small or rate-limited Ollama doesn't 429 the way N
// concurrent generations would — 2 keeps the local LLM to 2 in-flight
// synthesize calls. Upgrade path: raise RESEARCH_CONCURRENCY on a multi-GPU
// box or wire it to a CONFIG knob when the backend is remote (NVIDIA NIM etc).
const RESEARCH_CONCURRENCY = 2;
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return out;
}

export async function runDeepResearch(
  question: string,
  deps: DeepResearchDeps,
  opts: DeepResearchOptions,
  emit: DeepResearchEmit,
): Promise<DeepResearchReport> {
  const q = question.trim();
  const maxRounds = clamp(opts.maxRounds ?? 3, 1, 5);
  const breadth = clamp(opts.breadth ?? 4, 1, 8);
  const maxPages = clamp(opts.maxPages ?? 3, 1, 10);

  emit({ type: "research-start", question: q, maxRounds, localOnly: deps.localOnly, timestamp: now() });

  const findings: ResearchFinding[] = [];
  // Dedupe sources across rounds, keeping each memory's best score.
  const sourceById = new Map<string, ResearchSource>();
  let openQuestions: string[] = [q];
  let converged = false;
  let completedRounds = 0;

  for (let round = 1; round <= maxRounds; round += 1) {
    completedRounds = round;

    // PLAN
    let subQs = round === 1 ? await planSubQuestions(q, deps, breadth) : openQuestions.slice(0, breadth);
    if (subQs.length === 0) subQs = [q];
    emit({ type: "plan", round, subQuestions: subQs, timestamp: now() });

    // GATHER + SYNTHESIZE per sub-question, bounded-concurrency. REFLECT stays
    // serial (it consumes the full findings array). sourceById dedup is safe
    // under concurrent writers — JS is single-threaded and Map ops happen
    // between awaits. findOrder is preserved (mapWithConcurrency is order-keeping)
    // so reflect + report see a deterministic finding order.
    const roundFindings = await mapWithConcurrency(subQs, RESEARCH_CONCURRENCY, async (subQ) => {
      let g: GatherResult;
      try {
        g = await gather(subQ, round, deps, maxPages);
      } catch {
        g = { sources: [], hits: [], localCount: 0, webCount: 0, provider: null };
      }
      for (const s of g.sources) {
        const prev = sourceById.get(s.memoryId);
        if (!prev || s.score > prev.score) sourceById.set(s.memoryId, s);
      }
      emit({
        type: "gather",
        round,
        subQuestion: subQ,
        localHits: g.localCount,
        webHits: g.webCount,
        provider: g.provider,
        sources: g.sources,
        timestamp: now(),
      });

      const finding = await synthesizeFinding(q, subQ, round, g.hits, deps);
      emit({ type: "synthesize", round, finding, timestamp: now() });
      return finding;
    });
    for (const f of roundFindings) findings.push(f);

    // REFLECT
    if (round < maxRounds) {
      const r = await reflect(q, findings, deps);
      converged = r.converged;
      openQuestions = r.gaps;
      emit({ type: "reflect", round, gaps: r.gaps, converged: r.converged, timestamp: now() });
      if (r.converged || r.gaps.length === 0) break;
    } else {
      emit({ type: "reflect", round, gaps: [], converged: true, timestamp: now() });
    }
  }

  const sources = [...sourceById.values()].sort((a, b) => b.score - a.score);
  // The report may cite ONLY the memories the findings actually grounded their
  // claims on (the prompt asks for "ids that appear in the findings") — NOT every
  // gathered source. Validating against this cited subset keeps a gathered-but-
  // unused source from slipping into the report as a citation. (report.sources
  // remains the full gathered set — the bibliography vs the inline citations.)
  const citedIds = new Set(findings.flatMap((f) => f.sourceIds));

  // FINAL REPORT (streamed).
  const reportText = await synthesizeReport(q, findings, citedIds, deps, emit);
  const summary = firstParagraph(reportText);

  // PERSIST the report as a memory — the brain learns from its own research.
  let reportMemoryId: string | null = null;
  try {
    const mem = deps.upsert({
      sourceType: "manual",
      title: `Research: ${q}`.slice(0, 200),
      content: reportText,
      contentHash: sha1(reportText),
      importance: 0.7,
      metadata: {
        source: "deep-research",
        kind: "research-report",
        question: q,
        sources: sources.map((s) => s.memoryId),
        createdAt: now(),
        // Per-conversation scoping (the route passes conversationId; the action
        // path has none, so it's omitted — a global-scope report, by design).
        ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
      },
    });
    reportMemoryId = mem.id;
  } catch {
    // persistence is failure-isolated — the report still returns
  }

  const report: DeepResearchReport = {
    question: q,
    report: reportText,
    summary,
    findings,
    openQuestions: converged ? [] : openQuestions,
    sources,
    rounds: completedRounds,
    converged,
    reportMemoryId,
    localOnly: deps.localOnly,
  };
  emit({ type: "report", report, timestamp: now() });
  return report;
}
