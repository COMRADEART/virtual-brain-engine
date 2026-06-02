// Hybrid local+internet ("FRIDAY goes online") selfcheck. HERMETIC: a throwaway
// DB via BRAIN_DB_PATH (set BEFORE importing config-dependent modules) and an
// INJECTED fetch (NO real network) that dispatches search-endpoint URLs and page
// URLs to canned responses. Proves the bits a fake CAN: provider selection,
// per-provider response parsing, the EGRESS gate (remote search blocked under
// LOCAL_ONLY and the fetch never issued; a local SearXNG reachable; remote
// reachable when LOCAL_ONLY=false), the smart augment gate, and the
// search→fetch→govern→embed→fuse research path (redaction + dedup + retrievable),
// plus the new web/system/file actions through the registry's trust boundary.
//
// Run: npm --prefix server run websearch:selfcheck

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "brain-websearchcheck-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");
// Pin LOCAL_ONLY to the secure default so hybridEnabled()/CONFIG reflect it; the
// egress branches that need it flipped pass an explicit per-call localOnly.
delete process.env.LOCAL_ONLY;

const { openDb, isVectorAvailable } = await import("../src/db/sqlite.js");
const { CONFIG } = await import("../src/config.js");
const { webSearch, resolveProvider } = await import("../src/web/search.js");
const { fetchUrlText } = await import("../src/ingest/webFetch.js");
const { isLocalUrl } = await import("../src/util/network.js");
const { webResearch, shouldAugment, hybridEnabled } = await import("../src/web/research.js");
const { resolveAction } = await import("../src/actions/resolver.js");
const { executeAction } = await import("../src/actions/executor.js");
const { _resetConfirmTokens } = await import("../src/actions/confirmTokens.js");
const { keywordSearch, listRecentMemories, countMemoryPoints } = await import("../src/db/repositories/memory.js");
const { listActionLog } = await import("../src/db/repositories/actions.js");
type Connector = import("../src/connectors/Connector.js").Connector;
import type { VectorSearchHit } from "../src/db/repositories/memory.js";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

openDb();

