// Pluggable, dependency-free web search — the "go find information" half of
// "learn from the internet". Mirrors ingest/webFetch.ts: a pure-ish module with
// an injectable fetch (so the selfcheck exercises every provider with ZERO real
// network) and the SAME egress guarantee.
//
// EGRESS GATE. Every backend's request URL is routed through the identical
// LOCAL_ONLY check the web fetcher uses: under LOCAL_ONLY=true (the default) only
// a loopback/RFC1918 endpoint is reachable — so a *local SearXNG* still works
// (your box already reaches the internet; ours never does), while every remote
// search API (Brave/Tavily/Exa/DuckDuckGo) is blocked before a single byte
// leaves the machine. Remote search requires LOCAL_ONLY=false, the same one-flag
// opt-out that enables remote LLM connectors and web fetching. There is NO
// remote-host bypass here (that exception exists only for the curated LLM
// providers): web search obeys "zero outbound by default" exactly.
//
// Providers (auto-selected unless WEB_SEARCH_PROVIDER forces one):
//   searxng    — a local SearXNG JSON endpoint (local-first; works under LOCAL_ONLY)
//   brave      — api.search.brave.com           (X-Subscription-Token: BRAVE_API_KEY)
//   tavily     — api.tavily.com                 (api_key: TAVILY_API_KEY)
//   exa        — api.exa.ai                      (x-api-key: EXA_API_KEY)
//   duckduckgo — duckduckgo.com/html            (no key; brittle HTML fallback)

import { CONFIG } from "../config.js";
import { isLocalUrl } from "../util/network.js";
import {
  WEB_SEARCH_PROVIDERS,
  type WebSearchOutcome,
  type WebSearchProvider,
  type WebSearchResult,
} from "../../../shared/web.js";

// Re-export the wire shapes so callers in server/ keep importing from here.
export { WEB_SEARCH_PROVIDERS };
export type { WebSearchOutcome, WebSearchProvider, WebSearchResult };

export interface WebSearchOptions {
  fetchImpl?: typeof fetch;
  localOnly?: boolean;
  provider?: string; // "auto" or one of WebSearchProvider
  limit?: number;
  timeoutMs?: number;
  searxngUrl?: string;
  // API keys are injectable for the hermetic selfcheck; in production they are
  // read from process.env at call time and NEVER persisted.
  braveKey?: string;
  tavilyKey?: string;
  exaKey?: string;
}

const DEFAULT_LIMIT = 5;
const DEFAULT_TIMEOUT_MS = 10_000;

function braveKeyOf(o: WebSearchOptions): string {
  return o.braveKey ?? process.env.BRAVE_API_KEY ?? "";
}
function tavilyKeyOf(o: WebSearchOptions): string {
  return o.tavilyKey ?? process.env.TAVILY_API_KEY ?? "";
}
function exaKeyOf(o: WebSearchOptions): string {
  return o.exaKey ?? process.env.EXA_API_KEY ?? "";
}
function searxngOf(o: WebSearchOptions): string {
  return (o.searxngUrl ?? CONFIG.searxngUrl ?? "").replace(/\/$/, "");
}

// Returns the chosen provider, or a reason it cannot run. "auto" prefers a local
// SearXNG, then any keyed API, then the no-key DuckDuckGo fallback — so the brain
// can always *attempt* search, and the egress gate decides reachability.
export function resolveProvider(
  opts: WebSearchOptions = {},
): { provider: WebSearchProvider } | { error: string } {
  const want = (opts.provider ?? CONFIG.webSearchProvider ?? "auto").toLowerCase();
  const has = {
    searxng: searxngOf(opts).length > 0,
    brave: braveKeyOf(opts).length > 0,
    tavily: tavilyKeyOf(opts).length > 0,
    exa: exaKeyOf(opts).length > 0,
  };

  if (want !== "auto") {
    if (!(WEB_SEARCH_PROVIDERS as string[]).includes(want)) {
      return { error: `unknown web search provider "${want}"` };
    }
    const p = want as WebSearchProvider;
    if (p === "searxng" && !has.searxng) return { error: "SEARXNG_URL is not set" };
    if (p === "brave" && !has.brave) return { error: "BRAVE_API_KEY is not set" };
    if (p === "tavily" && !has.tavily) return { error: "TAVILY_API_KEY is not set" };
    if (p === "exa" && !has.exa) return { error: "EXA_API_KEY is not set" };
    return { provider: p };
  }

  if (has.searxng) return { provider: "searxng" };
  if (has.brave) return { provider: "brave" };
  if (has.tavily) return { provider: "tavily" };
  if (has.exa) return { provider: "exa" };
  return { provider: "duckduckgo" };
}

// --- Provider request shapes -------------------------------------------------

interface PreparedRequest {
  endpoint: string;
  init: RequestInit;
  // "json" | "html" — how to parse the body.
  kind: "json" | "html";
}

