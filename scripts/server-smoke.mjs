// Backend smoke gate: boots the server via the watch-free `start:server`
// entrypoint, waits for /api/health, asserts the DB / vector / locality
// contract, then tears the process tree down. This is the repeatable form of
// the manual health check from the QA pass, and it closes the "the HTTP
// surface is never exercised by automation" gap WITHOUT depending on a live
// LLM (the 7-step reasoning pipeline still needs Ollama and is out of scope
// here by design — health does not).
//
// It also guards against the M2 regression: `start:server` must be the
// watch-free launch (nested `tsx watch` did not bind under non-interactive
// spawn). If this gate hangs at "waiting for /api/health", that contract broke.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const PORT = process.env.SMOKE_PORT ?? "8799";
const BASE = `http://127.0.0.1:${PORT}`;
const READY_TIMEOUT_MS = 45_000;
const IS_WINDOWS = process.platform === "win32";
const NPM_CMD = IS_WINDOWS ? "npm.cmd" : "npm";

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
  console.log(`[server:smoke] booting server on :${PORT} via start:server (watch-free)…`);
  const child = spawn(NPM_CMD, ["run", "start:server"], {
    stdio: ["ignore", "inherit", "inherit"],
    shell: IS_WINDOWS,
    detached: !IS_WINDOWS,
    env: { ...process.env, PORT, HOST: "127.0.0.1" },
  });

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

    console.log("[server:smoke] PASS — HTTP surface healthy, DB+repository path OK.");
  } catch (err) {
    failed = true;
    console.error("[server:smoke] FAILED:", err instanceof Error ? err.message : err);
  } finally {
    console.log("[server:smoke] shutting down server…");
    await killTree(child);
    process.exit(failed ? 1 : 0);
  }
}

main();
