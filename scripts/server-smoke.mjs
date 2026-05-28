// Backend smoke gate: boots the server via the watch-free `start:server`
// entrypoint, waits for /api/health, asserts the DB / vector / locality
// contract, then sweeps EVERY read-only GET endpoint across every mounted
// router to prove the whole HTTP surface is crash-free, then tears the process
// tree down.
//
// This is the runtime check scripts/gate.mjs was missing: the gate only
// typechecks + runs selfchecks (throwaway temp DBs) + unit tests — it boots
// NOTHING. That is how a dead-on-boot server and 500s shipped behind a fully
// green gate. A live LLM is NOT required here: the 7-step /api/ask pipeline
// needs Ollama and is covered separately by scripts/ask-smoke.mjs; health and
// the GET surface degrade gracefully without it.
//
// It also guards against the M2 regression: `start:server` must be the
// watch-free launch (nested `tsx watch` did not bind under non-interactive
// spawn). If this gate hangs at "waiting for /api/health", that contract broke.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = process.env.SMOKE_PORT ?? "8799";
const BASE = `http://127.0.0.1:${PORT}`;
const READY_TIMEOUT_MS = 45_000;
const IS_WINDOWS = process.platform === "win32";
const NPM_CMD = IS_WINDOWS ? "npm.cmd" : "npm";

// Known-good non-2xx responses (NOT bugs). /vision/config 404 is intended
// Tauri-first-stub behavior — server/src/vision/*.ts return null/empty on Node;
// real vision lives in the desktop shell.
const EXPECTED_NON_2XX = { "/vision/config": 404 };

// Every read-only GET endpoint. A 500 on any of these is a gate-invisible bug.
const STATIC_GET_PATHS = [
  "/health",
  "/memory/recent?limit=5",
  "/memory/search?q=brain",
  "/memory/lifecycle/stats",
  "/scan/roots",
  "/scan/state",
  "/connectors",
  "/connectors/discover",
  "/conversations",
  "/twin", "/twin/snapshots", "/twin/anomalies",
  "/swarm",
  "/imagination",
  "/evolution",
  "/organism",
  "/vision/memories", "/vision/workflows", "/vision/stats", "/vision/monitors", "/vision/config",
  "/perceive/status",
  "/phase2/status", "/phase2/workflows", "/phase2/pet", "/phase2/autonomous/due",
  "/civilization/status", "/civilization/peers", "/civilization/graph", "/civilization/trust",
  "/civilization/map", "/civilization/goals", "/civilization/groups",
  "/civilization/governance/proposals", "/civilization/culture/practices",
  "/civilization/culture/evolution", "/civilization/roles", "/civilization/memory",
  "/civilization/resources/prices", "/civilization/resources/offers",
  "/civilization/visualization/snapshot",
];

