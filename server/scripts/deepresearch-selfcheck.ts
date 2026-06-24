// Deep Research selfcheck. HERMETIC: the engine takes every side effect as an
// INJECTED dep, so this drives the REAL runDeepResearch loop with fakes — NO
// network, NO DB, NO LLM. A throwaway BRAIN_DB_PATH + pinned LOCAL_ONLY keep the
// imported config deterministic even though the engine never touches the DB.
//
// Proves: plan decomposition (+ garbage→fallback), the multi-round loop (budget vs
// early convergence), citation-marker validation strips hallucinated ids from BOTH
// findings and the final report, the LOCAL_ONLY gate (true → webResearch never
// invoked, report degrades to local; false → web reached + web-origin sources),
// the report is persisted with deep-research provenance, RRF/reranker reuse, and
// failure isolation (a throwing model never throws out of the loop).
//
// Run: npm --prefix server run deepresearch:selfcheck

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "brain-dresearchcheck-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");
process.env.LOCAL_ONLY = "true";

const { runDeepResearch } = await import("../src/reasoning/deepResearch.js");
const { validateMarkers, extractMarkerIds } = await import("../src/reasoning/citations.js");
const { UNTRUSTED_BEGIN, UNTRUSTED_END } = await import("../src/reasoning/untrusted.js");
type DeepResearchDeps = import("../src/reasoning/deepResearch.js").DeepResearchDeps;
type DeepResearchEvent = import("../../shared/research.js").DeepResearchEvent;
type DeepResearchReport = import("../../shared/research.js").DeepResearchReport;
type MemoryPoint = import("../../shared/memory.js").MemoryPoint;
type VectorSearchHit = import("../src/db/repositories/memory.js").VectorSearchHit;
type MemoryUpsertInput = import("../src/db/repositories/memory.js").MemoryUpsertInput;

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

// --- Fakes ------------------------------------------------------------------
function mem(id: string, content: string, meta?: Record<string, unknown>): MemoryPoint {
  return {
    id,
    sourceType: "chunk",
    title: `Title ${id}`,
    content,
    contentHash: `hash-${id}`,
    embeddingId: 1,
    importance: 0.5,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    metadata: meta,
  } as unknown as MemoryPoint;
}
const A = mem("AAA111", "local doc A about the topic");
const B = mem("BBB222", "local doc B, the cross-cutting one");
const C = mem("CCC333", "local doc C");
const D = mem("DDD444", "local doc D");
const WEB = mem("WEB999", "a freshly learned web page", { source: "ingest:web", sourcePath: "https://example.com/x" });

// Three canned result lists. B appears in lists 0 AND 1 → RRF must rank it first.
const LISTS: VectorSearchHit[][] = [
  [{ memory: A, score: 0.9 }, { memory: B, score: 0.8 }],
  [{ memory: B, score: 0.85 }, { memory: C, score: 0.7 }],
  [{ memory: C, score: 0.6 }, { memory: D, score: 0.5 }],
];

interface FakeOpts {
  converge: boolean;
  gaps: string[];
  bogusCite: boolean;
  localOnly: boolean;
  planGarbage?: boolean;
  throwAll?: boolean;
}

function makeDeps(opts: FakeOpts): {
  deps: DeepResearchDeps;
  webCalls: () => number;
  upserts: () => MemoryUpsertInput[];
  synthPrompts: () => string[];
} {
  let vsCall = 0;
  let webCalls = 0;
  const upserts: MemoryUpsertInput[] = [];
  const synthPrompts: string[] = [];

  const generate = async (system: string, _user: string): Promise<string> => {
    if (opts.throwAll) throw new Error("model exploded");
    if (system.includes("research planner")) {
      return opts.planGarbage
        ? "sorry, not valid json here"
        : JSON.stringify(["what is X", "how does X work", "tradeoffs of X", "examples of X"]);
    }
    if (system.includes("alternative search queries")) {
      return JSON.stringify(["X alt one", "X alt two"]);
    }
    if (system.includes("research analyst")) {
      synthPrompts.push(_user);
      const realId = (_user.match(/\[m:([A-Za-z0-9]+)\]/) ?? [])[1] ?? "NONE";
      return `Answer grounded in sources [m:${realId}]${opts.bogusCite ? " plus a fake [m:BOGUSID999]" : ""}.`;
    }
    if (system.includes("research completeness")) {
      return JSON.stringify({ converged: opts.converge, gaps: opts.converge ? [] : opts.gaps });
    }
    if (system.includes("final research report")) {
      return "## Summary\n\nFallback report.\n\n## Open questions\n\n- none";
    }
    return "[]";
  };

  const stream = async function* (_system: string, user: string): AsyncIterable<string> {
    if (opts.throwAll) throw new Error("stream exploded");
    const id = (user.match(/\[m:([A-Za-z0-9]+)\]/) ?? [])[1] ?? "NONE";
    yield "## Summary\n\n";
    yield `Synthesis across the findings [m:${id}] `;
    yield "and a hallucinated [m:REPORTBOGUS].\n\n";
    yield "## Open questions\n\n- a follow up";
  };

  const deps: DeepResearchDeps = {
    generate,
    stream,
    embed: async () => [0.01, 0.02, 0.03],
    vectorSearch: async () => LISTS[vsCall++ % LISTS.length].map((h) => ({ ...h })),
    webResearch: async (_q, o) => {
      webCalls += 1;
      if (o.localOnly) return { ok: false, provider: null, query: _q, results: [], hits: [], ingested: 0, deduped: 0, reason: "blocked" };
      return { ok: true, provider: "brave", query: _q, results: [], hits: [{ memory: WEB, score: 0.6 }], ingested: 1, deduped: 0 };
    },
    rerankerState: null,
    localOnly: opts.localOnly,
    upsert: (input) => {
      upserts.push(input);
      return mem("REPORTMEM1", input.content, input.metadata);
    },
  };
  return { deps, webCalls: () => webCalls, upserts: () => upserts, synthPrompts: () => synthPrompts };
}

