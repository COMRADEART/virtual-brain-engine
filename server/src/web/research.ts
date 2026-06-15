// web/research.ts — the "local + internet side by side" orchestrator. It turns a
// query into fresh, citeable memory: search the web → fetch the top results →
// run them through the SAME governed ingest as every other source (redact →
// dedup → importance → persist), embedding them so they join the vector index →
// hand the new memories back as fusable retrieval hits.
//
// Two guarantees inherited wholesale from the layers below:
//   * EGRESS — webSearch() and fetchAndIngestUrl() each enforce the LOCAL_ONLY
//     gate independently, so nothing here leaks under the default posture.
//   * GOVERNANCE — fetched pages go through ingestExplicitEmbedded, so a secret
//     in a page is redacted before storage/embedding exactly like any ingest.
//
// It NEVER throws: any failure (blocked, offline, no results, parse error) is
// returned as { ok:false, reason } so the pipeline's local answer is untouched.

import { CONFIG } from "../config.js";
import { ingestFetchedPage } from "../ingest/index.js";
import { fetchUrlText } from "../ingest/webFetch.js";
import { webSearch, type WebSearchProvider, type WebSearchResult } from "./search.js";
import type { VectorSearchHit } from "../db/repositories/memory.js";
import { surfaceError } from "../util/diagnostics.js";

export interface WebResearchOptions {
  fetchImpl?: typeof fetch;
  localOnly?: boolean;
  provider?: string;
  // How many search results to fetch + ingest. Defaults to webResearchMaxPages.
  limit?: number;
  // When supplied, fetched pages are embedded → vector-retrievable forever.
  embed?: (text: string) => Promise<number[]>;
  searxngUrl?: string;
  braveKey?: string;
  tavilyKey?: string;
  exaKey?: string;
  perPageMaxBytes?: number;
}

export interface WebResearchResult {
  ok: boolean;
  provider: WebSearchProvider | null;
  query: string;
  // Raw search hits (title/url/snippet) — useful for the web-search action UI.
  results: WebSearchResult[];
  // The newly-persisted web memories, shaped as retrieval hits so the pipeline
  // can fuse them with local memory and cite them as [m:<id>].
  hits: VectorSearchHit[];
  ingested: number;
  deduped: number;
  reason?: string;
}

// Master switch for the pipeline's automatic local+web fusion. Off whenever the
// brain is local-only (the default), the hybrid switch is off, or the mode is
// "off". "ondemand" leaves this TRUE but shouldAugment() declines auto-search.
export function hybridEnabled(): boolean {
  return !CONFIG.localOnly && CONFIG.hybridResearch && CONFIG.webSearchMode !== "off";
}

export interface AugmentDecision {
  augment: boolean;
  reason: string;
}