async function probeHealth() {
  try {
    const res = await fetch(`${BASE}/api/health`, { method: "GET" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function waitForHealth() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const h = await probeHealth();
    if (h) return h;
    await delay(500);
  }
  throw new Error(
    `server never answered /api/health at ${BASE} within ${READY_TIMEOUT_MS}ms ` +
      `(M2 regression? start:server must be watch-free)`,
  );
}

async function getJson(path) {
  try {
    const r = await fetch(`${BASE}/api${path}`);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

// Resolve a path id from a list endpoint so the /:id routes get exercised when
// data exists (skipped cleanly on a fresh/empty DB).
async function firstId(path, pick) {
  const j = await getJson(path);
  return j ? pick(j) : null;
}

async function sweepGetEndpoints() {
  const memId = await firstId("/memory/recent?limit=1", (j) => j.memories?.[0]?.id ?? (Array.isArray(j) ? j[0]?.id : null));
  const convId = await firstId("/conversations", (j) => j.conversations?.[0]?.id ?? null);
  const visId = await firstId("/vision/memories?limit=1", (j) => j.memories?.[0]?.id ?? (Array.isArray(j) ? j[0]?.id : null));
  console.log(`[server:smoke] resolved ids: memory=${memId ?? "—"} conversation=${convId ?? "—"} vision=${visId ?? "—"}`);

  const paths = [...STATIC_GET_PATHS];
  if (memId) paths.push(`/memory/${memId}`);
  if (convId) paths.push(`/conversations/${convId}`);
  if (visId) paths.push(`/vision/memories/${visId}`);

  const failures = [];
  for (const p of paths) {
    const bare = p.split("?")[0];
    let status = 0;
    let note = "";
    try {
      const r = await fetch(`${BASE}/api${p}`, { headers: { Accept: "application/json" } });
      status = r.status;
      const body = await r.text();
      try { JSON.parse(body); } catch { note = "non-JSON body"; }
    } catch (e) {
      note = e instanceof Error ? e.message : String(e);
    }
    const expected = EXPECTED_NON_2XX[bare];
    const statusOk = (status >= 200 && status < 300) || status === expected;
    if (!statusOk || note) failures.push({ path: p, status, note });
  }
  return { count: paths.length, failures };
}

async function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (IS_WINDOWS) {
    await new Promise((resolve) => {
      const k = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      k.on("exit", () => resolve());
      k.on("error", () => resolve());
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  await delay(500);
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function main() {
  // Hermetic by default: point the child at a throwaway DB + data dir so a gate
  // run never mutates the real data/brain.sqlite (mirrors memory:selfcheck) and
  // behaves the same on a fresh checkout / CI. Respect a caller-set override.
  const tmp = mkdtempSync(join(tmpdir(), "brain-serversmoke-"));
  const childEnv = {
    ...process.env,
    PORT,
    HOST: "127.0.0.1",
    BRAIN_DATA_DIR: process.env.BRAIN_DATA_DIR ?? tmp,
    BRAIN_DB_PATH: process.env.BRAIN_DB_PATH ?? join(tmp, "smoke.sqlite"),
  };

  console.log(`[server:smoke] booting server on :${PORT} via start:server (watch-free, temp DB)…`);
  // Capture the child's stdout/stderr rather than inheriting it: scripts/gate.mjs
  // scans THIS process's stdout for FAIL markers, and a nondeterministic server
  // log line could otherwise spuriously trip it. The captured log is printed
  // only if the smoke fails.
  let childLog = "";
  const child = spawn(NPM_CMD, ["run", "start:server"], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: IS_WINDOWS,
    detached: !IS_WINDOWS,
    env: childEnv,
  });
  child.stdout?.on("data", (c) => { childLog += c; });
  child.stderr?.on("data", (c) => { childLog += c; });

  let failed = false;
  try {
    const h = await waitForHealth();
    console.log("[server:smoke] /api/health:", JSON.stringify(h));

    assert(h.db === "ok", `db must be "ok", got ${JSON.stringify(h.db)}`);
    assert(
      h.vector === "ok" || h.vector === "unavailable",
      `vector must be "ok" or "unavailable", got ${JSON.stringify(h.vector)}`,
    );
    assert(
      h.locality === "local" || h.locality === "remote",
      `locality must be "local" or "remote", got ${JSON.stringify(h.locality)}`,
    );
    assert(Array.isArray(h.connectors), "connectors must be an array");
    assert(typeof h.memoryCount === "number", "memoryCount must be a number");

    // /api/conversations is a non-LLM route that exercises the Express +
    // repository + SQLite path end to end.
    const convRes = await fetch(`${BASE}/api/conversations`, { method: "GET" });
    assert(convRes.ok, `/api/conversations returned ${convRes.status}`);
    const conv = await convRes.json();
    assert(Array.isArray(conv.conversations), "conversations must be an array");

    // Sweep every read-only GET endpoint across every router — a 500 here is a
    // gate-invisible crash the health check alone would miss.
    const sweep = await sweepGetEndpoints();
    if (sweep.failures.length) {
      for (const f of sweep.failures) {
        console.error(`[server:smoke]   ✗ ${f.status} ${f.path}${f.note ? "  [" + f.note + "]" : ""}`);
      }
      throw new Error(
        `endpoint sweep: ${sweep.failures.length}/${sweep.count} GET endpoint(s) returned an unexpected status`,
      );
    }
    console.log(`[server:smoke] endpoint sweep: all ${sweep.count} GET endpoints healthy`);

    console.log("[server:smoke] ALL CHECKS PASSED — health + DB/repository + full GET surface OK.");
  } catch (err) {
    failed = true;
    console.error("[server:smoke] FAILED:", err instanceof Error ? err.message : err);
    // Explicit marker so scripts/gate.mjs FAILURE_RX flags it regardless of exit.
    console.error('[server:smoke] "result": "FAIL"');
    if (childLog.trim()) {
      console.error("[server:smoke] ---- captured server log (boot/runtime) ----");
      console.error(childLog.trim());
    }
  } finally {
    console.log("[server:smoke] shutting down server…");
    await killTree(child);
    process.exit(failed ? 1 : 0);
  }
}

main();