// --- Injected fetch (NO network) --------------------------------------------
interface FakeSpec {
  status?: number;
  contentType?: string;
  json?: unknown;
  text?: string;
}
function makeFetch(handler: (url: string) => FakeSpec | null): { impl: typeof fetch; calls: () => number } {
  let calls = 0;
  const impl = (async (input: unknown) => {
    calls += 1;
    const url = String(input);
    const r = handler(url);
    if (!r) throw new Error(`unexpected fetch to ${url}`);
    const status = r.status ?? 200;
    const ct = r.contentType ?? (r.json !== undefined ? "application/json" : "text/html");
    return {
      ok: status >= 200 && status < 300,
      status,
      url,
      headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? ct : null) },
      json: async () => (r.json !== undefined ? r.json : JSON.parse(r.text ?? "null")),
      text: async () => (r.text !== undefined ? r.text : JSON.stringify(r.json ?? null)),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

const BRAVE = { web: { results: [
  { title: "Brave A", url: "https://example.com/a", description: "about sqlite vector search" },
  { title: "Brave B", url: "https://example.com/b", description: "embeddings explained" },
] } };
const TAVILY = { results: [
  { title: "Tav A", url: "https://example.com/a", content: "tavily snippet one" },
  { title: "Tav B", url: "https://example.com/b", content: "tavily snippet two" },
] };
const EXA = { results: [{ title: "Exa A", url: "https://example.com/a", text: "exa text snippet" }] };
const SEARX = { results: [
  { title: "Searx A", url: "https://example.com/a", content: "searxng snippet" },
  { title: "Searx B", url: "https://example.com/b", content: "searxng snippet two" },
] };
const DDG_HTML =
  `<div><a class="result__a" href="/l/?kh=-1&uddg=https%3A%2F%2Fexample.com%2Fa">DDG Result A</a></div>` +
  `<div><a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fb">DDG Result B</a></div>`;

function pageHtml(body: string, title = "A Page"): FakeSpec {
  return { contentType: "text/html", text: `<html><head><title>${title}</title></head><body><p>${body}</p></body></html>` };
}

// A combined router used by the research tests: search endpoints + page fetches.
function researchRouter(searchSpec: FakeSpec, pageBody: (url: string) => string) {
  return (url: string): FakeSpec | null => {
    if (/api\.search\.brave\.com|api\.tavily\.com|api\.exa\.ai|\/search\?q=/.test(url)) return searchSpec;
    if (/^https?:\/\//.test(url)) return pageHtml(pageBody(url));
    return null;
  };
}

const embedDim = CONFIG.embeddingDim;
function makeEmbed(): { fn: (t: string) => Promise<number[]>; calls: () => number } {
  let calls = 0;
  return { fn: async () => { calls += 1; return new Array(embedDim).fill(0.01); }, calls: () => calls };
}

function stubConnector(json: string): Connector {
  return {
    descriptor: { id: "stub", name: "stub", kind: "ollama", enabled: true, state: "ok", createdAt: "", updatedAt: "", isLocal: true },
    async listModels() { return []; },
    async send() { return json; },
    async *stream() { yield ""; },
    async test() { return { ok: true }; },
  } satisfies Connector;
}

// ============================================================================
// 1. Provider resolution
// ============================================================================
check("auto → duckduckgo when nothing configured", (resolveProvider({}) as { provider?: string }).provider === "duckduckgo");
check("auto → searxng when SEARXNG_URL set", (resolveProvider({ searxngUrl: "http://127.0.0.1:8080" }) as { provider?: string }).provider === "searxng");
check("auto → brave when only a brave key set", (resolveProvider({ braveKey: "k" }) as { provider?: string }).provider === "brave");
check("auto → searxng beats a keyed API (local-first)", (resolveProvider({ searxngUrl: "http://127.0.0.1:8080", braveKey: "k" }) as { provider?: string }).provider === "searxng");
check("explicit brave WITHOUT key → error", "error" in resolveProvider({ provider: "brave" }));
check("explicit searxng WITH url → ok", (resolveProvider({ provider: "searxng", searxngUrl: "http://127.0.0.1:8080" }) as { provider?: string }).provider === "searxng");
check("unknown provider → error", "error" in resolveProvider({ provider: "wat" }));

// ============================================================================
// 1b. isLocalUrl hostname classification — the egress gate's core predicate.
// Regression guard for the fc/fd over-match: the IPv6 ULA branch must only fire
// for actual IPv6 literals (contain a colon), NEVER for DNS names that merely
// start with the letters fc/fd (fdroid.org, fc-cdn.example.com), which used to
// pass as "local" and slip past LOCAL_ONLY.
// ============================================================================
check("isLocalUrl: loopback is local", isLocalUrl("http://127.0.0.1:8787") === true);
check("isLocalUrl: RFC1918 is local", isLocalUrl("http://192.168.1.5/x") === true);
check("isLocalUrl: IPv6 ULA literal is local", isLocalUrl("http://[fc00::1]/x") === true);
check("isLocalUrl: fdroid.org (fd-prefixed DNS) is NOT local", isLocalUrl("https://fdroid.org/") === false);
check("isLocalUrl: fc-cdn.example.com (fc-prefixed DNS) is NOT local", isLocalUrl("https://fc-cdn.example.com/") === false);
check("isLocalUrl: ordinary remote is NOT local", isLocalUrl("https://example.com/") === false);

// ============================================================================
// 2. Egress gate
// ============================================================================
{
  const f = makeFetch(() => ({ json: BRAVE }));
  const r = await webSearch("q", { provider: "brave", braveKey: "k", localOnly: true, fetchImpl: f.impl });
  check("remote search BLOCKED under LOCAL_ONLY", r.ok === false && /blocked/i.test((r as { reason?: string }).reason ?? ""));
  check("blocked remote search issues ZERO fetch", f.calls() === 0);
}
{
  const f = makeFetch(() => ({ json: SEARX }));
  const r = await webSearch("q", { provider: "searxng", searxngUrl: "http://127.0.0.1:8080", localOnly: true, fetchImpl: f.impl });
  check("LOCAL searxng reachable EVEN under LOCAL_ONLY", r.ok === true && f.calls() === 1, (r as { reason?: string }).reason);
}
{
  const f = makeFetch(() => ({ json: BRAVE }));
  const r = await webSearch("q", { provider: "brave", braveKey: "k", localOnly: false, fetchImpl: f.impl });
  check("remote search reachable when LOCAL_ONLY=false", r.ok === true && f.calls() === 1, (r as { reason?: string }).reason);
}

// ============================================================================
// 2b. Redirect egress refusal (LOCAL_ONLY). A gate-passing LOCAL endpoint that
// 30x-redirects off-box must be REFUSED, not followed — the fix uses
// redirect:"manual" so the 3xx surfaces and the redirect TARGET is never
// contacted. The fake returns a 302; our code rejects it (status 3xx) before any
// follow, so exactly one fetch is issued (the local one).
// ============================================================================
{
  const f = makeFetch(() => ({ status: 302 }));
  const r = await webSearch("q", { provider: "searxng", searxngUrl: "http://127.0.0.1:8080", localOnly: true, fetchImpl: f.impl });
  check("web search: local 30x → REFUSED under LOCAL_ONLY (not followed)", r.ok === false && /redirect/i.test((r as { reason?: string }).reason ?? ""), (r as { reason?: string }).reason);
  check("refused redirect issued exactly one fetch (no off-box follow)", f.calls() === 1);
}
{
  const f = makeFetch(() => ({ status: 301 }));
  const r = await fetchUrlText("http://127.0.0.1:9999/page", { localOnly: true, fetchImpl: f.impl });
  check("web fetch: local 30x → REFUSED under LOCAL_ONLY", r.ok === false && /redirect/i.test((r as { reason?: string }).reason ?? ""), (r as { reason?: string }).reason);
}
{
  // Invariant 1: web search gates ONLY on isLocalUrl, NEVER on the LLM-connector
  // remote-host allowlist. Even with brave's host on REMOTE_PROVIDER_ALLOWLIST,
  // search stays blocked under LOCAL_ONLY (zero fetch). If a regression ever wired
  // isAllowedRemoteHost() into the search gate, this assertion catches it.
  process.env.REMOTE_PROVIDER_ALLOWLIST = "api.search.brave.com";
  const f = makeFetch(() => ({ json: BRAVE }));
  const r = await webSearch("q", { provider: "brave", braveKey: "k", localOnly: true, fetchImpl: f.impl });
  check("web search IGNORES the LLM remote-host allowlist (no bypass)", r.ok === false && f.calls() === 0, (r as { reason?: string }).reason);
  delete process.env.REMOTE_PROVIDER_ALLOWLIST;
}

// ============================================================================
// 3. Per-provider parsing (LOCAL_ONLY=false so remote endpoints are reachable)
// ============================================================================
{
  const r = await webSearch("q", { provider: "brave", braveKey: "k", localOnly: false, fetchImpl: makeFetch(() => ({ json: BRAVE })).impl });
  check("brave JSON parses", r.ok === true && r.ok && r.results[0].url === "https://example.com/a" && /sqlite/.test(r.results[0].snippet));
}
{
  const r = await webSearch("q", { provider: "tavily", tavilyKey: "k", localOnly: false, fetchImpl: makeFetch(() => ({ json: TAVILY })).impl });
  check("tavily JSON parses (content→snippet)", r.ok === true && r.ok && r.results.length === 2 && /tavily/.test(r.results[0].snippet));
}
{
  const r = await webSearch("q", { provider: "exa", exaKey: "k", localOnly: false, fetchImpl: makeFetch(() => ({ json: EXA })).impl });
  check("exa JSON parses (text→snippet)", r.ok === true && r.ok && /exa text/.test(r.results[0].snippet));
}
{
  const r = await webSearch("q", { provider: "searxng", searxngUrl: "http://127.0.0.1:8080", localOnly: true, fetchImpl: makeFetch(() => ({ json: SEARX })).impl });
  check("searxng JSON parses", r.ok === true && r.ok && r.results.length === 2);
}
{
  const r = await webSearch("q", { provider: "duckduckgo", localOnly: false, fetchImpl: makeFetch(() => ({ contentType: "text/html", text: DDG_HTML })).impl });
  check("duckduckgo HTML parses + decodes uddg redirect", r.ok === true && r.ok && r.results[0].url === "https://example.com/a" && r.results[1].url === "https://example.com/b");
}
{
  const r = await webSearch("q", { provider: "brave", braveKey: "k", localOnly: false, fetchImpl: makeFetch(() => ({ json: { web: { results: [] } } })).impl });
  check("empty results → ok:false 'no results'", r.ok === false && /no results/.test((r as { reason?: string }).reason ?? ""));
}
{
  const r = await webSearch("q", { provider: "brave", braveKey: "k", localOnly: false, fetchImpl: makeFetch(() => ({ status: 500 })).impl });
  check("non-2xx → ok:false 'HTTP 500'", r.ok === false && /HTTP 500/.test((r as { reason?: string }).reason ?? ""));
}

// ============================================================================
// 4. Smart augment gate (pure)
// ============================================================================
const strong: VectorSearchHit[] = Array.from({ length: 5 }, (_, i) => ({ memory: {} as never, score: 0.8 - i * 0.01 }));
const thin: VectorSearchHit[] = [{ memory: {} as never, score: 0.9 }];
const weak: VectorSearchHit[] = Array.from({ length: 4 }, () => ({ memory: {} as never, score: 0.2 }));
check("mode=off → no augment", shouldAugment("anything", strong, "off").augment === false);
check("mode=ondemand → no augment", shouldAugment("anything", strong, "ondemand").augment === false);
check("mode=always → augment", shouldAugment("anything", strong, "always").augment === true);
check("smart + thin local → augment", shouldAugment("history of rome", thin, "smart").augment === true);
check("smart + weak local → augment", shouldAugment("history of rome", weak, "smart").augment === true);
check("smart + strong local + time-sensitive query → augment", shouldAugment("latest news on AI", strong, "smart").augment === true);
check("smart + strong local + stable query → NO augment", shouldAugment("what is a binary tree", strong, "smart").augment === false);
check("hybrid is OFF by default (purely local)", hybridEnabled() === false);

// ============================================================================
// 5. webResearch: search → fetch → govern → embed → fuse
// ============================================================================
_resetConfirmTokens();
{
  const f = makeFetch(researchRouter({ json: BRAVE }, () => "deep content about sqlite vector search and embeddings here"));
  const embed = makeEmbed();
  const before = countMemoryPoints();
  const r = await webResearch("vector search", { provider: "brave", braveKey: "k", localOnly: false, fetchImpl: f.impl, embed: embed.fn, limit: 2 });
  check("research ok + ingested pages", r.ok === true && r.ingested >= 1, `ingested=${r.ingested} reason=${r.reason}`);
  check("research returns fusable hits with real memory ids", r.hits.length >= 1 && typeof r.hits[0].memory.id === "string");
  check("research hits carry a fusion score", r.hits.every((h) => h.score > 0 && h.score <= 1));
  check("research embedded each persisted page", embed.calls() >= r.ingested);
  check("research persisted new memories", countMemoryPoints() > before);
  check("learned web page is keyword-retrievable", keywordSearch("vector search", 5).length >= 1);
  const stored = listRecentMemories(1)[0];
  check('learned web page stored as "chunk"', stored?.sourceType === "chunk", `got ${stored?.sourceType}`);
  if (isVectorAvailable()) {
    check("learned web page joined the vector index (embeddingId set)", r.hits.length > 0 && typeof r.hits[0].memory.embeddingId === "number");
  } else {
    check("vector unavailable — embedding path degraded gracefully (skipped)", true, "no sqlite-vec");
  }
}
{
  // Redaction applies to fetched pages — on BOTH the storage AND the embedding
  // path. A capturing embed records every string it is handed; the secret must
  // appear in NONE of them (proving redaction runs BEFORE embedding, the branch
  // a non-embedding test cannot exercise) and in no stored row either.
  const SECRET = "sk-webRESEARCHsecret1234567890";
  const captured: string[] = [];
  const capturingEmbed = async (t: string): Promise<number[]> => {
    captured.push(t);
    return new Array(embedDim).fill(0.01);
  };
  const f = makeFetch(researchRouter({ json: { results: [{ title: "Leak", url: "https://example.com/leak", content: "x" }] } }, () => `deploy key ${SECRET} on the staging server box now`));
  const r = await webResearch("staging server box", { provider: "tavily", tavilyKey: "k", localOnly: false, fetchImpl: f.impl, limit: 1, embed: capturingEmbed });
  const leaked = listRecentMemories(200).some((m) => `${m.title ?? ""} ${m.content}`.includes(SECRET));
  check("fetched-page secret is REDACTED in storage", r.ingested >= 1 && !leaked);
  check("embed was actually invoked on the fetched page", captured.length >= 1);
  check("secret is REDACTED BEFORE embedding (no embed input contains it)", captured.every((s) => !s.includes(SECRET)));
  check("redacted page still retrievable", keywordSearch("staging server box", 5).length >= 1);
}
{
  // Invariant 4: a wrong-dim embedding is DROPPED (page stored without a vector),
  // never thrown — the page stays keyword-retrievable and the call still ok.
  const badEmbed = async (): Promise<number[]> => new Array(embedDim + 1).fill(0.01);
  const f = makeFetch(researchRouter({ json: { results: [{ title: "Dim", url: "https://example.com/dim", content: "x" }] } }, () => "wrong dimension guard page alpha bravo charlie unique tokens here"));
  const r = await webResearch("wrong dimension guard", { provider: "tavily", tavilyKey: "k", localOnly: false, fetchImpl: f.impl, limit: 1, embed: badEmbed });
  check("wrong-dim embed → research still ok (vector dropped, not thrown)", r.ok === true && r.ingested >= 1, `ok=${r.ok} ingested=${r.ingested} reason=${r.reason}`);
  // keywordSearch is a contiguous LIKE %…% match, so query a phrase present verbatim.
  check("wrong-dim page still keyword-retrievable", keywordSearch("alpha bravo charlie", 5).length >= 1);
}
{
  // Failure isolation: a fetch that THROWS must surface as ok:false, never throw.
  const throwingFetch = (async () => { throw new Error("network exploded"); }) as unknown as typeof fetch;
  let threw = false;
  let r: Awaited<ReturnType<typeof webResearch>> | undefined;
  try {
    r = await webResearch("never reaches a page", { provider: "brave", braveKey: "k", localOnly: false, fetchImpl: throwingFetch, limit: 2 });
  } catch {
    threw = true;
  }
  check("webResearch swallows a thrown fetch error (never throws)", threw === false && r !== undefined && r.ok === false, threw ? "THREW" : r?.reason);
}
{
  // Dedup on a re-research of identical content.
  const f = makeFetch(researchRouter({ json: BRAVE }, () => "deep content about sqlite vector search and embeddings here"));
  const before = countMemoryPoints();
  const r = await webResearch("vector search", { provider: "brave", braveKey: "k", localOnly: false, fetchImpl: f.impl, limit: 2 });
  check("re-research identical pages → deduped, nothing new", r.deduped >= 1 && countMemoryPoints() === before, `deduped=${r.deduped}`);
}
{
  // Egress: research blocked under LOCAL_ONLY, zero fetch, nothing learned.
  const f = makeFetch(researchRouter({ json: BRAVE }, () => "should never be fetched"));
  const before = countMemoryPoints();
  const r = await webResearch("anything", { provider: "brave", braveKey: "k", localOnly: true, fetchImpl: f.impl, limit: 2 });
  check("research BLOCKED under LOCAL_ONLY (zero egress, nothing learned)", r.ok === false && r.ingested === 0 && f.calls() === 0 && countMemoryPoints() === before, r.reason);
}

// ============================================================================
// 6. New actions through the registry trust boundary
// ============================================================================
_resetConfirmTokens();
{
  const r = await resolveAction("search the web for the latest typescript release", {
    connector: stubConnector(`{"actionId":"web-search","args":{"query":"latest typescript release"},"confidence":0.9}`),
  });
  check("resolver: web-search → confirm-tier plan + token", r.plan?.actionId === "web-search" && r.needsConfirm === true && typeof r.confirmToken === "string");
  const noToken = await executeAction({ actionId: "web-search", args: { query: "x" } });
  check("executor: web-search without token refused (403)", noToken.ok === false && noToken.status === 403);
  // With token, but LOCAL_ONLY default → the handler runs and reports BLOCKED
  // (no network leaves the machine; auto provider = duckduckgo = remote).
  const ok = await executeAction({ actionId: r.plan!.actionId, args: r.plan!.args, confirmToken: r.confirmToken });
  check("executor: web-search runs but reports blocked under LOCAL_ONLY", ok.ok === true && /blocked|couldn't search/i.test(ok.summary));
}
{
  const r = await resolveAction("research quantum computing online", {
    connector: stubConnector(`{"actionId":"research-web","args":{"query":"quantum computing"},"confidence":0.9}`),
  });
  check("resolver: research-web → confirm-tier plan + token", r.plan?.actionId === "research-web" && r.needsConfirm === true && typeof r.confirmToken === "string");
}
{
  const r = await executeAction({ actionId: "system-info", args: {} });
  check("executor: system-info is safe (no token) + returns data", r.ok === true && r.status === 200 && typeof (r.data as { platform?: string }).platform === "string");
}
{
  // File ops: guard rejects a relative path and a sensitive (.env) path.
  const rel = await resolveAction("list it", { connector: stubConnector(`{"actionId":"list-directory","args":{"path":"relative/dir"},"confidence":0.9}`) });
  const relRun = await executeAction({ actionId: rel.plan!.actionId, args: rel.plan!.args, confirmToken: rel.confirmToken });
  check("executor: list-directory refuses a relative path", relRun.ok === false && /absolute/i.test(relRun.error ?? ""));

  const envPath = process.platform === "win32" ? "C:\\proj\\.env" : "/proj/.env";
  const env = await resolveAction("read it", { connector: stubConnector(`{"actionId":"read-file","args":{"path":${JSON.stringify(envPath)}},"confidence":0.9}`) });
  const envRun = await executeAction({ actionId: env.plan!.actionId, args: env.plan!.args, confirmToken: env.confirmToken });
  check("executor: read-file refuses a sensitive (.env) path", envRun.ok === false && /sensitive|refused/i.test(envRun.error ?? ""));

  // The .ssh DIRECTORY itself (no trailing separator) must be refused after the
  // pattern was tightened to a terminal-component match — the old pattern needed
  // separators on both sides and so let the directory through (key-name leak).
  const sshDir = process.platform === "win32" ? "C:\\Users\\me\\.ssh" : "/home/me/.ssh";
  const ssh = await resolveAction("list it", { connector: stubConnector(`{"actionId":"list-directory","args":{"path":${JSON.stringify(sshDir)}},"confidence":0.9}`) });
  const sshRun = await executeAction({ actionId: ssh.plan!.actionId, args: ssh.plan!.args, confirmToken: ssh.confirmToken });
  check("executor: list-directory refuses the .ssh directory itself", sshRun.ok === false && /sensitive|refused/i.test(sshRun.error ?? ""), sshRun.error);

  // UNC / network path → refused before any fs call (it would open an outbound
  // SMB/NTLM channel the LOCAL_ONLY gate can't see). Forward-slash UNC is
  // absolute on both Windows and POSIX, so this assertion is portable.
  const unc = await resolveAction("read it", { connector: stubConnector(`{"actionId":"read-file","args":{"path":"//attacker-host/share/readme.txt"},"confidence":0.9}`) });
  const uncRun = await executeAction({ actionId: unc.plan!.actionId, args: unc.plan!.args, confirmToken: unc.confirmToken });
  check("executor: read-file refuses a UNC / network path (no SMB egress)", uncRun.ok === false && /UNC|network path/i.test(uncRun.error ?? ""), uncRun.error);
}
{
  // Trust boundary: an unknown action id → 403 (and is NOT executed); bad args
  // against a known action → 400 before any handler runs.
  const unknown = await executeAction({ actionId: "definitely-not-an-action", args: {} });
  check("executor: unknown action id → 403", unknown.ok === false && unknown.status === 403);
  const badArgs = await executeAction({ actionId: "search-memory", args: { query: 123 } });
  check("executor: invalid args → 400", badArgs.ok === false && badArgs.status === 400);
}
{
  // write → read → list roundtrip in the throwaway dir.
  const fpath = join(tmp, "note.txt");
  const content = "hello from the brain task layer";
  const w = await resolveAction("write it", { connector: stubConnector(`{"actionId":"write-file","args":{"path":${JSON.stringify(fpath)},"content":${JSON.stringify(content)}},"confidence":0.9}`) });
  const wRun = await executeAction({ actionId: w.plan!.actionId, args: w.plan!.args, confirmToken: w.confirmToken });
  check("executor: write-file succeeds (confirmed)", wRun.ok === true && wRun.status === 200);

  const rd = await resolveAction("read it", { connector: stubConnector(`{"actionId":"read-file","args":{"path":${JSON.stringify(fpath)}},"confidence":0.9}`) });
  const rdRun = await executeAction({ actionId: rd.plan!.actionId, args: rd.plan!.args, confirmToken: rd.confirmToken });
  check("executor: read-file returns the written content", rdRun.ok === true && (rdRun.data as { content?: string }).content === content);

  const ls = await resolveAction("list it", { connector: stubConnector(`{"actionId":"list-directory","args":{"path":${JSON.stringify(tmp)}},"confidence":0.9}`) });
  const lsRun = await executeAction({ actionId: ls.plan!.actionId, args: ls.plan!.args, confirmToken: ls.confirmToken });
  const names = Array.isArray(lsRun.data) ? (lsRun.data as Array<{ name: string }>).map((e) => e.name) : [];
  check("executor: list-directory lists the written file", lsRun.ok === true && names.includes("note.txt"));
}

// ============================================================================
// 7. Audit completeness
// ============================================================================
{
  const log = listActionLog(200);
  const has = (pred: (e: (typeof log)[number]) => boolean) => log.some(pred);
  check("audit: web-search attempt logged", has((e) => e.actionId === "web-search"));
  check("audit: write-file confirmed success logged", has((e) => e.actionId === "write-file" && e.ok && e.confirmed));
  check("audit: a refused file op logged", has((e) => (e.actionId === "list-directory" || e.actionId === "read-file") && !e.ok));
  check("audit: system-info success logged (unconfirmed/safe)", has((e) => e.actionId === "system-info" && e.ok && !e.confirmed));
}

try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
void writeFileSync;

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
