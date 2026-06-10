// Computer-wide ingestion selfcheck (Phase 2). HERMETIC: throwaway DB via
// BRAIN_DB_PATH (set BEFORE importing config-dependent modules), no network, no
// embeddings (ingest persists without a vector). The governance is pure regex +
// SQLite.
//
// Run: npm --prefix server run ingest:selfcheck
//
// Asserts:
//   Consent   — default OFF; ingest with consent off stores NOTHING; enabling
//               then ingesting stores + is retrievable.
//   Redaction — a planted secret in BOTH the body and the sourcePath is absent
//               from EVERY persisted column (title, content, metadata) of the
//               raw row — proven by scanning the stored rows, NOT keywordSearch
//               (which only sees content). A separate check proves the item is
//               still retrievable (redaction didn't gut it).
//   No over-redaction — an email (legitimate PII payload) SURVIVES storage.
//   Source    — ambient ingest is stored as "chunk", not "manual" (importance).
//   Dedup     — the same item twice → deduped, stored once.
//   Exclude   — a sensitive sourcePath (.env) is dropped and never retrievable.
//   Empty     — blank text is skipped.
//   Audit     — ingest_log + status reflect runs.
//   Web       — "learn from the internet" (fetchAndIngestUrl), HERMETIC via an
//               injected fetch (NO real network): EGRESS is blocked while
//               LOCAL_ONLY (and the fetch is never even called); a local target
//               is reachable even under LOCAL_ONLY; with LOCAL_ONLY=false an
//               internet page is fetched, HTML→text-extracted, chunked, governed
//               (redact + dedup) and stored WITHOUT needing ambient consent;
//               non-http schemes, bad content-types, and oversized bodies are
//               refused. Plus pure unit checks of htmlToText + chunkText.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "brain-ingestcheck-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const { openDb } = await import("../src/db/sqlite.js");
const { ingestItems, ingestStatus, fetchAndIngestUrl } = await import("../src/ingest/index.js");
const { htmlToText, chunkText } = await import("../src/ingest/webFetch.js");
const { setConsent, isConsentEnabled, listIngestLog } = await import("../src/db/repositories/ingest.js");
const { listRecentMemories, keywordSearch, countMemoryPoints } = await import("../src/db/repositories/memory.js");

// A canned fetch (NO real network). `calls` counts invocations so we can prove a
// blocked fetch never leaves the machine. Body has no ReadableStream, so the
// capped reader takes its `.text()` fallback path.
function fakeFetch(
  body: string,
  init: { contentType?: string; status?: number; url?: string } = {},
): { impl: typeof fetch; calls: () => number } {
  let calls = 0;
  const impl = (async (input: unknown) => {
    calls += 1;
    const status = init.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      url: init.url ?? String(input),
      headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? init.contentType ?? "text/html" : null) },
      text: async () => body,
    };
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

openDb(); // schema (ingest_consent, ingest_log, memory_points) + migrations

// All persisted text of a memory row — the real leak surface.
function rowText(m: { title?: string | null; content: string; metadata?: Record<string, unknown> }): string {
  return [m.title ?? "", m.content, JSON.stringify(m.metadata ?? {})].join(" ");
}
function anyRowContains(needle: string): boolean {
  return listRecentMemories(200).some((m) => rowText(m).includes(needle));
}

// --- Consent gate -----------------------------------------------------------
check("consent is OFF by default", isConsentEnabled("clipboard") === false);
{
  const r = ingestItems("clipboard", [{ text: "should not be stored" }]);
  check("ingest with consent OFF stores nothing", r.ingested === 0 && r.skipped === 1 && !!r.reason);
  check("nothing was persisted while consent off", countMemoryPoints() === 0);
}

// --- Enable + basic ingest + retrievability ---------------------------------
setConsent("clipboard", true);
check("consent enables after opt-in", isConsentEnabled("clipboard") === true);
{
  const r = ingestItems("clipboard", [{ text: "the brain project uses sqlite and three.js" }]);
  check("clean item is ingested", r.ingested === 1 && r.skipped === 0);
  check("ingested item is retrievable (keyword)", keywordSearch("sqlite", 5).length >= 1);
  check("ingested item is retrievable (recent)", anyRowContains("three.js"));
  const stored = listRecentMemories(1)[0];
  check('ambient ingest is stored as "chunk", not "manual"', stored?.sourceType === "chunk", `got ${stored?.sourceType}`);
}

