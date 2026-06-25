// Deep Research route-test scaffold (mirrors organism.test.ts). The hermetic
// engine + the trust boundary are covered by deepresearch:selfcheck +
// actions:selfcheck; this closes the gap the GET-only server:smoke leaves on the
// POST route: zod validation, the CONFIG.deepResearchEnabled gate (403), and the
// SSE plumbing — all reachable WITHOUT injecting the engine deps, because the
// no-connector / disabled / invalid-body paths short-circuit before any
// vector/web/LLM work. Mount the router on a throwaway express app, listen on an
// ephemeral port, fetch, assert. No supertest, no network, no LLM.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

// Throwaway DB. MUST be set before the dynamic import so CONFIG.dbPath (frozen at
// config.ts load) points here instead of at data/brain.sqlite.
const tmpDir = mkdtempSync(join(tmpdir(), "route-research-"));
process.env.BRAIN_DATA_DIR = tmpDir;
process.env.BRAIN_DB_PATH = join(tmpDir, "test.sqlite");

const express = (await import("express")).default as typeof import("express");
const { researchRouter } = await import("./research.js");
const { openDb } = await import("../db/sqlite.js");
const { CONFIG } = await import("../config.js");

let server: Server | null = null;
let baseUrl = "";

before(async () => {
  // Open the singleton + apply schema.sql + migrations before any handler
  // touches the DB (getDefaultConnectorInstance reads the connectors table).
  openDb();
  const app = express();
  app.use(express.json());
  app.use("/api", researchRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server!.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* open DB handle blocks deletion on Windows; tmpdir is OS-managed */
  }
});

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// zod rejects before CONFIG or the engine is touched — needs no DB work.
test("POST /api/research/deep rejects a missing question with 400 + zod error", async () => {
  const res = await post("/api/research/deep", {}); // question is required
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error?: unknown };
  assert.ok(body.error, "400 body should carry the zod error shape");
});

test("POST /api/research/deep rejects an over-long question with 400", async () => {
  const res = await post("/api/research/deep", { question: "x".repeat(4001) }); // z.max(4000)
  assert.equal(res.status, 400);
});

// The CONFIG gate: a disabled brain returns 403 JSON, never reaching the engine
// or any connector. CONFIG is mutable in place (the runtime-settings layer
// relies on that), so toggle it for this test and restore.
test("POST /api/research/deep returns 403 when DEEP_RESEARCH_ENABLED is false", async () => {
  const wasEnabled = CONFIG.deepResearchEnabled;
  CONFIG.deepResearchEnabled = false;
  try {
    const res = await post("/api/research/deep", { question: "how does X work" });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? "", /disabled/i, "403 body should name the disabled flag");
  } finally {
    CONFIG.deepResearchEnabled = wasEnabled;
  }
});

// SSE happy path to the connector check: enabled + a throwaway DB with NO default
// connector → the route streams an `error` frame (no chat model) then a `done`
// frame, WITHOUT touching vector search / webResearch / the LLM. Proves the SSE
// plumbing + header + the engine's no-model graceful degrade end-to-end.
test("POST /api/research/deep streams an SSE error + done when no chat model is configured", async () => {
  assert.ok(CONFIG.deepResearchEnabled, "default should be enabled for this path");
  const res = await post("/api/research/deep", { question: "how does X work" });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/, "SSE content-type");
  const body = await res.text();
  assert.match(body, /event: error/, "should emit an error SSE frame");
  assert.match(body, /no chat model/, "error detail should name the missing model");
  assert.match(body, /event: done/, "should terminate with a done frame");
});