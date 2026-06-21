// WS broadcast smoke (Phase 1C runtime check). Boots the real server, opens a
// /ws/brain client, fires ONE live POST /api/ask, and proves the pipeline's
// events actually reach the WS bus — the frontend↔backend↔WS path the hermetic
// gate never exercises (the audit's #1 "ships green but breaks at runtime" gap:
// WebSocket / server-client sync). Without this, a broken broadcast() or a
// dropped/misordered frame ships green and the 3D visualizer silently goes dark
// on every tab that didn't initiate the request.
//
// Uses the Node 22 global WebSocket (no dependency). NOT in the default gate
// (needs a local chat model); run via `npm run ws:smoke` or the GATE_ASK_SMOKE
// tail. If no chat model is reachable it SKIPS cleanly (exit 0), exactly like
// ask:smoke — environment-dependent by design.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const PORT = process.env.SMOKE_PORT ?? "8801";
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws/brain`;
const READY_TIMEOUT_MS = 45_000;
const ASK_TIMEOUT_MS = Number(process.env.ASK_TIMEOUT_MS ?? 200_000);
const PROMPT = process.env.ASK_PROMPT ?? "In one sentence, what is the Virtual Brain Engine project?";
const IS_WINDOWS = process.platform === "win32";
const NPM_CMD = IS_WINDOWS ? "npm.cmd" : "npm";

async function probeHealth() {
  try {
    const res = await fetch(`${BASE}/api/health`);
    return res.ok ? await res.json() : null;
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
  throw new Error(`server never answered /api/health at ${BASE} within ${READY_TIMEOUT_MS}ms`);
}

function openWs() {
  return new Promise((resolve, reject) => {
    const frames = [];
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => reject(new Error("WS connect timeout (10s)")), 10_000);
    ws.addEventListener("message", (ev) => {
      try {
        frames.push(JSON.parse(typeof ev.data === "string" ? ev.data : ""));
      } catch {
        // non-JSON frame — ignore
      }
    });
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve({ ws, frames });
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WS failed to connect to /ws/brain"));
    });
  });
}

// Drive /api/ask to completion (we assert on the WS side, not on the SSE here).
async function drainAsk() {
  const res = await fetch(`${BASE}/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Brain-Local": "1" },
    body: JSON.stringify({ prompt: PROMPT }),
  });
  console.log(`[ws:smoke] POST /api/ask -> HTTP ${res.status}`);
  if (!res.ok || !res.body) throw new Error(`/api/ask returned HTTP ${res.status}`);
  const reader = res.body.getReader();
  const deadline = Date.now() + ASK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { done } = await reader.read();
    if (done) return;
  }
  throw new Error("/api/ask did not finish within the timeout");
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
      // already gone
    }
  }
  await delay(500);
}

async function main() {
  console.log(`[ws:smoke] booting server on :${PORT}…`);
  const child = spawn(NPM_CMD, ["run", "start:server"], {
    stdio: ["ignore", "inherit", "inherit"],
    shell: IS_WINDOWS,
    detached: !IS_WINDOWS,
    env: { ...process.env, PORT, HOST: "127.0.0.1" },
  });

  let exitCode = 0;
  try {
    const h = await waitForHealth();
    const okConnectors = Array.isArray(h.connectors) ? h.connectors.filter((c) => c.state === "ok") : [];
    if (okConnectors.length === 0) {
      console.log("[ws:smoke] SKIP — no local chat model reachable; WS broadcast path not exercised.");
      console.log('[ws:smoke] "result": "SKIP"');
    } else {
      const { ws, frames } = await openWs();
      console.log("[ws:smoke] WS connected to /ws/brain");
      await drainAsk();
      await delay(750); // let trailing broadcast frames flush
      ws.close();
      const pipelineFrames = frames.filter((f) => f && f.type === "pipeline");
      const steps = new Set(pipelineFrames.map((f) => f.step).filter(Boolean));
      const withRegions = pipelineFrames.filter((f) => Array.isArray(f.logicalRegions) && f.logicalRegions.length > 0);
      console.log(
        `[ws:smoke] WS frames: ${frames.length} total | ${pipelineFrames.length} pipeline | steps=[${[...steps].join(",")}] | ${withRegions.length} carry region flashes`,
      );
      if (pipelineFrames.length === 0) {
        throw new Error("no pipeline frames arrived over /ws/brain during the ask — the broadcast path is broken");
      }
      if (withRegions.length === 0) {
        throw new Error("pipeline frames arrived but none carried logicalRegions — the 3D visualizer would not flash");
      }
      console.log("[ws:smoke] ALL CHECKS PASSED — pipeline events + region flashes reached the WS bus.");
    }
  } catch (err) {
    exitCode = 1;
    console.error("[ws:smoke] FAILED:", err instanceof Error ? err.message : err);
    console.error('[ws:smoke] "result": "FAIL"');
  } finally {
    console.log("[ws:smoke] shutting down server…");
    await killTree(child);
    process.exit(exitCode);
  }
}

main();
