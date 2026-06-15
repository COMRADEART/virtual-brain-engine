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
import type { GitHubDiscoverOutcome, GitHubLearnRepoView, GitHubRepo } from "../../../shared/github.js";

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

// Parse a repo reference the user might paste: "owner/name", an https/ssh github
// URL (with an optional .git suffix or trailing path), into { owner, name }. The
// identifiers themselves are charset-validated downstream in fetchRepoReadme, so
// this only has to extract the two segments. Returns null when it can't.
export function parseRepoRef(ref: string): { owner: string; name: string } | null {
  const s = ref.trim();
  // github.com/<owner>/<name> from an https or git@github.com: URL (tolerate a
  // trailing .git, a path, a query/hash, and a trailing slash).
  const m = s.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?].*)?$/i);
  if (m) return { owner: m[1], name: m[2] };
  const parts = s.replace(/\.git$/i, "").split("/").filter(Boolean);
  if (parts.length === 2) return { owner: parts[0], name: parts[1] };
  return null;
}

// "Add THIS repo to the brain": read ONE specific repository's README into memory
// through the SAME governed, embedded ingest as discoverAndLearn — just scoped to
// a single owner/name instead of a topic search. Reuses the identical egress
// hardening (LOCAL_ONLY gate + host pin live inside fetchRepoReadme/githubSearch)
// and governance (redact → dedup → importance → persist). NEVER throws: every
// failure is a returned { ok, reason }.
//
// A best-effort metadata search enriches the title with the repo's real star
// count + canonical URL; if it can't resolve (rate-limited, or the exact repo
// isn't in the top star-sorted matches) the README is STILL learned with a plain
// "owner/name" title — the knowledge is what matters, the ★ is a nicety.
export async function learnRepo(
  owner: string,
  name: string,
  opts: GitHubLearnOptions = {},
): Promise<GitHubLearnRepoView> {
  const fullName = `${owner}/${name}`;
  const base: GitHubLearnRepoView = {
    ok: false,
    repo: fullName,
    url: `https://github.com/${owner}/${name}`,
    stars: 0,
    learned: false,
    ingested: 0,
    deduped: 0,
  };

  // Best-effort metadata (stars / canonical URL / description) for a nicer title.
  let repo: GitHubRepo = {
    fullName,
    owner,
    name,
    url: base.url,
    description: "",
    stars: 0,
    language: null,
    topics: [],
  };
  try {
    const found = await githubSearch(name, { ...opts, minStars: 1, limit: 30 });
    if (found.ok) {
      const hit = found.repos.find(
        (r) =>
          r.owner.toLowerCase() === owner.toLowerCase() &&
          r.name.toLowerCase() === name.toLowerCase(),
      );
      if (hit) repo = hit;
    }
  } catch (err) {
    surfaceError("github:learn-repo:meta", err);
  }

  let readme: Awaited<ReturnType<typeof fetchRepoReadme>>;
  try {
    readme = await fetchRepoReadme(owner, name, opts);
  } catch (err) {
    surfaceError("github:learn-repo", err);
    return { ...base, url: repo.url, stars: repo.stars, reason: "failed to reach GitHub" };
  }
  if (!readme.ok) return { ...base, url: repo.url, stars: repo.stars, reason: readme.reason };
  if (!readme.markdown) {
    return { ...base, ok: true, url: repo.url, stars: repo.stars, reason: "repository has no README" };
  }

  const occurredAt = new Date().toISOString();
  const chunks = chunkText(readme.markdown, README_CHUNK_OPTS);
  const items = chunks.map((text, i) => ({
    text,
    title:
      `${repo.fullName}${repo.stars ? ` (★${repo.stars})` : ""}` +
      (chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ""),
    sourcePath: repo.url, // → metadata.sourcePath; "ingest:github" source auto-applied
    occurredAt,
  }));

  let res: Awaited<ReturnType<typeof ingestExplicitEmbedded>>;
  try {
    res = await ingestExplicitEmbedded("github", items, opts.embed);
  } catch (err) {
    surfaceError("github:learn-repo", err);
    return { ...base, url: repo.url, stars: repo.stars, reason: "failed to store README" };
  }

  return {
    ok: true,
    repo: repo.fullName,
    url: repo.url,
    stars: repo.stars,
    learned: res.ingested > 0,
    ingested: res.ingested,
    deduped: res.deduped,
    reason: res.ingested === 0 ? "README already known or empty" : undefined,
  };
}

// Parse-then-learn convenience: the single entry point both the route and the
// permissioned action call, so ref parsing lives in exactly one place.
export async function learnRepoRef(ref: string, opts: GitHubLearnOptions = {}): Promise<GitHubLearnRepoView> {
  const parsed = parseRepoRef(ref);
  if (!parsed) {
    return {
      ok: false,
      repo: ref.trim(),
      url: "",
      stars: 0,
      learned: false,
      ingested: 0,
      deduped: 0,
      reason: "couldn't parse a repo from that — use owner/name or a github.com URL",
    };
  }
  return learnRepo(parsed.owner, parsed.name, opts);
}
