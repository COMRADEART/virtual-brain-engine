// GitHub project discovery selfcheck ("learn from popular repos"). HERMETIC:
// throwaway DB via BRAIN_DB_PATH (set BEFORE importing config-dependent modules),
// an INJECTED fetch (NO real network), no embeddings required. Proves the egress
// gate, the SSRF/host hardening, the search parse + stars filter, the README
// base64 learn path through the governed ingest, redaction (incl. fine-grained
// github_pat_ tokens), dedup, and the rate-limit budget.
//
// Run: npm --prefix server run github:selfcheck
//
// Asserts:
//   Source     — "github" is in INGEST_SOURCES (egress=true) + ingestStatus().
//   Egress     — under LOCAL_ONLY=true, search AND learn are blocked and the
//                injected fetch is NEVER called (zero outbound).
//   Host pin   — a poisoned owner/repo (host-changing / path-traversal) is
//                rejected BEFORE any fetch.
//   Redirect   — a 3xx is refused (redirect:"manual"; target never contacted).
//   Parse      — search JSON → repos; sub-minStars repos are filtered out.
//   Learn      — README base64 envelope is decoded, chunked, governed, stored as
//                "chunk", retrievable; no ambient consent needed.
//   Redaction  — classic ghp_ AND fine-grained github_pat_ tokens in a README are
//                absent from every persisted column; embed sees REDACTED text.
//   Dedup      — re-learning the same README stores nothing new.
//   Rate limit — a low X-RateLimit-Remaining stops the README loop early.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";

