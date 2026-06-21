// MCP marketplace discovery — "wire the MCP market to the brain so it can FIND
// skills and MCP servers it can use".
//
// This is the SEARCH half: it queries a public MCP registry (the official
// registry.modelcontextprotocol.io by default, overridable via MCP_REGISTRY_URL)
// and returns the servers that match a query, each shaped into an McpMarketEntry
// the brain can then ADD (mcp/hub.addServer via the confirm-tier mcp-market-add
// action). Discovering a server does NOT connect it — adding is a separate,
// gated step, and even then every tool stays confirm-tier (registrySync).
//
// EGRESS + SSRF HARDENING (modeled on github/discovery.ts):
//   - The registry is REMOTE, so this sits behind the SAME LOCAL_ONLY gate as
//     web/GitHub: under the default LOCAL_ONLY=true the registry is not local,
//     isLocalUrl() rejects it, and NO request is issued — discovery needs
//     LOCAL_ONLY=false (the one documented opt-out).
//   - HOST PIN: every request URL is rebuilt and its host asserted === the
//     configured registry host over https, BEFORE the egress gate or fetch.
//   - redirect:"manual" ALWAYS + refuse any 3xx (a Location could re-issue the
//     request off the pinned host).
//   - byte-capped + timed out; the registry is read-only (GET) — discovery never
//     installs or runs anything.
//
// fetchImpl is injectable so the selfcheck drives every branch with canned
// responses and ZERO real network.

import { CONFIG } from "../config.js";
import { assertEgressAllowed } from "../util/network.js";
import { readCapped } from "../ingest/webFetch.js";
import {
  type McpMarketEntry,
  type McpPackageRegistry,
  type McpTransportKind,
} from "../../../shared/mcp.js";

const USER_AGENT = "STAR-Brain/0.1 (+local personal memory)";
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024; // 4 MB registry page
const DEFAULT_TIMEOUT_MS = 15_000;

export interface MarketSearchOptions {
  fetchImpl?: typeof fetch;
  /** Defaults to CONFIG.localOnly. true → remote registry is blocked. */
  localOnly?: boolean;
  /** Defaults to CONFIG.mcpRegistryUrl. */
  registryUrl?: string;
  limit?: number;
  maxBytes?: number;
  timeoutMs?: number;
}

export type MarketSearchOutcome =
  | { ok: true; entries: McpMarketEntry[]; registry: string }
  | { ok: false; reason: string };

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function slug(s: string): string {
  const last = String(s).split("/").pop() ?? s;
  const out = last.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return out.length > 0 ? out : "x";
}

// ── pure parse ────────────────────────────────────────────────────────────────

// Map a registry "packages[]" entry's registry tag onto our two supported ones.
function packageRegistryOf(raw: Record<string, unknown>): McpPackageRegistry | null {
  const tag = (
    str(raw.registryType) ||
    str(raw.registry_name) ||
    str(raw.registry_type) ||
    str(raw.type)
  ).toLowerCase();
  if (tag.includes("npm")) return "npm";
  if (tag.includes("pypi") || tag.includes("pip") || tag.includes("python")) return "pypi";
  return null;
}

function transportOfRemote(raw: Record<string, unknown>): McpTransportKind {
  const t = (str(raw.transportType) || str(raw.transport_type) || str(raw.type)).toLowerCase();
  return t.includes("sse") ? "sse" : "http";
}

/**
 * Defensively turn one raw registry server object into an McpMarketEntry, or
 * null if it carries nothing connectable. PURE. Prefers a stdio package (the
 * dominant MCP deployment) and falls back to a remote endpoint. Tolerant of the
 * registry's field-name drift (registryType vs registry_name, etc.).
 */
export function registryServerToEntry(raw: unknown, source: string): McpMarketEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name = str(o.name);
  if (!name) return null;
  const description = str(o.description);
  const repo = o.repository;
  const homepage =
    typeof repo === "string" ? repo : str((repo as Record<string, unknown> | undefined)?.url) || undefined;

  // Prefer a package (stdio) — npm first, then pypi.
  const packages = Array.isArray(o.packages) ? o.packages : [];
  for (const reg of ["npm", "pypi"] as McpPackageRegistry[]) {
    for (const p of packages) {
      if (!p || typeof p !== "object") continue;
      const pr = packageRegistryOf(p as Record<string, unknown>);
      if (pr !== reg) continue;
      const pkg = str((p as Record<string, unknown>).identifier) || str((p as Record<string, unknown>).name);
      if (!pkg) continue;
      return {
        id: slug(name),
        name,
        description,
        transport: "stdio",
        package: pkg,
        packageRegistry: reg,
        homepage,
        source,
      };
    }
  }

  // Fall back to a remote endpoint.
  const remotes = Array.isArray(o.remotes) ? o.remotes : [];
  for (const r of remotes) {
    if (!r || typeof r !== "object") continue;
    const url = str((r as Record<string, unknown>).url);
    if (!url) continue;
    return {
      id: slug(name),
      name,
      description,
      transport: transportOfRemote(r as Record<string, unknown>),
      url,
      homepage,
      source,
    };
  }

  return null;
}

