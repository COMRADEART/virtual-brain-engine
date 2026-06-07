// github/index.ts — "learn from popular repos" orchestrator. Turns a topic into
// fresh, citeable memory: discover high-star repos → read each README → run it
// through the SAME governed ingest as every other source (redact → dedup →
// importance → persist, embedded so it joins the vector index).
//
// Guarantees inherited wholesale from the layers below:
//   * EGRESS — githubSearch()/fetchRepoReadme() enforce the LOCAL_ONLY gate +
//     host pin, so nothing leaks under the default posture.
//   * GOVERNANCE — README markdown goes through ingestExplicitEmbedded, so a
//     secret in a README is redacted before storage/embedding exactly like any
//     ingest, and provenance is tagged automatically as source="ingest:github".
//
// It NEVER throws: any failure (blocked, offline, no results, a bad README) is
// returned as { ok:false, reason } / skipped per-repo so a partial run still
// learns what it can.

import { ingestExplicitEmbedded } from "../ingest/index.js";
import { chunkText } from "../ingest/webFetch.js";
import { githubSearch, fetchRepoReadme, type GitHubSearchOptions } from "./discovery.js";
import { surfaceError } from "../util/diagnostics.js";
import type { GitHubDiscoverOutcome, GitHubRepo } from "../../../shared/github.js";

export interface GitHubLearnOptions extends GitHubSearchOptions {
  // When supplied, learned READMEs are embedded → vector-retrievable forever.
  embed?: (text: string) => Promise<number[]>;
}

export interface GitHubLearnResult {
  ok: boolean;
  query: string;
  repos: GitHubRepo[];
  reposLearned: number;
  ingested: number;
  deduped: number;
  reason?: string;
}

// README fetch is the budgeted call (one per repo). 40 chunks @ ~1k chars caps a
// single huge README from flooding memory.
const README_CHUNK_OPTS = { targetChars: 1000, maxChunks: 40 } as const;
const RATE_FLOOR = 5;

export async function discoverAndLearn(topic: string, opts: GitHubLearnOptions = {}): Promise<GitHubLearnResult> {
  const query = topic.trim();
  const base: GitHubLearnResult = { ok: false, query, repos: [], reposLearned: 0, ingested: 0, deduped: 0 };
  if (query.length === 0) return { ...base, reason: "empty query" };

  // githubSearch is failure-isolated, but guard anyway so the orchestrator's
  // "never throws" contract holds even if a deeper layer regresses.
  let search: GitHubDiscoverOutcome;
  try {
    search = await githubSearch(query, opts);
  } catch (err) {
    surfaceError("github:discover", err);
    return { ...base, reason: "failed to reach GitHub search" };
  }
  if (!search.ok) return { ...base, reason: search.reason };
  if (search.repos.length === 0) return { ...base, ok: true, reason: "no repositories matched" };

  const occurredAt = new Date().toISOString();
  let ingested = 0;
  let deduped = 0;
  let reposLearned = 0;
  let stoppedForRate = false;
  let lastRateRemaining: number | null = null;

  // Sequential: keeps content-hash dedup ordering correct (each repo persisted
  // before the next is prepared) and respects GitHub's rate limit.
  for (const repo of search.repos) {
    if (lastRateRemaining !== null && lastRateRemaining < RATE_FLOOR) {
      stoppedForRate = true;
      break;
    }
    try {
      const readme = await fetchRepoReadme(repo.owner, repo.name, opts);
      // Update the budget FIRST (before any skip) so a 403/429 throttle response
      // stops the loop on the next iteration instead of being skipped past.
      if (readme.rateRemaining != null) lastRateRemaining = readme.rateRemaining;
      if (!readme.ok) continue; // bad identifier / fetch error for this repo — skip
      if (!readme.markdown) continue; // no README

      const chunks = chunkText(readme.markdown, README_CHUNK_OPTS);
      const items = chunks.map((text, i) => ({
        text,
        title:
          `${repo.fullName} (★${repo.stars})` + (chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ""),
        // Provenance: the repo URL → metadata.sourcePath (redacted by governance).
        // The source tag "ingest:github" is applied automatically by sourceId.
        sourcePath: repo.url,
        occurredAt,
      }));
      const res = await ingestExplicitEmbedded("github", items, opts.embed);
      ingested += res.ingested;
      deduped += res.deduped;
      if (res.ingested > 0) reposLearned += 1;
    } catch (err) {
      surfaceError("github:learn", err);
    }
  }

  const reason =
    stoppedForRate
      ? "stopped early: GitHub rate limit nearly exhausted (set GITHUB_TOKEN to raise it)"
      : ingested === 0
        ? "learned no new content (READMEs already known, empty, or unavailable)"
        : undefined;

  return { ok: true, query, repos: search.repos, reposLearned, ingested, deduped, reason };
}