// --- Redaction across ALL persisted fields ----------------------------------
setConsent("manual", true);
const BODY_SECRET = "sk-livetEST1234567890abcdEF";
const PATH_SECRET = "sk-anotherSECRET1234567890";
{
  const r = ingestItems("manual", [
    {
      text: `deploy key ${BODY_SECRET} and more text here`,
      sourcePath: `https://api.example.com/v1?access_token=${PATH_SECRET}`,
    },
  ]);
  check("secret item is ingested (not dropped)", r.ingested === 1);
  check("redaction was counted", r.redacted >= 1, `redacted=${r.redacted}`);
  check("body secret absent from EVERY persisted column", !anyRowContains(BODY_SECRET));
  check("path secret absent from EVERY persisted column", !anyRowContains(PATH_SECRET));
  // Separate surface: still retrievable by a non-secret token from the body.
  check("redacted item is still retrievable", keywordSearch("more text here", 5).length >= 1);
}

// --- No over-redaction: PII is the legitimate payload -----------------------
{
  ingestItems("manual", [{ text: "call alice@example.com about the Q3 budget" }]);
  check("email (PII) SURVIVES storage — not over-redacted", anyRowContains("alice@example.com"));
}

// --- Dedup ------------------------------------------------------------------
{
  const before = countMemoryPoints();
  const r = ingestItems("clipboard", [{ text: "the brain project uses sqlite and three.js" }]);
  check("identical item is deduped, not re-stored", r.deduped === 1 && r.ingested === 0 && countMemoryPoints() === before);
}

// --- Exclude sensitive paths ------------------------------------------------
{
  const r = ingestItems("manual", [{ text: "TOPSECRETVALUE inside an env file", sourcePath: "C:\\proj\\.env" }]);
  check("excluded path is skipped", r.skipped === 1 && r.ingested === 0);
  check("excluded content is never retrievable", !anyRowContains("TOPSECRETVALUE"));
}

// --- Empty text -------------------------------------------------------------
{
  const r = ingestItems("manual", [{ text: "   " }]);
  check("empty/blank text is skipped", r.skipped === 1 && r.ingested === 0);
}

// --- Web: pure extraction + chunking ----------------------------------------
{
  const { title, text } = htmlToText(
    "<html><head><title>Doc &amp; Notes</title></head><body><script>var x=42;</script>" +
      "<style>.a{color:red}</style><p>Hello world about sqlite.</p><p>Second paragraph.</p></body></html>",
  );
  check("htmlToText extracts <title> + decodes entities", title === "Doc & Notes", `got ${title}`);
  check("htmlToText keeps body text", text.includes("Hello world about sqlite.") && text.includes("Second paragraph."));
  check("htmlToText drops <script>/<style>", !text.includes("x=42") && !text.includes("color:red"));
  const chunks = chunkText("x".repeat(2500), { targetChars: 1000 });
  check("chunkText hard-wraps an oversized paragraph", chunks.length >= 2, `chunks=${chunks.length}`);
  const many = (("x".repeat(300) + "\n\n").repeat(6)).trim();
  check("chunkText respects maxChunks", chunkText(many, { targetChars: 250, maxChunks: 2 }).length === 2);
}

// --- Web: egress gate (LOCAL_ONLY blocks internet, fetch never called) -------
{
  const spy = fakeFetch("<p>should never be fetched</p>");
  const r = await fetchAndIngestUrl("https://example.com/secret", { localOnly: true, fetchImpl: spy.impl });
  check("LOCAL_ONLY blocks an internet fetch", r.ingested === 0 && r.skipped === 1);
  check("blocked fetch is NEVER issued (zero egress)", spy.calls() === 0);
  check("blocked fetch explains why", /local_only|blocked/i.test(r.reason ?? ""), r.reason);
}

