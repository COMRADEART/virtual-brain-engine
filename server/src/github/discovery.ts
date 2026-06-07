// GitHub project discovery — the fetch half of "learn from popular repos". PURE
// of persistence (no DB): it searches GitHub for high-star repositories and reads
// their READMEs, handing the markdown to github/index.ts, which runs it through
// the SAME governed ingest (redact → dedup → importance → audit) as every other
// source.
//
// EGRESS + SSRF HARDENING. This is an egressing source, so it sits behind the
// SAME LOCAL_ONLY gate as the web fetcher: under the default LOCAL_ONLY=true,
// `isLocalUrl()` rejects api.github.com and no request is issued — "zero outbound
// by default" holds, and discovery requires the user to set LOCAL_ONLY=false (the
// same opt-out that enables remote models / web research). GitHub is deliberately
// NOT added to the curated remote-host allowlist.
//
// Because this module only runs when LOCAL_ONLY=false, the web fetcher's habit of
// gating redirect-protection on `localOnly` would leave it OFF here. So this
// module does NOT copy that idiom: it ALWAYS uses redirect:"manual" and refuses
// any 3xx, and it pins the host — every request URL is rebuilt via `new URL()`
// and its hostname asserted === "api.github.com" before a byte leaves the
// machine. Repo path segments (owner/name) coming from search results are
// validated against GitHub's own charset, so a poisoned field can't rewrite the
// host. We talk ONLY to api.github.com (the README is read via the base64 JSON
// envelope — a single 200, no redirect to raw.githubusercontent.com).
//
// `fetchImpl` is injectable so the selfcheck exercises every branch with canned
// responses and ZERO real network.

import { Buffer } from "node:buffer";
import { CONFIG } from "../config.js";
import { isLocalUrl } from "../util/network.js";
import { readCapped } from "../ingest/webFetch.js";
import type { GitHubDiscoverOutcome, GitHubRepo } from "../../../shared/github.js";

const API_HOST = "api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "STAR-Brain/0.1 (+local personal memory)";
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MB per response
const DEFAULT_README_CHARS = 200_000; // cap decoded README before chunking
const DEFAULT_TIMEOUT_MS = 15_000;