async function run(opts: FakeOpts, runOpts: { maxRounds?: number; breadth?: number; maxPages?: number } = {}): Promise<{
  report: DeepResearchReport;
  events: DeepResearchEvent[];
  webCalls: () => number;
  upserts: () => MemoryUpsertInput[];
  synthPrompts: () => string[];
}> {
  const { deps, webCalls, upserts, synthPrompts } = makeDeps(opts);
  const events: DeepResearchEvent[] = [];
  const report = await runDeepResearch("How does X work and what are its tradeoffs?", deps, runOpts, (ev) => events.push(ev));
  return { report, events, webCalls, upserts, synthPrompts };
}

// ============================================================================
// 1. Plan decomposition (+ garbage → fallback)
// ============================================================================
{
  const { events } = await run({ converge: true, gaps: [], bogusCite: false, localOnly: true }, { maxRounds: 2, breadth: 4 });
  const plan = events.find((e) => e.type === "plan");
  check("plan decomposes into >= 2 sub-questions", plan?.type === "plan" && plan.subQuestions.length >= 2, `${plan?.type === "plan" ? plan.subQuestions.length : 0}`);
}
{
  const { events } = await run({ converge: true, gaps: [], bogusCite: false, localOnly: true, planGarbage: true }, { maxRounds: 1, breadth: 4 });
  const plan = events.find((e) => e.type === "plan");
  check("garbage planner → falls back to the original question (failure-isolated)", plan?.type === "plan" && plan.subQuestions.length >= 1);
}

// ============================================================================
// 2. Multi-round loop: budget vs early convergence
// ============================================================================
{
  const { events, report } = await run({ converge: false, gaps: ["deeper gap one", "deeper gap two"], bogusCite: false, localOnly: true }, { maxRounds: 3, breadth: 3 });
  const planCount = events.filter((e) => e.type === "plan").length;
  check("non-converging reflect runs the full round budget (3 rounds)", planCount === 3, `rounds=${planCount}`);
  check("report.rounds reflects the budget", report.rounds === 3);
}
{
  const { events, report } = await run({ converge: true, gaps: [], bogusCite: false, localOnly: true }, { maxRounds: 3, breadth: 3 });
  const planCount = events.filter((e) => e.type === "plan").length;
  check("converged reflect stops early (1 round)", planCount === 1 && report.converged === true && report.rounds === 1, `rounds=${planCount}`);
}

// ============================================================================
// 3. Citation validation strips hallucinated ids (findings + report)
// ============================================================================
{
  const { report, events } = await run({ converge: true, gaps: [], bogusCite: true, localOnly: true }, { maxRounds: 1, breadth: 2 });
  const synth = events.find((e) => e.type === "synthesize");
  const findingClean = synth?.type === "synthesize" && !synth.finding.summary.includes("BOGUSID999");
  check("finding strips a hallucinated [m:BOGUSID999]", Boolean(findingClean));
  check("report strips the hallucinated [m:REPORTBOGUS]", !report.report.includes("REPORTBOGUS"));
  const knownIds = new Set(report.sources.map((s) => s.memoryId));
  check("every surviving marker in the report is a real gathered source", extractMarkerIds(report.report).every((id) => knownIds.has(id)));
  check("report streamed token deltas (report-delta emitted)", events.some((e) => e.type === "report-delta"));
}
// direct unit assertions on the extracted helper (its first-ever coverage)
{
  const out = validateMarkers("Known memory: a [m:GOOD] b [m:BAD]\nUncertain: ", new Set(["GOOD"]));
  check("validateMarkers keeps a known marker", out.includes("[m:GOOD]"));
  check("validateMarkers strips an unknown marker", !out.includes("[m:BAD]"));
  check("validateMarkers notes the strip in Uncertain", /unknown memory marker/i.test(out));
  check("extractMarkerIds reads both ids", extractMarkerIds("[m:AA] x [m:BB]").join(",") === "AA,BB");
}