// --- Web: a LOCAL target is reachable even under LOCAL_ONLY ------------------
{
  const f = fakeFetch("<title>Local</title><body><p>local doc server content</p></body>");
  const r = await fetchAndIngestUrl("http://127.0.0.1:9/page", { localOnly: true, fetchImpl: f.impl });
  check("local target is fetched even under LOCAL_ONLY", f.calls() === 1 && r.ingested >= 1, `ingested=${r.ingested}`);
}

// --- Web: internet fetch with LOCAL_ONLY=false (no ambient consent needed) ---
{
  check("web consent is OFF (explicit path must not need it)", isConsentEnabled("web") === false);
  const html = "<title>Vectors</title><body><p>web learning about sqlite vector search and embeddings</p></body>";
  const r = await fetchAndIngestUrl("https://example.com/vectors", { localOnly: false, fetchImpl: fakeFetch(html).impl });
  check("internet page is ingested when LOCAL_ONLY=false", r.ingested >= 1, `ingested=${r.ingested}`);
  check("web ingest needs no ambient consent (command IS consent)", isConsentEnabled("web") === false);
  check("learned page is retrievable", keywordSearch("vector search", 5).length >= 1);
  const stored = listRecentMemories(1)[0];
  check('web ingest is stored as "chunk"', stored?.sourceType === "chunk", `got ${stored?.sourceType}`);
}

// --- Web: redaction applies to fetched content ------------------------------
{
  const SECRET = "sk-webFETCHsecret1234567890";
  const html = `<body><p>deploy with key ${SECRET} for the staging box</p></body>`;
  const r = await fetchAndIngestUrl("https://example.com/leak", { localOnly: false, fetchImpl: fakeFetch(html).impl });
  check("fetched secret is redacted", r.redacted >= 1 && !anyRowContains(SECRET));
  check("redacted page is still retrievable", keywordSearch("staging box", 5).length >= 1);
}

// --- Web: dedup on a re-fetch -----------------------------------------------
{
  const html = "<title>Vectors</title><body><p>web learning about sqlite vector search and embeddings</p></body>";
  const before = countMemoryPoints();
  const r = await fetchAndIngestUrl("https://example.com/vectors", { localOnly: false, fetchImpl: fakeFetch(html).impl });
  check("re-fetched identical page is deduped", r.deduped >= 1 && countMemoryPoints() === before, `deduped=${r.deduped}`);
}

// --- Web: scheme / content-type / size guards -------------------------------
{
  const ftp = fakeFetch("nope");
  const rScheme = await fetchAndIngestUrl("ftp://example.com/file", { localOnly: false, fetchImpl: ftp.impl });
  check("non-http(s) scheme is refused", rScheme.ingested === 0 && ftp.calls() === 0 && /scheme/i.test(rScheme.reason ?? ""));

  const rType = await fetchAndIngestUrl("https://example.com/img", {
    localOnly: false,
    fetchImpl: fakeFetch("\x89PNG...", { contentType: "image/png" }).impl,
  });
  check("non-text content-type is refused", rType.ingested === 0 && /content-type/i.test(rType.reason ?? ""));

  const rBig = await fetchAndIngestUrl("https://example.com/big", {
    localOnly: false,
    maxBytes: 16,
    fetchImpl: fakeFetch("<p>" + "x".repeat(500) + "</p>").impl,
  });
  check("oversized body is refused", rBig.ingested === 0 && /exceeds/i.test(rBig.reason ?? ""));

  const r404 = await fetchAndIngestUrl("https://example.com/missing", {
    localOnly: false,
    fetchImpl: fakeFetch("nope", { status: 404 }).impl,
  });
  check("non-2xx response is refused", r404.ingested === 0 && /HTTP 404/.test(r404.reason ?? ""));
}

// --- Audit + status ---------------------------------------------------------
{
  check("ingest_log records runs", listIngestLog(50).length > 0);
  const status = ingestStatus();
  const clip = status.sources.find((s) => s.id === "clipboard");
  check("status reflects enabled source + totals", clip?.enabled === true && clip.ingestedTotal >= 1);
  check("status carries recent runs", status.recent.length > 0);
  const web = status.sources.find((s) => s.id === "web");
  check("status lists the web source with totals", !!web && web.ingestedTotal >= 1, `web total=${web?.ingestedTotal}`);
}

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