// GitHub identifier charsets (defensive — used to validate path segments BEFORE
// they touch a URL, and as a backstop alongside the hostname pin).
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/; // login: alnum + dash, <=39
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/; // repo name: alnum + . _ -, <=100
const LANG_RE = /^[A-Za-z0-9+#.\- ]{1,30}$/; // language qualifier

export interface GitHubFetchOptions {
  fetchImpl?: typeof fetch;
  // Defaults to CONFIG.localOnly. When true, only local targets are reachable —
  // so api.github.com is blocked (the default posture).
  localOnly?: boolean;
  // Injected in tests; in production read from CONFIG.githubToken at call time.
  token?: string;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface GitHubSearchOptions extends GitHubFetchOptions {
  minStars?: number;
  language?: string;
  limit?: number;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function tokenOf(o: GitHubFetchOptions): string {
  return o.token ?? CONFIG.githubToken ?? "";
}

type GhFetchResult =
  | { ok: true; body: string; rateRemaining: number | null }
  // rateRemaining is carried on error responses too (a 429/403 still reports it)
  // so the caller's rate-limit budget can react to throttling, not just success.
  | { ok: false; status?: number; reason: string; rateRemaining?: number | null };

// THE single egress choke point for every GitHub call. Host-pinned, redirect-
// refusing, byte-capped, token-in-header-only. Never echoes the token.
async function ghFetch(endpoint: string, opts: GitHubFetchOptions): Promise<GhFetchResult> {
  const localOnly = opts.localOnly ?? CONFIG.localOnly;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;

  // HOST PIN — rebuild the URL and assert it points at api.github.com over https.
  // This rejects a malformed/poisoned endpoint before the egress gate or fetch.
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, reason: "invalid GitHub URL" };
  }
  if (url.protocol !== "https:" || url.hostname !== API_HOST) {
    return { ok: false, reason: `refused: GitHub requests must be https://${API_HOST}` };
  }

  // EGRESS GATE — under LOCAL_ONLY, api.github.com is not local, so this blocks
  // before `doFetch` is ever called (proven by the selfcheck's call counter).
  if (localOnly && !isLocalUrl(endpoint)) {
    return {
      ok: false,
      reason: "blocked: GitHub discovery is off while LOCAL_ONLY=true (set LOCAL_ONLY=false to allow it)",
    };
  }

  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": USER_AGENT,
    "x-github-api-version": API_VERSION,
  };
  const token = tokenOf(opts);
  // Token goes ONLY in the Authorization header — never the URL/query/log.
  if (token) headers.authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await doFetch(url.toString(), {
      method: "GET",
      headers,
      signal: controller.signal,
      // ALWAYS manual (not gated on localOnly): this module runs with
      // LOCAL_ONLY=false, and following a 30x Location would re-issue the request
      // off-box, defeating the host pin. api.github.com answers these JSON
      // endpoints with a 200 directly, so manual-redirect has no functional cost.
      redirect: "manual",
    });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) return { ok: false, reason: `timed out after ${timeoutMs}ms` };
    // err.message from fetch never contains our headers/token.
    return { ok: false, reason: `request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  clearTimeout(timer);

  const rateRemaining = (() => {
    const raw = res.headers.get("x-ratelimit-remaining");
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  })();

  // Refuse ANY redirect — the target was not contacted (redirect:"manual").
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    return { ok: false, status: res.status, reason: "blocked: GitHub redirect refused", rateRemaining };
  }
  if (!res.ok) {
    // Surface the status (callers map 404 → "no README"; 403/429 → throttled) and
    // carry rateRemaining so the budget can stop; never echo the body.
    return { ok: false, status: res.status, reason: `GitHub HTTP ${res.status}`, rateRemaining };
  }

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const typeAllowed = contentType === "" || contentType.includes("json") || contentType.includes("text/");
  if (!typeAllowed) return { ok: false, status: res.status, reason: `unexpected content-type: ${contentType}`, rateRemaining };

  // readCapped streams the body; a TCP reset mid-stream (or a fake without a
  // stream) can throw — guard it so ghFetch upholds its "never throws" contract.
  let body: string | null;
  try {
    body = await readCapped(res, maxBytes);
  } catch (err) {
    return { ok: false, status: res.status, reason: `failed to read response: ${err instanceof Error ? err.message : String(err)}`, rateRemaining };
  }
  if (body === null) return { ok: false, status: res.status, reason: `response exceeds ${maxBytes} bytes`, rateRemaining };

  return { ok: true, body, rateRemaining };
}

// Search GitHub for repositories matching `topic` with >= minStars, sorted by
// stars descending. Returns the top `limit` repos. Never throws.
export async function githubSearch(topic: string, opts: GitHubSearchOptions = {}): Promise<GitHubDiscoverOutcome> {
  const q = topic.trim();
  if (q.length === 0) return { ok: false, reason: "empty query" };

  const minStars = Math.max(1, opts.minStars ?? CONFIG.githubMinStars);
  const limit = Math.min(50, Math.max(1, opts.limit ?? CONFIG.githubMaxRepos));
  const language = opts.language && LANG_RE.test(opts.language.trim()) ? opts.language.trim() : undefined;

  // Free-text topic + the stars qualifier (+ optional language). The whole `q` is
  // URL-encoded as one value, so a topic with odd characters can't add qualifiers
  // or break the URL; `language` is charset-validated above for the same reason.
  const query = `${q} stars:>=${minStars}${language ? ` language:${language}` : ""}`;
  const endpoint =
    `https://${API_HOST}/search/repositories?q=${encodeURIComponent(query)}` +
    `&sort=stars&order=desc&per_page=${limit}`;

  const fetched = await ghFetch(endpoint, opts);
  if (!fetched.ok) return { ok: false, reason: fetched.reason };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fetched.body);
  } catch {
    return { ok: false, reason: "GitHub returned unparseable JSON" };
  }
  const items = ((parsed as { items?: unknown })?.items ?? []) as unknown[];
  if (!Array.isArray(items)) return { ok: true, repos: [] };

  const repos: GitHubRepo[] = [];
  for (const it of items) {
    const o = it as Record<string, unknown>;
    const owner = str((o.owner as Record<string, unknown> | undefined)?.login);
    const name = str(o.name);
    const stars = Number(o.stargazers_count);
    if (!owner || !name) continue;
    if (!Number.isFinite(stars) || stars < minStars) continue; // defensive re-filter
    repos.push({
      fullName: str(o.full_name) || `${owner}/${name}`,
      owner,
      name,
      url: str(o.html_url) || `https://github.com/${owner}/${name}`,
      description: str(o.description),
      stars,
      language: o.language == null ? null : str(o.language) || null,
      topics: Array.isArray(o.topics) ? (o.topics.filter((t) => typeof t === "string") as string[]) : [],
    });
    if (repos.length >= limit) break;
  }
  return { ok: true, repos };
}

export type ReadmeResult =
  | { ok: true; markdown: string | null; rateRemaining: number | null }
  // rateRemaining carried on error too, so the learn loop's budget reacts to a
  // 403/429 throttle instead of hammering GitHub after it starts rejecting us.
  | { ok: false; reason: string; rateRemaining?: number | null };

// Fetch a repo's README as markdown via the base64 JSON envelope (single 200 on
// api.github.com — no redirect). owner/name are validated against GitHub's
// charset BEFORE building the URL so they can never rewrite the host. A 404 is a
// normal "this repo has no README" (markdown: null), not an error.
export async function fetchRepoReadme(owner: string, repo: string, opts: GitHubFetchOptions = {}): Promise<ReadmeResult> {
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) {
    return { ok: false, reason: "invalid repo identifier" };
  }
  const maxChars = DEFAULT_README_CHARS;
  const endpoint = `https://${API_HOST}/repos/${owner}/${repo}/readme`;

  const fetched = await ghFetch(endpoint, opts);
  if (!fetched.ok) {
    // 404 = repo has no README (normal). Any other error carries rateRemaining so
    // a throttle response still feeds the caller's rate-limit budget.
    if (fetched.status === 404) return { ok: true, markdown: null, rateRemaining: fetched.rateRemaining ?? null };
    return { ok: false, reason: fetched.reason, rateRemaining: fetched.rateRemaining ?? null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fetched.body);
  } catch {
    return { ok: false, reason: "GitHub returned unparseable README JSON" };
  }
  const o = parsed as Record<string, unknown>;
  const content = str(o.content);
  const encoding = str(o.encoding);
  if (!content) return { ok: true, markdown: null, rateRemaining: fetched.rateRemaining };

  let markdown: string;
  if (encoding === "base64") {
    // Buffer.from(..., "base64") tolerates the newlines GitHub embeds in content.
    markdown = Buffer.from(content, "base64").toString("utf8");
  } else {
    markdown = content;
  }
  markdown = markdown.slice(0, maxChars).trim();
  return { ok: true, markdown: markdown.length > 0 ? markdown : null, rateRemaining: fetched.rateRemaining };
}
