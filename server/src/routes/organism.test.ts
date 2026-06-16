// Route-test scaffold (see CLAUDE.md "Plan Civil"). `server/src/routes/` had 29
// files, 0 selfchecks, 0 unit tests: server:smoke sweeps every GET endpoint, but
// the zod trust-boundary validation on the POST routes was unverified. This file
// is the hermetic pattern the rest of routes/ can copy — mount a router on a
// throwaway express app, listen on an ephemeral port, fetch, assert. No
// supertest, no network.
//
// The 400 paths need NO database: zod rejects in the handler before the organism
// singleton is ever touched. The GET happy path points openDb()'s singleton at a
// temp file via BRAIN_DB_PATH set BEFORE the dynamic import — the same idiom the
// selfchecks use, because config.ts freezes CONFIG.dbPath at module load and
// ESM top-level imports are hoisted above plain statements.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

// Throwaway DB. MUST be set before the dynamic import below so CONFIG.dbPath
// (frozen at config.ts load) points here instead of at data/brain.sqlite.
const tmpDir = mkdtempSync(join(tmpdir(), "route-test-"));
process.env.BRAIN_DATA_DIR = tmpDir;
process.env.BRAIN_DB_PATH = join(tmpDir, "test.sqlite");

const express = (await import("express")).default as typeof import("express");
const { organismRouter } = await import("./organism.js");

let server: Server | null = null;
let baseUrl = "";

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", organismRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server!.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  // Best-effort: the openDb() singleton still holds the temp SQLite file open
  // (WAL mode), so rmSync can EPERM on Windows — same idiom as
  // scripts/cluster-probe.mjs. The OS reclaims tmpdir either way.
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

// Trust-boundary input validation — the gap the GET-only server:smoke leaves.
// zod rejects before getPersistentOrganism() is called, so these need no DB.
test("POST /api/organism/goals rejects an empty title with 400 + zod error", async () => {
  const res = await post("/api/organism/goals", { title: "" }); // z.min(1) violation
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error?: unknown };
  assert.ok(body.error, "400 body should carry the zod error shape");
});

test("POST /api/organism/goals/update rejects a missing goalId with 400", async () => {
  const res = await post("/api/organism/goals/update", { progress: 0.5 }); // goalId required
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error?: unknown };
  assert.ok(body.error, "required-field violation should surface a zod error");
});

test("POST /api/organism/subbrains rejects an over-long specialization with 400", async () => {
  const res = await post("/api/organism/subbrains", {
    name: "x",
    specialization: "y".repeat(401), // z.max(400) violation
  });
  assert.equal(res.status, 400);
});

// DB-backed happy path — exercises the singleton + the throwaway DB. snapshot()
// only reads (ensureSeeds() fills defaults on a fresh DB), so it returns 200
// without any LLM, network, or prior POST.
test("GET /api/organism returns a snapshot over the throwaway DB", async () => {
  const res = await fetch(`${baseUrl}/api/organism`);
  assert.equal(res.status, 200);
  const snap = (await res.json()) as Record<string, unknown>;
  assert.ok(snap && typeof snap === "object", "snapshot should be a JSON object");
  assert.ok("state" in snap, "snapshot should carry the organism state");
});