/** Parse a registry JSON body (defensive about the top-level shape). PURE. */
export function parseRegistryServers(body: string, source: string): McpMarketEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const list =
    (parsed as { servers?: unknown[] })?.servers ??
    (Array.isArray(parsed) ? (parsed as unknown[]) : []);
  if (!Array.isArray(list)) return [];
  const out: McpMarketEntry[] = [];
  for (const raw of list) {
    // Registry v0 wraps the spec under `server`; tolerate both shapes.
    const inner = raw && typeof raw === "object" && "server" in (raw as object) ? (raw as { server: unknown }).server : raw;
    const entry = registryServerToEntry(inner, source);
    if (entry) out.push(entry);
  }
  return out;
}

/** Case-insensitive match of a query against an entry's name + description. PURE. */
export function entryMatches(entry: McpMarketEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${entry.name} ${entry.description}`.toLowerCase();
  return q.split(/\s+/).every((term) => hay.includes(term));
}

// ── egress (host-pinned, redirect-refusing, LOCAL_ONLY-gated) ─────────────────

async function marketFetch(
  endpoint: string,
  registryHost: string,
  opts: MarketSearchOptions,
): Promise<{ ok: true; body: string } | { ok: false; reason: string }> {
  const localOnly = opts.localOnly ?? CONFIG.localOnly;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;

  // HOST PIN — rebuild + assert https + the configured registry host before
  // anything else (rejects a poisoned/misconfigured endpoint).
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, reason: "invalid registry URL" };
  }
  if (url.protocol !== "https:" || url.hostname !== registryHost) {
    return { ok: false, reason: `refused: MCP registry requests must be https://${registryHost}` };
  }

  // EGRESS GATE — under LOCAL_ONLY the remote registry is not local → blocked
  // before doFetch is ever called (the selfcheck proves it with a call counter).
  if (!assertEgressAllowed(endpoint, localOnly).ok) {
    return {
      ok: false,
      reason: "blocked: MCP marketplace is off while LOCAL_ONLY=true (set LOCAL_ONLY=false to allow it)",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await doFetch(url.toString(), {
      method: "GET",
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: controller.signal,
      redirect: "manual", // ALWAYS — a Location could move the request off the pinned host
    });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) return { ok: false, reason: `timed out after ${timeoutMs}ms` };
    return { ok: false, reason: `request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  clearTimeout(timer);

  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    return { ok: false, reason: "blocked: MCP registry redirect refused" };
  }
  if (!res.ok) return { ok: false, reason: `MCP registry HTTP ${res.status}` };

  let body: string | null;
  try {
    body = await readCapped(res, maxBytes);
  } catch (err) {
    return { ok: false, reason: `failed to read registry response: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (body === null) return { ok: false, reason: `registry response exceeds ${maxBytes} bytes` };
  return { ok: true, body };
}

/**
 * Search the configured MCP registry for servers matching `query`. Reads one
 * bounded page and filters locally (so it works whether or not the registry
 * honours a `search` param). Never throws.
 */
export async function searchMarket(query: string, opts: MarketSearchOptions = {}): Promise<MarketSearchOutcome> {
  const q = query.trim();
  const registryUrl = (opts.registryUrl ?? CONFIG.mcpRegistryUrl).trim();
  const limit = Math.min(50, Math.max(1, opts.limit ?? CONFIG.mcpMarketMax));

  let base: URL;
  try {
    base = new URL(registryUrl);
  } catch {
    return { ok: false, reason: `invalid MCP_REGISTRY_URL: ${registryUrl}` };
  }
  const host = base.hostname;

  // Read one page; pass `search` too (newer registries honour it) but we always
  // re-filter locally so an older registry that ignores it still works.
  const endpoint = new URL("/v0/servers", base.origin);
  endpoint.searchParams.set("limit", String(Math.min(100, Math.max(limit, 30))));
  if (q) endpoint.searchParams.set("search", q);

  const fetched = await marketFetch(endpoint.toString(), host, opts);
  if (!fetched.ok) return { ok: false, reason: fetched.reason };

  const all = parseRegistryServers(fetched.body, host);
  const matched = all.filter((e) => entryMatches(e, q)).slice(0, limit);
  return { ok: true, entries: matched, registry: host };
}