// ============================================================================
// 4. LOCAL_ONLY gate — true blocks web + degrades to local
// ============================================================================
{
  const { events, webCalls, report } = await run({ converge: true, gaps: [], bogusCite: false, localOnly: true }, { maxRounds: 1, breadth: 2 });
  check("LOCAL_ONLY=true → webResearch never invoked", webCalls() === 0);
  const gathers = events.filter((e) => e.type === "gather");
  check("LOCAL_ONLY=true → every gather has 0 web hits", gathers.every((g) => g.type === "gather" && g.webHits === 0));
  check("LOCAL_ONLY=true → report still produced from local sources", report.sources.length >= 1 && report.localOnly === true);
  check("LOCAL_ONLY=true → no web-origin sources", report.sources.every((s) => s.origin === "local"));
}

// ============================================================================
// 5. LOCAL_ONLY=false → web reached + web-origin sources surface
// ============================================================================
{
  const { events, webCalls, report, synthPrompts } = await run({ converge: true, gaps: [], bogusCite: false, localOnly: false }, { maxRounds: 1, breadth: 2 });
  check("LOCAL_ONLY=false → webResearch invoked", webCalls() >= 1);
  const gathers = events.filter((e) => e.type === "gather");
  check("LOCAL_ONLY=false → a gather reports web hits + provider", gathers.some((g) => g.type === "gather" && g.webHits >= 1 && g.provider === "brave"));
  check("LOCAL_ONLY=false → a web-origin source appears in the report", report.sources.some((s) => s.origin === "web" && s.url === "https://example.com/x"));
  // Injection fencing (Phase A): a web-learned memory replayed into the synth
  // prompt must be fenced as untrusted quoted DATA, never raw text.
  const fencedWeb = synthPrompts().some((p) => p.includes("WEB999") && p.includes(UNTRUSTED_BEGIN) && p.includes(UNTRUSTED_END));
  check("web memory fenced in synthesis prompt (not raw)", fencedWeb, `${synthPrompts().length} synth prompts`);
}

// ============================================================================
// 6. Report persisted with deep-research provenance
// ============================================================================
{
  const { report, upserts } = await run({ converge: true, gaps: [], bogusCite: false, localOnly: true }, { maxRounds: 1, breadth: 2 });
  const rows = upserts();
  const row = rows[0];
  check("report persisted exactly once", rows.length === 1);
  check("persisted as manual + deep-research provenance", row?.sourceType === "manual" && (row?.metadata as Record<string, unknown>)?.source === "deep-research");
  check("persisted content is non-empty", typeof row?.content === "string" && row.content.length > 0);
  check("reportMemoryId is set to the persisted id", report.reportMemoryId === "REPORTMEM1");
}

// ============================================================================
// 7. RRF / reranker reuse — the doc found by two variants ranks first
// ============================================================================
{
  const { events } = await run({ converge: true, gaps: [], bogusCite: false, localOnly: true }, { maxRounds: 1, breadth: 1 });
  const gather = events.find((e) => e.type === "gather");
  check("RRF ranks the doubly-found doc (B) first in the fused set", gather?.type === "gather" && gather.sources[0]?.memoryId === "BBB222", gather?.type === "gather" ? gather.sources.map((s) => s.memoryId).join(",") : "");
}

// ============================================================================
// 8. Failure isolation — a throwing model never throws out of the loop
// ============================================================================
{
  let threw = false;
  let report: DeepResearchReport | undefined;
  try {
    const r = await run({ converge: true, gaps: [], bogusCite: false, localOnly: true, throwAll: true }, { maxRounds: 2, breadth: 2 });
    report = r.report;
  } catch {
    threw = true;
  }
  check("a throwing model never throws out of runDeepResearch", threw === false && report !== undefined);
  check("failure-isolated run still returns a report object", Boolean(report && typeof report.report === "string"));
}

try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
