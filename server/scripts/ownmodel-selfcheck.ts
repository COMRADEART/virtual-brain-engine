// Own-model selfcheck — gate for the brain's OWN-model layer (Learning Lab —
// Phase D). The brain's own LoRA-continued-pretrained model, served via Ollama.
//
// Covers the NODE-SIDE seams only — the actual PyTorch training + `ollama create`
// are NEVER exercised here (the gate can't run torch and an unverifiable trainer
// must not sit in the hot path; the live run is the runtime check):
//   (A) worker-down degrade: getOwnModelStatus() -> "unavailable".
//   (B) corpus guard: startOwnModelTraining() on a tiny corpus -> "error".
//   (C) real corpus + worker down -> "unavailable" (start path reaches the worker).
//   (D) serve guard: serveOwnModel() refuses when no finished model exists — it
//       must NOT shell out to `ollama create` (proves the state gate holds).
//   (E) connector seed: ensureOwnModelConnector() seeds disabled + non-default,
//       is idempotent, preserves a user's enable choice, refreshes the model.
//   (F) route wiring: the three /api/learning/ownmodel/* handlers are mounted.
//
// Hermetic: temp DB via BRAIN_DB_PATH, PERCEPTION_WORKER_URL pinned at an
// unreachable port — no real DB, no network, no torch, no ollama.
//
// Run: npm --prefix server run ownmodel:selfcheck

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "brain-ownmodelcheck-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");
// Unreachable loopback port — the worker probe resolves instantly to
// ECONNREFUSED, exercising the "worker down" degrade path.
process.env.PERCEPTION_WORKER_URL = "http://127.0.0.1:1";

const { openDb } = await import("../src/db/sqlite.js");
const { upsertMemoryPoint, exportMemoryCorpus } = await import("../src/db/repositories/memory.js");
const { getConnector, upsertConnector } = await import("../src/db/repositories/connectors.js");
const { ensureOwnModelConnector } = await import("../src/connectors/registry.js");
const { getOwnModelStatus, startOwnModelTraining, serveOwnModel } = await import(
  "../src/learning/ownModelClient.js"
);

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

openDb(); // apply schema

// =============================================================================
// (A) worker-down status degrade
// =============================================================================
const down = await getOwnModelStatus();
check("getOwnModelStatus() with worker down -> 'unavailable'", down.state === "unavailable", `state=${down.state}`);
check("getOwnModelStatus() carries a helpful message", typeof down.message === "string" && down.message.length > 0);
check("worker-down status fields normalised (served=false)", down.served === false && down.outputDir === null);

// =============================================================================
// (B) tiny-corpus guard (empty DB)
// =============================================================================
const empty = exportMemoryCorpus();
check("exportMemoryCorpus() on empty DB -> 0 chars", empty.chars === 0 && empty.documents === 0, `${empty.chars}c`);

const tooSmall = await startOwnModelTraining({});
check("startOwnModelTraining on tiny corpus -> 'error'", tooSmall.state === "error", `state=${tooSmall.state}`);
check(
  "tiny-corpus message mentions corpus",
  (tooSmall.message ?? "").toLowerCase().includes("corpus"),
  tooSmall.message ?? "",
);
check("tiny-corpus status reports corpusChars", tooSmall.corpusChars === 0, `${tooSmall.corpusChars}`);

// =============================================================================
// (C) real corpus + worker down -> reaches the worker, degrades to unavailable
// =============================================================================
upsertMemoryPoint({ sourceType: "conversation", content: "The brain prefers truth over agreement.", contentHash: "o1", title: "principle" });
upsertMemoryPoint({ sourceType: "chunk", content: "y".repeat(1500), contentHash: "o2", title: "bulk" });

const corpus = exportMemoryCorpus();
check("exportMemoryCorpus() exceeds 1000 chars with real memories", corpus.chars > 1000, `${corpus.chars} chars`);

const realStart = await startOwnModelTraining({});
check(
  "startOwnModelTraining on real corpus + worker down -> 'unavailable'",
  realStart.state === "unavailable",
  `state=${realStart.state}`,
);

// pass-through options don't crash assembly
const optStart = await startOwnModelTraining({ steps: 50, baseModel: "Qwen/Qwen2.5-0.5B" });
check("startOwnModelTraining with steps+baseModel still degrades cleanly", optStart.state === "unavailable", `state=${optStart.state}`);

// =============================================================================
// (D) serve guard — refuses when no finished model exists, never shells out
// =============================================================================
const served = await serveOwnModel();
check("serveOwnModel() with no finished model does NOT report served", served.served === false, `served=${served.served}`);
check("serveOwnModel() left no own-model connector behind", getConnector("own-model") === null);

// =============================================================================
// (E) connector seed — disabled + non-default, idempotent, preserves choice
// =============================================================================
const seeded = ensureOwnModelConnector("star-brain");
check("ensureOwnModelConnector seeds the model name", seeded.model === "star-brain", `${seeded.model}`);
check("ensureOwnModelConnector is local Ollama kind", seeded.kind === "ollama" && seeded.isLocal === true);
check("ensureOwnModelConnector seeds DISABLED", seeded.enabled === false);
check("ensureOwnModelConnector seeds NON-default", seeded.isDefault !== true);
check("ensureOwnModelConnector has no embeddingModel (retrieval stays on nomic)", !seeded.embeddingModel);

// user opts in: enable it
upsertConnector({
  id: "own-model",
  name: seeded.name,
  kind: "ollama",
  baseUrl: seeded.baseUrl,
  model: seeded.model,
  embeddingModel: undefined,
  enabled: true,
  isDefault: false,
});
// re-seed with a new model name (e.g. retrained) — must preserve the enable choice
const reseeded = ensureOwnModelConnector("star-brain-v2");
check("re-seed preserves user's enabled choice", reseeded.enabled === true);
check("re-seed refreshes the model name", reseeded.model === "star-brain-v2", `${reseeded.model}`);
check("re-seed stays non-default", reseeded.isDefault !== true);

// =============================================================================
// (F) route wiring — exercise the Express handlers in-process
// =============================================================================
const express = (await import("express")).default;
const { learningRouter } = await import("../src/routes/learning.js");

const routeApp = express();
routeApp.use(express.json({ limit: "1mb" }));
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

const st = await call("/api/learning/ownmodel/status", "GET");
check("GET /api/learning/ownmodel/status -> 200 with state", st.status === 200 && typeof st.json?.state === "string", `status=${st.status}`);

const start = await call("/api/learning/ownmodel/start", "POST", {});
check("POST /api/learning/ownmodel/start -> 200 with state", start.status === 200 && typeof start.json?.state === "string");

const startBad = await call("/api/learning/ownmodel/start", "POST", { steps: -5 });
check("POST /api/learning/ownmodel/start rejects bad steps (400)", startBad.status === 400, `status=${startBad.status}`);

const serve = await call("/api/learning/ownmodel/serve", "POST", {});
check("POST /api/learning/ownmodel/serve -> 200 with state", serve.status === 200 && typeof serve.json?.state === "string");

await srv.close();

// =============================================================================
// Same exit pattern as the other selfchecks: the stdout PASSED line is the gate
// signal; a Windows libuv teardown abort on process.exit is tolerated upstream.
// =============================================================================
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
