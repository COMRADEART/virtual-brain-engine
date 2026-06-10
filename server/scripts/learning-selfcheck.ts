// Learning Lab selfcheck — gate for the learning layer (Phases A/B/C seams).
//
// Covers:
//   (A) rank_training_log round-trip + explicit-feedback retraining of the
//       online ranker (trainFromFeedback) + loss-history recording.
//   (B) the status assembly inputs: ranker state, loss history, feedback stats,
//       memory-corpus export.
//   (C) the from-scratch LLM trainer's NODE-SIDE degrade path: with no worker
//       running, getLlmTrainerStatus() reports "unavailable" and
//       startLlmTraining() fails gracefully (too-small corpus AND worker-down).
//       The actual PyTorch training is NOT exercised — the gate can't run torch
//       and an unverifiable trainer must never sit in the gate's hot path.
//
// Hermetic: temp DB via BRAIN_DB_PATH, PERCEPTION_WORKER_URL pinned at an
// unreachable port — no real DB, no network.
//
// Run: npm --prefix server run learning:selfcheck

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "brain-learncheck-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");
// Unreachable loopback port — the LLM-trainer worker probe resolves instantly
// to ECONNREFUSED, exercising the "worker down" degrade path.
process.env.PERCEPTION_WORKER_URL = "http://127.0.0.1:1";

const { openDb } = await import("../src/db/sqlite.js");
const { recordRankTrainingLog, loadRankTrainingLog, insertFeedback, getFeedbackStats } = await import(
  "../src/db/repositories/feedback.js"
);
const { loadRankerState, loadRankerLossHistory } = await import("../src/db/repositories/ranker.js");
const { trainFromCitations, trainFromFeedback, __resetRankerCache, WARM_AT } = await import(
  "../src/reasoning/ranker.js"
);
const { toFeatureVector, FEATURE_DIM, FEATURE_LABELS } = await import("../src/reasoning/rankerModel.js");
const { upsertMemoryPoint, exportMemoryCorpus } = await import("../src/db/repositories/memory.js");
const { getLlmTrainerStatus, startLlmTraining } = await import("../src/learning/llmTrainerClient.js");

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

openDb(); // apply schema (creates the new tables)

// =============================================================================
// (0) pure invariants
// =============================================================================
check("FEATURE_LABELS length matches FEATURE_DIM", FEATURE_LABELS.length === FEATURE_DIM, `${FEATURE_LABELS.length} vs ${FEATURE_DIM}`);
check("WARM_AT is a positive integer", Number.isInteger(WARM_AT) && WARM_AT > 0, `${WARM_AT}`);

// =============================================================================
// (A) rank_training_log round-trip
// =============================================================================
const fA = toFeatureVector({ vecScore: 0.9, ageDays: 1, importance: 0.8, sourceType: "conversation", hasProject: true, contentLength: 500 });
const fB = toFeatureVector({ vecScore: 0.3, ageDays: 30, importance: 0.2, sourceType: "chunk", hasProject: false, contentLength: 100 });
const features = new Map<string, number[]>([["mA", fA], ["mB", fB]]);
const cited = new Set<string>(["mA"]);

recordRankTrainingLog("run-1", features, cited);
const snap = loadRankTrainingLog("run-1");
check("rank_training_log round-trips features", !!snap && snap.featuresById.size === 2 && snap.featuresById.has("mA"));
check("rank_training_log round-trips cited set", !!snap && snap.citedIds.has("mA") && !snap.citedIds.has("mB"));
check("loadRankTrainingLog(missing) -> null", loadRankTrainingLog("nope") === null);

// =============================================================================
// (B) online ranker: citation training bumps trainedCount + records loss;
//     explicit feedback nudges weights WITHOUT bumping warm-up.
// =============================================================================
__resetRankerCache();

trainFromCitations(features, cited);
const s1 = loadRankerState();
check("trainFromCitations bumps trainedCount to 1", s1?.trainedCount === 1, `${s1?.trainedCount}`);
check("trainFromCitations moved weights off zero", !!s1 && s1.weights.some((w) => w !== 0));

trainFromCitations(features, cited);
const s2 = loadRankerState();
check("second citation train bumps trainedCount to 2", s2?.trainedCount === 2, `${s2?.trainedCount}`);

