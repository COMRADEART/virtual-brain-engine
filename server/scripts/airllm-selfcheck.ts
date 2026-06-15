// AirLLM selfcheck — gate for the high-parameter inference + distillation layer.
//
// AirLLM runs a LARGE model on a small GPU via layer-by-layer offloading. Covers
// the NODE-SIDE seams ONLY — the actual layer-by-layer inference + the worker's
// torch/airllm path are NEVER exercised here (the gate can't run torch; the live
// run is the runtime check):
//   (A) worker-down degrade: getAirllmStatus() -> "unavailable" + message.
//   (B) worker-down generate: generateWithAirllm() -> { ok:false, error }.
//   (C) clampGenerateOptions (pure): token cap/floor/default, prompt truncation,
//       model + compression defaults from CONFIG, pass-through.
//   (D) empty-prompt guard: generateWithAirllm() refuses BEFORE reaching the worker.
//   (E) distill threading: startOwnModelTraining({distill}) reaches the worker +
//       degrades cleanly (the corpus is assembled with the distill flag set).
//   (F) route wiring: the airllm status/generate handlers + the distill-extended
//       ownmodel/start schema are mounted and validate.
//
// Hermetic: temp DB via BRAIN_DB_PATH, PERCEPTION_WORKER_URL pinned at an
// unreachable port — no real DB, no network, no torch, no airllm.
//
// Run: npm --prefix server run airllm:selfcheck

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "brain-airllmcheck-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");
// Unreachable loopback port — the worker probe resolves instantly to
// ECONNREFUSED, exercising the "worker down" degrade path.
process.env.PERCEPTION_WORKER_URL = "http://127.0.0.1:1";

const { openDb } = await import("../src/db/sqlite.js");
const { upsertMemoryPoint } = await import("../src/db/repositories/memory.js");
const { CONFIG } = await import("../src/config.js");
const { getAirllmStatus, generateWithAirllm, clampGenerateOptions } = await import(
  "../src/learning/airllmClient.js"
);
const { startOwnModelTraining } = await import("../src/learning/ownModelClient.js");

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

openDb(); // apply schema

// =============================================================================
// (A) worker-down status degrade
// =============================================================================
const down = await getAirllmStatus();
check("getAirllmStatus() with worker down -> 'unavailable'", down.state === "unavailable", `state=${down.state}`);
check("getAirllmStatus() carries a helpful message", typeof down.message === "string" && down.message.length > 0);
check("worker-down status fields normalised (model=null)", down.model === null && down.device === null);

// =============================================================================
// (B) worker-down generate degrade
// =============================================================================
const gen = await generateWithAirllm({ prompt: "hello high-parameter brain" });
check("generateWithAirllm() with worker down -> ok:false", gen.ok === false, `ok=${gen.ok}`);
check("generateWithAirllm() carries an error string", typeof gen.error === "string" && (gen.error ?? "").length > 0);
check("generateWithAirllm() worker-down result has null text", gen.text === null);

// =============================================================================
// (C) clampGenerateOptions — pure guard rails + CONFIG defaults
// =============================================================================
const capped = clampGenerateOptions({ prompt: "x", maxNewTokens: 999_999 });
check("clampGenerateOptions caps maxNewTokens at 2048", capped.maxNewTokens === 2048, `${capped.maxNewTokens}`);
const floored = clampGenerateOptions({ prompt: "x", maxNewTokens: 0 });
check("clampGenerateOptions floors maxNewTokens at 1", floored.maxNewTokens === 1, `${floored.maxNewTokens}`);
const defaulted = clampGenerateOptions({ prompt: "x" });
check("clampGenerateOptions defaults maxNewTokens to 256", defaulted.maxNewTokens === 256, `${defaulted.maxNewTokens}`);
check(
  "clampGenerateOptions defaults model to CONFIG.airllmTeacherModel",
  defaulted.model === CONFIG.airllmTeacherModel,
  defaulted.model,
);
check(
  "clampGenerateOptions defaults compression to CONFIG.airllmCompression",
  defaulted.compression === CONFIG.airllmCompression,
  defaulted.compression,
);
const longPrompt = clampGenerateOptions({ prompt: "y".repeat(20_000) });
check("clampGenerateOptions truncates the prompt to 8000 chars", longPrompt.prompt.length === 8000, `${longPrompt.prompt.length}`);
const passthrough = clampGenerateOptions({ prompt: "q", model: "Qwen/Qwen2.5-14B-Instruct", compression: "8bit" });
check("clampGenerateOptions passes an explicit model through", passthrough.model === "Qwen/Qwen2.5-14B-Instruct");
check("clampGenerateOptions passes an explicit compression through", passthrough.compression === "8bit");

