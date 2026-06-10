// Shared contract for the hybrid web layer (FRIDAY online). ZERO runtime deps —
// pure types + a constant — so both the Vite client and the Node server import
// it without a build step. The server enforces the LOCAL_ONLY egress gate; these
// are just the wire shapes.

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type WebSearchProvider = "searxng" | "brave" | "tavily" | "exa" | "duckduckgo";

export const WEB_SEARCH_PROVIDERS: WebSearchProvider[] = [
  "searxng",
  "brave",
  "tavily",
  "exa",
  "duckduckgo",
];

export type WebSearchOutcome =
  | { ok: true; provider: WebSearchProvider; endpoint?: string; results: WebSearchResult[] }
  | { ok: false; provider: WebSearchProvider | null; reason: string };

// What POST /api/web/research returns to the client (the fusable hit bodies stay
// server-side; the client gets the search results + what was learned).
export interface WebResearchView {
  ok: boolean;
  provider: WebSearchProvider | null;
  query: string;
  results: WebSearchResult[];
  ingested: number;
  deduped: number;
  reason?: string;
}
