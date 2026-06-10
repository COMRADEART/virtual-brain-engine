// Live Model Hub smoke: boots the server and runs a REAL `ollama pull` of a tiny
// model (qwen2.5:0.5b, ~400MB) through POST /api/models/pull, then polls the
// status to completion. This is the gap the hermetic models:selfcheck can't
// cover — that the real multi-layer pull stream parses + the percent math holds
// against actual Ollama output.
//
// NOT in the default gate: needs Ollama + a network download. Opt-in via
// `npm run models:smoke` or the GATE_ASK_SMOKE=1 tail. SKIPS cleanly when no
// local Ollama is reachable.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const PORT = process.env.SMOKE_PORT ?? "8803";
const BASE = `http://127.0.0.1:${PORT}`;
const READY_TIMEOUT_MS = 45_000;
const PULL_TIMEOUT_MS = Number(process.env.PULL_TIMEOUT_MS ?? 600_000);
const MODEL = process.env.SMOKE_MODEL ?? "qwen2.5:0.5b";
const IS_WINDOWS = process.platform === "win32";
const NPM_CMD = IS_WINDOWS ? "npm.cmd" : "npm";
const headers = { "Content-Type": "application/json", "X-Brain-Local": "1" };

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`);
  return res.ok ? res.json() : null;
}

async function waitForHealth() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return res.json();
    } catch {
      /* keep waiting */
    }
    await delay(500);
  }
  throw new Error(`server never answered /api/health at ${BASE}`);
}

async function runPull() {
  const view = await getJson("/api/models");
  if (!view || view.base === null) {
    console.log("[models:smoke] SKIP — no local Ollama daemon reachable.");
    console.log('[models:smoke] "result": "SKIP"');
    return;
  }
  console.log(`[models:smoke] Ollama base ${view.base}; pulling ${MODEL}…`);
  const start = await fetch(`${BASE}/api/models/pull`, { method: "POST", headers, body: JSON.stringify({ name: MODEL }) });
  if (!start.ok) throw new Error(`/api/models/pull returned HTTP ${start.status}`);

  const deadline = Date.now() + PULL_TIMEOUT_MS;
  let last = "";
  while (Date.now() < deadline) {
    await delay(2000);
    const st = await getJson("/api/models/pull/status");
    if (!st) continue;
    const pctStr = st.percent != null ? `${Math.round(st.percent * 100)}%` : "…";
    if (st.status !== last) {
      console.log(`[models:smoke] ${st.status} ${pctStr}`);
      last = st.status;
    }
    if (st.error) throw new Error(`pull error: ${st.error}`);
    if (st.done) {
      const after = await getJson("/api/models");
      const present = Array.isArray(after?.installed) && after.installed.some((m) => m.startsWith(MODEL.split(":")[0]));
      if (!present) throw new Error("pull reported done but the model is not in the installed list");
      console.log(`[models:smoke] ALL CHECKS PASSED — ${MODEL} pulled and installed.`);
      return;
    }
  }
  throw new Error("pull did not complete within the timeout");
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
    } catch {}
  }
  await delay(500);
}

async function main() {
  console.log(`[models:smoke] booting server on :${PORT}…`);
  const child = spawn(NPM_CMD, ["run", "start:server"], {
    stdio: ["ignore", "inherit", "inherit"],
    shell: IS_WINDOWS,
    detached: !IS_WINDOWS,
    env: { ...process.env, PORT, HOST: "127.0.0.1" },
  });
  let exitCode = 0;
  try {
    await waitForHealth();
    await runPull();
  } catch (err) {
    exitCode = 1;
    console.error("[models:smoke] FAILED:", err instanceof Error ? err.message : err);
    console.error('[models:smoke] "result": "FAIL"');
  } finally {
    console.log("[models:smoke] shutting down server…");
    await killTree(child);
    process.exit(exitCode);
  }
}

main();