const tmp = mkdtempSync(join(tmpdir(), "brain-githubcheck-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const { openDb } = await import("../src/db/sqlite.js");
const { githubSearch, fetchRepoReadme } = await import("../src/github/discovery.js");
const { discoverAndLearn, learnRepoRef, parseRepoRef } = await import("../src/github/index.js");
const { ingestStatus } = await import("../src/ingest/index.js");
const { isConsentEnabled } = await import("../src/db/repositories/ingest.js");
const { listRecentMemories, keywordSearch, countMemoryPoints } = await import("../src/db/repositories/memory.js");
const { INGEST_SOURCES } = await import("../../shared/ingest.js");

// --- Injected fetch (NO real network) ---------------------------------------
// Routes by URL: /search/repositories → search JSON; /readme → README envelope.
// `calls` proves a blocked/short-circuited request never leaves the machine.
interface FakeResp {
  status?: number;
  body?: string;
  contentType?: string;
  rateRemaining?: string | null;
  type?: string;
}
function ghFake(router: (url: string) => FakeResp): { impl: typeof fetch; calls: () => number; urls: string[] } {
  let calls = 0;
  const urls: string[] = [];
  const impl = (async (input: unknown) => {
    calls += 1;
    const url = String(input);
    urls.push(url);
    const r = router(url);
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      type: r.type ?? "basic",
      url,
      headers: {
        get: (k: string) => {
          const key = k.toLowerCase();
          if (key === "content-type") return r.contentType ?? "application/json; charset=utf-8";
          if (key === "x-ratelimit-remaining") return r.rateRemaining ?? null;
          return null;
        },
      },
      text: async () => r.body ?? "",
    };
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls, urls };
}

function searchJson(repos: Array<{ full: string; stars: number; lang?: string; desc?: string }>): string {
  return JSON.stringify({
    total_count: repos.length,
    items: repos.map((r) => {
      const [owner, name] = r.full.split("/");
      return {
        full_name: r.full,
        name,
        owner: { login: owner },
        html_url: `https://github.com/${r.full}`,
        stargazers_count: r.stars,
        description: r.desc ?? `${name} description`,
        language: r.lang ?? "TypeScript",
        topics: ["ai", "brain"],
      };
    }),
  });
}
function readmeJson(markdown: string): string {
  return JSON.stringify({
    name: "README.md",
    path: "README.md",
    encoding: "base64",
    content: Buffer.from(markdown, "utf8").toString("base64"),
  });
}

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

openDb(); // schema + migrations

function rowText(m: { title?: string | null; content: string; metadata?: Record<string, unknown> }): string {
  return [m.title ?? "", m.content, JSON.stringify(m.metadata ?? {})].join(" ");
}
function anyRowContains(needle: string): boolean {
  return listRecentMemories(500).some((m) => rowText(m).includes(needle));
}

// --- Source registration ----------------------------------------------------
{
  const spec = INGEST_SOURCES.find((s) => s.id === "github");
  check("github source registered (egress=true)", !!spec && spec.egress === true);
  const status = ingestStatus();
  check("ingestStatus lists the github source", status.sources.some((s) => s.id === "github"));
  check("github consent is OFF by default (explicit path needs none)", isConsentEnabled("github") === false);
}

// --- Egress gate: search blocked under LOCAL_ONLY, fetch never called --------
{
  const spy = ghFake(() => ({ body: searchJson([{ full: "a/b", stars: 5000 }]) }));
  const r = await githubSearch("react", { localOnly: true, fetchImpl: spy.impl });
  check("LOCAL_ONLY blocks github search", r.ok === false && /local_only|blocked/i.test((r as { reason?: string }).reason ?? ""));
  check("blocked search is NEVER issued (zero egress)", spy.calls() === 0);
}

// --- Egress gate: learn blocked under LOCAL_ONLY, fetch never called ---------
{
  const before = countMemoryPoints();
  const spy = ghFake(() => ({ body: searchJson([{ full: "a/b", stars: 5000 }]) }));
  const r = await discoverAndLearn("react", { localOnly: true, fetchImpl: spy.impl });
  check("LOCAL_ONLY blocks github learn", r.ok === false && r.ingested === 0);
  check("blocked learn is NEVER issued (zero egress)", spy.calls() === 0);
  check("blocked learn persists nothing", countMemoryPoints() === before);
}

// --- Host pin / segment validation: poisoned owner/repo rejected pre-fetch ---
{
  const spy = ghFake(() => ({ body: readmeJson("should never be fetched") }));
  const r1 = await fetchRepoReadme("evil.com", "ok", { localOnly: false, fetchImpl: spy.impl });
  check("host-changing owner is refused", r1.ok === false && /invalid/i.test((r1 as { reason?: string }).reason ?? ""));
  const r2 = await fetchRepoReadme("ok", "../../etc/passwd", { localOnly: false, fetchImpl: spy.impl });
  check("path-traversal repo is refused", r2.ok === false);
  check("poisoned identifiers never reach fetch (zero egress)", spy.calls() === 0);
}

// --- Redirect refusal (redirect:"manual") -----------------------------------
{
  const spy = ghFake(() => ({ status: 302, body: "" }));
  const r = await githubSearch("react", { localOnly: false, fetchImpl: spy.impl });
  check("a 3xx redirect is refused", r.ok === false && /redirect/i.test((r as { reason?: string }).reason ?? ""));
}

// --- Search parse + minStars filter -----------------------------------------
{
  const spy = ghFake(() =>
    ({ body: searchJson([
      { full: "facebook/react", stars: 200000 },
      { full: "tiny/lib", stars: 500 }, // below default 1000 — must be filtered
      { full: "vuejs/core", stars: 40000 },
    ]) }),
  );
  const r = await githubSearch("react", { localOnly: false, fetchImpl: spy.impl });
  check("search succeeds with LOCAL_ONLY=false", r.ok === true);
  if (r.ok) {
    check("sub-minStars repo is filtered out", r.repos.length === 2 && r.repos.every((x) => x.stars >= 1000));
    check("repo fields parsed", r.repos[0].fullName === "facebook/react" && r.repos[0].owner === "facebook" && r.repos[0].url.includes("github.com/facebook/react"));
  }
}

// --- Learn path: base64 README decoded, chunked, governed, retrievable ------
{
  const md = "# vec-db\n\nA blazing fast vector database for embeddings and similarity search in Rust.";
  const spy = ghFake((url) =>
    url.includes("/search/repositories")
      ? { body: searchJson([{ full: "qdrant/qdrant", stars: 15000 }]) }
      : { body: readmeJson(md) },
  );
  const before = countMemoryPoints();
  const r = await discoverAndLearn("vector database", { localOnly: false, fetchImpl: spy.impl });
  check("github learn succeeds (LOCAL_ONLY=false)", r.ok === true && r.ingested >= 1, `ingested=${r.ingested}`);
  check("at least one repo learned", r.reposLearned >= 1);
  check("README base64 was decoded + stored (retrievable)", keywordSearch("vector database", 5).length >= 1);
  check("learn needs no ambient consent (command IS consent)", isConsentEnabled("github") === false);
  check("more memory persisted after learn", countMemoryPoints() > before);
  const stored = listRecentMemories(1)[0];
  check('github ingest is stored as "chunk"', stored?.sourceType === "chunk", `got ${stored?.sourceType}`);
  check("repo provenance recorded (★stars in title, ingest:github source)", anyRowContains("qdrant/qdrant") && anyRowContains("ingest:github"));
}

// --- Dedup on a re-learn ----------------------------------------------------
{
  const md = "# vec-db\n\nA blazing fast vector database for embeddings and similarity search in Rust.";
  const spy = ghFake((url) =>
    url.includes("/search/repositories")
      ? { body: searchJson([{ full: "qdrant/qdrant", stars: 15000 }]) }
      : { body: readmeJson(md) },
  );
  const before = countMemoryPoints();
  const r = await discoverAndLearn("vector database", { localOnly: false, fetchImpl: spy.impl });
  check("re-learning identical README is deduped", r.deduped >= 1 && countMemoryPoints() === before, `deduped=${r.deduped}`);
}

// --- Redaction (classic + fine-grained tokens) + embed sees redacted text ---
{
  const CLASSIC = "ghp_classicTOKEN0123456789abcdef0123";
  const FINE = "github_pat_11ABCDEFG0123456789_qwertyuiopASDFGHJKLzxcvbnm0123456789";
  const md = `# deploy\n\nSet your token to ${CLASSIC} and your fine-grained ${FINE} then run deploy here.`;
  const embedInputs: string[] = [];
  const embed = async (text: string): Promise<number[]> => {
    embedInputs.push(text);
    return [1, 2, 3]; // wrong dim on purpose → must be dropped, not thrown
  };
  const spy = ghFake((url) =>
    url.includes("/search/repositories")
      ? { body: searchJson([{ full: "acme/deployer", stars: 3000 }]) }
      : { body: readmeJson(md) },
  );
  const r = await discoverAndLearn("deploy tool", { localOnly: false, fetchImpl: spy.impl, embed });
  check("secret-bearing README is still learned", r.ingested >= 1);
  check("classic ghp_ token absent from every persisted column", !anyRowContains(CLASSIC));
  check("fine-grained github_pat_ token absent from every persisted column", !anyRowContains(FINE));
  check("embed was called on REDACTED content (no secret)", embedInputs.length > 0 && embedInputs.every((t) => !t.includes(CLASSIC) && !t.includes(FINE)));
  check("redacted README still retrievable", keywordSearch("run deploy here", 5).length >= 1);
  check("wrong-dim embedding dropped, not thrown (item still stored)", anyRowContains("acme/deployer"));
}

// --- Rate-limit budget: a low remaining stops the README loop early ---------
{
  // 3 distinct repos; each README response reports remaining=2 (< floor 5). After
  // the first repo sets lastRateRemaining, the loop breaks before repo #2.
  const spy = ghFake((url) => {
    if (url.includes("/search/repositories")) {
      return {
        body: searchJson([
          { full: "rate/one", stars: 9000 },
          { full: "rate/two", stars: 8000 },
          { full: "rate/three", stars: 7000 },
        ]),
      };
    }
    const m = url.match(/repos\/([^/]+)\/([^/]+)\/readme/);
    const name = m ? `${m[1]}/${m[2]}` : "rate/x";
    return { body: readmeJson(`# ${name}\n\nUnique readme content for ${name} about caching.`), rateRemaining: "2" };
  });
  const r = await discoverAndLearn("caching", { localOnly: false, fetchImpl: spy.impl });
  // Exactly ONE: repo #1 is learned (its README came back fine), then the low
  // remaining (2 < floor 5) it reported stops the loop before repo #2.
  check("rate-limit budget stops the loop early", r.reposLearned === 1 && /rate limit/i.test(r.reason ?? ""), `reposLearned=${r.reposLearned}, reason=${r.reason}`);
}

// --- learn-repo: ref parsing (owner/name, https, ssh, .git, garbage) --------
{
  const a = parseRepoRef("deepbeepmeep/Wan2GP");
  check("parseRepoRef owner/name", a?.owner === "deepbeepmeep" && a?.name === "Wan2GP");
  const b = parseRepoRef("https://github.com/deepbeepmeep/Wan2GP.git");
  check("parseRepoRef https URL with .git", b?.owner === "deepbeepmeep" && b?.name === "Wan2GP");
  const c = parseRepoRef("git@github.com:owner/repo.git");
  check("parseRepoRef ssh URL", c?.owner === "owner" && c?.name === "repo");
  const d = parseRepoRef("https://github.com/facebook/react/tree/main");
  check("parseRepoRef https URL with trailing path", d?.owner === "facebook" && d?.name === "react");
  check("parseRepoRef rejects a bare word", parseRepoRef("notarepo") === null);
}

// --- learn-repo: LOCAL_ONLY blocks the specific-repo path, zero egress ------
{
  const before = countMemoryPoints();
  const spy = ghFake(() => ({ body: readmeJson("# secret\n\nshould never be fetched") }));
  const r = await learnRepoRef("deepbeepmeep/Wan2GP", { localOnly: true, fetchImpl: spy.impl });
  check("LOCAL_ONLY blocks learn-repo", r.ok === false && r.ingested === 0);
  check("blocked learn-repo is NEVER issued (zero egress)", spy.calls() === 0);
  check("blocked learn-repo persists nothing", countMemoryPoints() === before);
}

// --- learn-repo: unparseable ref is refused BEFORE any network --------------
{
  const spy = ghFake(() => ({ body: readmeJson("# nope") }));
  const r = await learnRepoRef("this is not a repo", { localOnly: false, fetchImpl: spy.impl });
  check("unparseable ref refused with a reason", r.ok === false && /parse|owner\/name/i.test(r.reason ?? ""));
  check("unparseable ref never reaches the network", spy.calls() === 0);
}

// --- learn-repo: happy path learns exactly the requested repo's README ------
{
  const md = "# WanGP\n\nWan 2.x video generation for the GPU Poor — by DeepBeepMeep.";
  const spy = ghFake((url) =>
    url.includes("/search/repositories")
      ? { body: searchJson([{ full: "deepbeepmeep/Wan2GP", stars: 4200 }]) }
      : { body: readmeJson(md) },
  );
  const before = countMemoryPoints();
  const r = await learnRepoRef("https://github.com/deepbeepmeep/Wan2GP", { localOnly: false, fetchImpl: spy.impl });
  check("learn-repo succeeds (LOCAL_ONLY=false)", r.ok === true && r.ingested >= 1 && r.learned === true, `ingested=${r.ingested}`);
  check("learn-repo resolved repo identity + stars from metadata", r.repo === "deepbeepmeep/Wan2GP" && r.stars === 4200, `repo=${r.repo}, stars=${r.stars}`);
  check("learn-repo README stored + retrievable", keywordSearch("GPU Poor", 5).length >= 1);
  check("learn-repo provenance recorded (repo title + ingest:github source)", anyRowContains("deepbeepmeep/Wan2GP") && anyRowContains("ingest:github"));
  check("learn-repo persisted new memory", countMemoryPoints() > before);
}

// --- learn-repo: dedup on a re-learn of the same repo -----------------------
{
  const md = "# WanGP\n\nWan 2.x video generation for the GPU Poor — by DeepBeepMeep.";
  const spy = ghFake((url) =>
    url.includes("/search/repositories")
      ? { body: searchJson([{ full: "deepbeepmeep/Wan2GP", stars: 4200 }]) }
      : { body: readmeJson(md) },
  );
  const before = countMemoryPoints();
  const r = await learnRepoRef("deepbeepmeep/Wan2GP", { localOnly: false, fetchImpl: spy.impl });
  check("re-learning the same repo is deduped (nothing new)", r.ingested === 0 && r.deduped >= 1 && countMemoryPoints() === before, `deduped=${r.deduped}`);
}

// --- learn-repo: README still learned when metadata search can't resolve ----
{
  // Search returns OTHER repos (no exact owner/name match) → title falls back to
  // plain "owner/name" with no ★, but the README is STILL learned.
  const md = "# orphan\n\nUnique readme for the metadata-miss case about widgets.";
  const spy = ghFake((url) =>
    url.includes("/search/repositories")
      ? { body: searchJson([{ full: "someone/else", stars: 9000 }]) }
      : { body: readmeJson(md) },
  );
  const r = await learnRepoRef("lonely/orphan", { localOnly: false, fetchImpl: spy.impl });
  check("learn-repo learns README even when metadata search misses", r.ok === true && r.ingested >= 1 && r.stars === 0, `stars=${r.stars}`);
  check("metadata-miss README is retrievable", keywordSearch("about widgets", 5).length >= 1);
}

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