const weightsBefore = (loadRankerState()?.weights ?? []).slice();
const trainedFb = trainFromFeedback(features, cited, 1);
const s3 = loadRankerState();
check("trainFromFeedback(+1) returns true", trainedFb === true);
check("trainFromFeedback does NOT bump trainedCount (warm-up stays query-keyed)", s3?.trainedCount === 2, `${s3?.trainedCount}`);
check(
  "trainFromFeedback changed at least one weight",
  !!s3 && s3.weights.some((w, i) => w !== weightsBefore[i]),
);

check("trainFromFeedback(empty features) -> false", trainFromFeedback(new Map(), cited, 1) === false);
check("trainFromFeedback(-1, no citations) -> false", trainFromFeedback(features, new Set(), -1) === false);

const loss = loadRankerLossHistory(100);
check("loss history recorded for citation training", loss.some((p) => p.kind === "citation"), `${loss.length} points`);
check("loss history recorded for feedback training", loss.some((p) => p.kind === "feedback"));
check("loss history is oldest-first", loss.length < 2 || loss[0].createdAt <= loss[loss.length - 1].createdAt);

// =============================================================================
// (C) feedback persistence + stats
// =============================================================================
insertFeedback({ runId: "run-1", rating: 1 });
insertFeedback({ runId: "run-2", rating: -1 });
insertFeedback({ runId: "run-3", rating: 1 });
const stats = getFeedbackStats();
check("feedback stats count up votes", stats.up === 2, `up=${stats.up}`);
check("feedback stats count down votes", stats.down === 1, `down=${stats.down}`);
check("feedback stats total", stats.total === 3, `total=${stats.total}`);
check("feedback stats lastAt is set", typeof stats.lastAt === "string" && stats.lastAt.length > 0);

// =============================================================================
// (D) LLM trainer degrade path — too-small corpus, BEFORE any memories exist
// =============================================================================
const emptyCorpus = exportMemoryCorpus();
check("exportMemoryCorpus() on empty DB -> 0 chars", emptyCorpus.chars === 0 && emptyCorpus.documents === 0, `${emptyCorpus.chars}c/${emptyCorpus.documents}d`);

const tooSmall = await startLlmTraining({});
check("startLlmTraining on tiny corpus -> state 'error'", tooSmall.state === "error", `state=${tooSmall.state}`);
check("startLlmTraining 'too small' message mentions corpus", (tooSmall.message ?? "").toLowerCase().includes("corpus"), tooSmall.message ?? "");

const downStatus = await getLlmTrainerStatus();
check("getLlmTrainerStatus() with worker down -> 'unavailable'", downStatus.state === "unavailable", `state=${downStatus.state}`);
check("getLlmTrainerStatus() carries a helpful message", typeof downStatus.message === "string" && downStatus.message.length > 0);

// =============================================================================
// (E) corpus export with real memories + worker-down start path
// =============================================================================
upsertMemoryPoint({ sourceType: "conversation", content: "First memory: the brain learns to rank.", contentHash: "h1", title: "m1" });
upsertMemoryPoint({ sourceType: "chunk", content: "x".repeat(1500), contentHash: "h2", title: "big" });

const corpus = exportMemoryCorpus();
check("exportMemoryCorpus() includes both memories", corpus.documents === 2, `${corpus.documents} docs`);
check("exportMemoryCorpus() exceeds 1000 chars", corpus.chars > 1000, `${corpus.chars} chars`);
check("exportMemoryCorpus() text carries content", corpus.text.includes("the brain learns to rank"));

const capped = exportMemoryCorpus({ maxChars: 5 });
check("exportMemoryCorpus(maxChars:5) drops oversized docs", capped.documents === 0 && capped.chars === 0, `${capped.documents}d`);

const bigStart = await startLlmTraining({});
check(
  "startLlmTraining on real corpus + worker down -> 'unavailable'",
  bigStart.state === "unavailable",
  `state=${bigStart.state}`,
);

// =============================================================================
// (F) route wiring — exercise the Express handlers in-process. server-smoke
//     only sweeps GETs and the checks above call the functions directly; this
//     proves the new POST routes (feedback, llm/start) and the status GET are
//     actually mounted and wired.
// =============================================================================
const express = (await import("express")).default;
const { feedbackRouter } = await import("../src/routes/feedback.js");
const { learningRouter } = await import("../src/routes/learning.js");

const routeApp = express();
routeApp.use(express.json({ limit: "1mb" }));
routeApp.use("/api", feedbackRouter);
routeApp.use("/api", learningRouter);

const srv = await new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
  const s = routeApp.listen(0, "127.0.0.1", () => {
    const addr = s.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    resolve({ port, close: () => new Promise<void>((r) => s.close(() => r())) });
  });
});