// Time-/freshness-sensitive query smell. Such queries benefit from the live web
// even when local memory looks adequate.
const TIME_SENSITIVE_RE =
  /\b(latest|today'?s?|news|current(?:ly)?|now|recent(?:ly)?|this (?:week|month|year)|price|prices|cost|weather|forecast|releas(?:e|ed|es)|version|updates?|live|stock|score|2[01]\d\d)\b/i;

// The smart gate: should an /api/ask answer reach the internet alongside local
// memory? Pure + deterministic so the selfcheck can pin every branch.
export function shouldAugment(
  query: string,
  localHits: VectorSearchHit[],
  mode: typeof CONFIG.webSearchMode = CONFIG.webSearchMode,
): AugmentDecision {
  if (mode === "off") return { augment: false, reason: "mode=off" };
  if (mode === "ondemand") return { augment: false, reason: "mode=ondemand (web only via explicit actions)" };
  if (mode === "always") return { augment: true, reason: "mode=always" };
  // mode === "smart"
  const thin = localHits.length < 3;
  const weak = localHits.length === 0 || (localHits[0]?.score ?? 0) < 0.45;
  const fresh = TIME_SENSITIVE_RE.test(query);
  if (thin) return { augment: true, reason: `local memory thin (${localHits.length} hits)` };
  if (weak) return { augment: true, reason: `local memory weak (top score ${(localHits[0]?.score ?? 0).toFixed(2)})` };
  if (fresh) return { augment: true, reason: "query looks time-sensitive" };
  return { augment: false, reason: "local memory sufficient" };
}

// Search-rank → fusion score. Web hits land just below a strong local vector hit
// so they augment rather than blanket-dominate; the learned ranker re-scores the
// blended set afterwards anyway.
function rankScore(index: number): number {
  return Math.max(0.4, 0.7 - index * 0.03);
}

// We LEARN every chunk of every page (full pages → memory), but only FUSE a
// focused top slice into the current answer — a whole multi-page fetch can be
// hundreds of chunks, and dumping all of them as retrieval hits would swamp the
// ranker and the citation list. The leading chunks are a page's intro/summary,
// so this keeps the most representative material.
const MAX_FUSED_HITS = 8;

// How many page bodies to download at once. The remote fetch is the dominant,
// independent per-page cost; a small cap overlaps the waits without hammering
// any one host.
const WEB_FETCH_CONCURRENCY = 4;

// Order-preserving bounded-concurrency map (no dependency). Used to download the
// search results' page bodies in parallel while keeping results[i] ↔ out[i].
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

export async function webResearch(query: string, opts: WebResearchOptions = {}): Promise<WebResearchResult> {
  const q = query.trim();
  const base: WebResearchResult = { ok: false, provider: null, query: q, results: [], hits: [], ingested: 0, deduped: 0 };
  if (q.length === 0) return { ...base, reason: "empty query" };

  const limit = Math.min(10, Math.max(1, opts.limit ?? CONFIG.webResearchMaxPages));
  try {
    const search = await webSearch(q, {
      fetchImpl: opts.fetchImpl,
      localOnly: opts.localOnly,
      provider: opts.provider,
      limit: Math.max(limit, 5),
      searxngUrl: opts.searxngUrl,
      braveKey: opts.braveKey,
      tavilyKey: opts.tavilyKey,
      exaKey: opts.exaKey,
    });
    if (!search.ok) {
      return { ...base, provider: search.provider, reason: search.reason };
    }

    const results = search.results.slice(0, limit);
    const hits: VectorSearchHit[] = [];
    let ingested = 0;
    let deduped = 0;
    let scoreIndex = 0;

    // PHASE 1 — download every page body CONCURRENTLY (bounded). The remote
    // fetch (with its own LOCAL_ONLY gate + per-request timeout inside
    // fetchUrlText) is the slow, independent half; overlapping the N waits turns
    // wall-time from sum→max. Order is preserved so search rank → fusion score
    // stays stable.
    const pages = await mapWithConcurrency(results, WEB_FETCH_CONCURRENCY, (r) =>
      fetchUrlText(r.url, {
        fetchImpl: opts.fetchImpl,
        localOnly: opts.localOnly,
        maxBytes: opts.perPageMaxBytes,
      }),
    );

    // PHASE 2 — persist SEQUENTIALLY in rank order. The governed ingest's
    // content-hash dedup is a check-then-insert that must NOT interleave across
    // pages (see ingestFetchedPage), so this half stays ordered even though the
    // fetches ran in parallel.
    for (let i = 0; i < results.length; i++) {
      const page = pages[i];
      if (!page.ok) continue;
      const ing = await ingestFetchedPage(page, { embed: opts.embed });
      ingested += ing.ingested;
      deduped += ing.deduped;
      for (const point of ing.points ?? []) {
        if (hits.length < MAX_FUSED_HITS) {
          hits.push({ memory: point, score: rankScore(scoreIndex) });
          scoreIndex += 1;
        }
      }
    }

    return {
      ok: true,
      provider: search.provider,
      query: q,
      results,
      hits,
      ingested,
      deduped,
      reason: ingested === 0 ? "fetched no new content (already known or unreadable)" : undefined,
    };
  } catch (err) {
    surfaceError("webResearch", err);
    return { ...base, reason: err instanceof Error ? err.message : String(err) };
  }
}