// =============================================================================
// (D) empty-prompt guard — refuses before any network call
// =============================================================================
const empty = await generateWithAirllm({ prompt: "   " });
check("generateWithAirllm() on a blank prompt -> ok:false", empty.ok === false, `ok=${empty.ok}`);
check("blank-prompt error mentions empty", (empty.error ?? "").toLowerCase().includes("empty"), empty.error ?? "");

// =============================================================================
// (E) distill threading — start with a real corpus + worker down degrades clean
// =============================================================================
upsertMemoryPoint({ sourceType: "conversation", content: "The brain prefers truth over agreement.", contentHash: "a1", title: "principle" });
upsertMemoryPoint({ sourceType: "chunk", content: "z".repeat(1500), contentHash: "a2", title: "bulk" });

const distillStart = await startOwnModelTraining({ distill: true, teacherModel: "Qwen/Qwen2.5-14B-Instruct" });
check(
  "startOwnModelTraining({distill:true,teacherModel}) + worker down -> 'unavailable'",
  distillStart.state === "unavailable",
  `state=${distillStart.state}`,
);
const distillDefault = await startOwnModelTraining({ distill: true });
check(
  "startOwnModelTraining({distill:true}) (default teacher) degrades cleanly",
  distillDefault.state === "unavailable",
  `state=${distillDefault.state}`,
);

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

const st = await call("/api/learning/airllm/status", "GET");
check("GET /api/learning/airllm/status -> 200 with state", st.status === 200 && typeof st.json?.state === "string", `status=${st.status}`);

const genOk = await call("/api/learning/airllm/generate", "POST", { prompt: "hi" });
check("POST /api/learning/airllm/generate (valid) -> 200 with ok field", genOk.status === 200 && typeof genOk.json?.ok === "boolean", `status=${genOk.status}`);

const genEmpty = await call("/api/learning/airllm/generate", "POST", { prompt: "" });
check("POST /api/learning/airllm/generate rejects empty prompt (400)", genEmpty.status === 400, `status=${genEmpty.status}`);

const genBigTokens = await call("/api/learning/airllm/generate", "POST", { prompt: "hi", maxNewTokens: 5000 });
check("POST /api/learning/airllm/generate rejects out-of-range maxNewTokens (400)", genBigTokens.status === 400, `status=${genBigTokens.status}`);

const genBadComp = await call("/api/learning/airllm/generate", "POST", { prompt: "hi", compression: "16bit" });
check("POST /api/learning/airllm/generate rejects an unknown compression (400)", genBadComp.status === 400, `status=${genBadComp.status}`);

const startDistill = await call("/api/learning/ownmodel/start", "POST", { distill: true });
check("POST /api/learning/ownmodel/start accepts {distill:true} (200)", startDistill.status === 200 && typeof startDistill.json?.state === "string", `status=${startDistill.status}`);

const startBadDistill = await call("/api/learning/ownmodel/start", "POST", { distill: "yes" });
check("POST /api/learning/ownmodel/start rejects a non-boolean distill (400)", startBadDistill.status === 400, `status=${startBadDistill.status}`);

await srv.close();

// =============================================================================
// Same exit pattern as the other selfchecks: the stdout PASSED line is the gate
// signal; a Windows libuv teardown abort on process.exit is tolerated upstream.
// =============================================================================
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