async function call(
  path: string,
  method: "GET" | "POST",
  body?: object,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(`http://127.0.0.1:${srv.port}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json: parsed };
}

// run-1 still has the training snapshot recorded in section (A) → retrains.
const fb = await call("/api/feedback", "POST", { runId: "run-1", rating: 1 });
check("POST /api/feedback -> 200 ok", fb.status === 200 && fb.json?.ok === true, `status=${fb.status}`);
check("POST /api/feedback retrained from the snapshot", fb.json?.trained === true);

const fbBad = await call("/api/feedback", "POST", { runId: "x", rating: 2 });
check("POST /api/feedback rejects invalid rating (400)", fbBad.status === 400, `status=${fbBad.status}`);

const st = await call("/api/learning/status", "GET");
check("GET /api/learning/status -> 200", st.status === 200, `status=${st.status}`);
const stRanker = st.json?.ranker as { weights?: Array<{ label?: string }> } | undefined;
check("learning status carries ranker + feedback + llm", !!st.json?.ranker && !!st.json?.feedback && !!st.json?.llm);
check(
  "learning status ranker weights are labelled",
  Array.isArray(stRanker?.weights) &&
    stRanker.weights.length === FEATURE_DIM &&
    typeof stRanker.weights[0]?.label === "string",
);
check("learning status llm degrades to unavailable (worker down)", (st.json?.llm as { state?: string })?.state === "unavailable");

const start = await call("/api/learning/llm/start", "POST", {});
check("POST /api/learning/llm/start -> 200 with status json", start.status === 200 && typeof start.json?.state === "string");

// =============================================================================
// (G) SFT pair flywheel — a 👍 promotes the run's (prompt, answer) into a
//     durable instruction pair; a 👎 retracts it. Idempotent per run.
// =============================================================================
const { captureSftPair, retractSftPair, countSftPairs, exportSftJsonl } = await import(
  "../src/db/repositories/sft.js"
);
const db = openDb();
const nowIso = new Date().toISOString();
db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-sft', 't', ?, ?)`).run(nowIso, nowIso);
db.prepare(
  `INSERT INTO pipeline_runs (id, conversation_id, prompt, answer, status, started_at)
   VALUES ('run-sft', 'conv-sft', 'what is the auth flow?', 'Known memory: tokens expire hourly.', 'complete', ?)`,
).run(nowIso);
db.prepare(
  `INSERT INTO pipeline_runs (id, conversation_id, prompt, answer, status, started_at)
   VALUES ('run-noanswer', 'conv-sft', 'q', NULL, 'error', ?)`,
).run(nowIso);

check("captureSftPair captures a 👍 run", captureSftPair("run-sft") === true && countSftPairs() === 1);
check("captureSftPair is idempotent per run", captureSftPair("run-sft") === false && countSftPairs() === 1);
check("captureSftPair(missing run) -> false", captureSftPair("run-missing") === false);
check("captureSftPair(answerless run) -> false", captureSftPair("run-noanswer") === false);
const jsonl = exportSftJsonl();
const firstLine = JSON.parse(jsonl.split("\n")[0]) as { instruction?: string; response?: string };
check(
  "exportSftJsonl emits trainer-ready {instruction, response}",
  firstLine.instruction === "what is the auth flow?" && (firstLine.response ?? "").includes("tokens expire"),
);
check("retractSftPair removes the pair", retractSftPair("run-sft") === true && countSftPairs() === 0);

// Through the routes: 👍 captures, 👎 retracts, status + export respond.
const fbSft = await call("/api/feedback", "POST", { runId: "run-sft", rating: 1 });
check("POST /api/feedback 👍 captures an SFT pair", fbSft.status === 200 && fbSft.json?.sftCaptured === true);
const sftStatus = await call("/api/learning/sft/status", "GET");
check("GET /api/learning/sft/status counts pairs", sftStatus.status === 200 && sftStatus.json?.pairs === 1);
const fbDown = await call("/api/feedback", "POST", { runId: "run-sft", rating: -1 });
check("POST /api/feedback 👎 retracts the SFT pair", fbDown.status === 200 && countSftPairs() === 0);
const sftExport = await fetch(`http://127.0.0.1:${srv.port}/api/learning/sft/export`);
check("GET /api/learning/sft/export -> 200", sftExport.status === 200);

await srv.close();

// =============================================================================
// Same exit pattern as the other selfchecks: the stdout PASSED line is the gate
// signal; a Windows libuv teardown abort on process.exit is tolerated upstream.
// =============================================================================
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