function prepare(provider: WebSearchProvider, query: string, opts: WebSearchOptions): PreparedRequest {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const q = encodeURIComponent(query);
  switch (provider) {
    case "searxng":
      return {
        endpoint: `${searxngOf(opts)}/search?q=${q}&format=json&safesearch=1`,
        init: { method: "GET", headers: { accept: "application/json" } },
        kind: "json",
      };
    case "brave":
      return {
        endpoint: `https://api.search.brave.com/res/v1/web/search?q=${q}&count=${limit}`,
        init: {
          method: "GET",
          headers: { accept: "application/json", "X-Subscription-Token": braveKeyOf(opts) },
        },
        kind: "json",
      };
    case "tavily":
      return {
        endpoint: "https://api.tavily.com/search",
        init: {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ api_key: tavilyKeyOf(opts), query, max_results: limit }),
        },
        kind: "json",
      };
    case "exa":
      return {
        endpoint: "https://api.exa.ai/search",
        init: {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": exaKeyOf(opts) },
          body: JSON.stringify({ query, numResults: limit, contents: { text: { maxCharacters: 400 } } }),
        },
        kind: "json",
      };
    case "duckduckgo":
      return {
        endpoint: `https://duckduckgo.com/html/?q=${q}`,
        init: { method: "GET", headers: { accept: "text/html", "user-agent": "STAR-Brain/0.1" } },
        kind: "html",
      };
  }
}

// --- Response parsers (defensive — never trust shapes) -----------------------

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function isHttp(u: string): boolean {
  return /^https?:\/\//i.test(u);
}

function parseJsonResults(provider: WebSearchProvider, body: unknown, limit: number): WebSearchResult[] {
  const out: WebSearchResult[] = [];
  const push = (title: string, url: string, snippet: string): void => {
    const u = str(url).trim();
    if (!isHttp(u)) return;
    out.push({ title: str(title).trim() || u, url: u, snippet: str(snippet).trim().slice(0, 500) });
  };
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return out;

  if (provider === "brave") {
    const results = ((b.web as Record<string, unknown> | undefined)?.results ?? []) as unknown[];
    for (const r of Array.isArray(results) ? results : []) {
      const o = r as Record<string, unknown>;
      push(str(o.title), str(o.url), str(o.description));
    }
  } else {
    // searxng / tavily / exa all expose a top-level `results` array.
    const results = (b.results ?? []) as unknown[];
    for (const r of Array.isArray(results) ? results : []) {
      const o = r as Record<string, unknown>;
      push(str(o.title), str(o.url), str(o.content) || str(o.snippet) || str(o.text));
    }
  }
  return out.slice(0, limit);
}

// DuckDuckGo HTML scrape. Best-effort and deliberately the LAST resort: result
// links are `result__a`; their href is a /l/?uddg=<encoded-target> redirect.
function decodeDdgHref(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      /* fall through */
    }
  }
  if (href.startsWith("//")) return `https:${href}`;
  return href;
}

function parseDdgHtml(html: string, limit: number): WebSearchResult[] {
  const out: WebSearchResult[] = [];
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const stripTags = (s: string): string => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) && out.length < limit) {
    const url = decodeDdgHref(m[1]);
    if (!isHttp(url)) continue;
    out.push({ title: stripTags(m[2]) || url, url, snippet: "" });
  }
  return out;
}

// --- Public entry point ------------------------------------------------------

export async function webSearch(query: string, opts: WebSearchOptions = {}): Promise<WebSearchOutcome> {
  const q = query.trim();
  if (q.length === 0) return { ok: false, provider: null, reason: "empty query" };

  const resolved = resolveProvider(opts);
  if ("error" in resolved) return { ok: false, provider: null, reason: resolved.error };
  const provider = resolved.provider;

  const localOnly = opts.localOnly ?? CONFIG.localOnly;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;

  const req = prepare(provider, q, opts);

  // EGRESS GATE — see header. Blocked endpoints never reach `doFetch`.
  if (localOnly && !isLocalUrl(req.endpoint)) {
    return {
      ok: false,
      provider,
      reason: `blocked: web search via "${provider}" is off while LOCAL_ONLY=true (use a local SearXNG, or set LOCAL_ONLY=false)`,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    // Under LOCAL_ONLY, do NOT auto-follow redirects: the gate validated only
    // req.endpoint, but a 30x Location could point off-box and the default
    // "follow" would egress. "manual" surfaces the 3xx without contacting it.
    // (`req.init` sets no `redirect`, so without this the platform default
    // "follow" applies.) See ingest/webFetch.ts for the same reasoning.
    res = await doFetch(req.endpoint, {
      ...req.init,
      signal: controller.signal,
      redirect: localOnly ? "manual" : "follow",
    });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) return { ok: false, provider, reason: `timed out after ${timeoutMs}ms` };
    return { ok: false, provider, reason: `search failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  clearTimeout(timer);

  // Off-box redirect refusal (LOCAL_ONLY) — the redirect target was not contacted.
  if (localOnly && (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400))) {
    return { ok: false, provider, reason: "blocked: off-box redirect refused under LOCAL_ONLY" };
  }

  if (!res.ok) return { ok: false, provider, reason: `HTTP ${res.status}` };

  try {
    let results: WebSearchResult[];
    if (req.kind === "json") {
      const body = (await res.json()) as unknown;
      results = parseJsonResults(provider, body, limit);
    } else {
      const html = await res.text();
      results = parseDdgHtml(html, limit);
    }
    if (results.length === 0) {
      // The DuckDuckGo path scrapes HTML by a CSS class that DDG changes often;
      // a 200-OK page that yields zero links is a markup drift, not an empty
      // query — surface that distinctly so the augment note / logs can tell them
      // apart. JSON providers genuinely returned nothing.
      const reason = provider === "duckduckgo"
        ? "duckduckgo: no parseable results (markup may have changed)"
        : "no results";
      return { ok: false, provider, reason };
    }
    return { ok: true, provider, endpoint: req.endpoint, results };
  } catch (err) {
    return { ok: false, provider, reason: `parse failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
