// Deep-research live smoke (Phase D runtime tail). Boots the REAL server, opens
// a /ws/brain client, fires ONE live POST /api/research/deep (SSE), and proves
// the research engine's frames reach the caller over SSE AND the cortex flashes
// reach the WS bus — the runtime path the hermetic deepresearch:selfcheck (injected
// fakes) and the route test (no-connector short-circuit) cannot cover. Mirrors
// smoke-ws.mjs. NOT in the default gate (needs a local chat model + embedder);
// run via `npm run deepresearch:smoke`. SKIPs cleanly (exit 0) when no chat model
// is reachable, exactly like ask:smoke / ws:smoke.
//
// Under the default LOCAL_ONLY=true the engine degrades to a local-memory-only
// report (webResearch is egress-gated off) — it still emits the full
// research-start→plan→gather→synthesize→reflect→report frame sequence, so this
// smoke needs NO internet, just a chat model + embedder.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const PORT = process.env.SMOKE_PORT ?? "8803";
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws/brain`;
const READY_TIMEOUT_MS = 45_000;
const RUN_TIMEOUT_MS = Number(process.env.DEEP_RESEARCH_TIMEOUT_MS ?? 300_000);
const QUESTION = process.env.DEEP_RESEARCH_QUESTION ?? "How does the brain's memory retrieval pipeline work?";
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

// Drain the SSE body, returning the parsed {type, ...} event frames.
function parseSse(text) {
  const out = [];
  for (const block of text.split("\n\n")) {
    const eventLine = block.split("\n").find((l) => l.startsWith("event:"));
    const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
    if (!eventLine || !dataLine) continue;
    const type = eventLine.slice(6).trim();
    try {
      out.push({ type, data: JSON.parse(dataLine.slice(5).trim()) });
    } catch {
      out.push({ type, data: null });
    }
  }
  return out;
}

async function runResearch() {
  const res = await fetch(`${BASE}/api/research/deep`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Brain-Local": "1" },
    body: JSON.stringify({ question: QUESTION, maxRounds: 1, breadth: 2, maxPages: 1 }),
  });
  console.log(`[deepresearch:smoke] POST /api/research/deep -> HTTP ${res.status}`);
  if (!res.ok || !res.body) throw new Error(`/api/research/deep returned HTTP ${res.status}`);
  const text = await res.text();
  return parseSse(text);
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
  console.log(`[deepresearch:smoke] booting server on :${PORT}…`);
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
      console.log("[deepresearch:smoke] SKIP — no local chat model reachable; deep-research path not exercised.");
      console.log('[deepresearch:smoke] "result": "SKIP"');
    } else {
      const { ws, frames } = await openWs();
      console.log("[deepresearch:smoke] WS connected to /ws/brain");
      const events = await runResearch();
      await delay(750); // let trailing broadcast frames flush
      ws.close();
      const types = events.map((e) => e.type);
      console.log(`[deepresearch:smoke] SSE events: [${types.join(",")}]`);

      const hasStart = types.includes("research-start");
      const hasPlan = types.includes("plan");
      const hasReport = types.includes("report");
      const hasDone = types.includes("done");
      const errorFrame = events.find((e) => e.type === "error");

      // A real run emits start→plan→…→report→done. An `error` frame means the
      // engine degraded (no embedder, etc.) — surface it, don't silently pass.
      if (errorFrame && !hasReport) {
        throw new Error(`engine emitted an error frame without a report: ${errorFrame.data?.detail ?? "(no detail)"}`);
      }
      if (!hasStart || !hasPlan) {
        throw new Error(`missing core SSE frames (research-start=${hasStart}, plan=${hasPlan})`);
      }
      if (!hasDone) {
        throw new Error("SSE stream did not terminate with a `done` frame");
      }

      // WS broadcast: the research stages must flash cortices on the bus.
      const pipelineFrames = frames.filter((f) => f && f.type === "pipeline");
      const researchFlashes = pipelineFrames.filter((f) => Array.isArray(f.logicalRegions) && f.logicalRegions.length > 0);
      console.log(
        `[deepresearch:smoke] WS frames: ${frames.length} total | ${pipelineFrames.length} pipeline | ${researchFlashes.length} carry region flashes`,
      );
      if (researchFlashes.length === 0) {
        throw new Error("no pipeline frames with logicalRegions reached /ws/brain — the 3D visualizer would not flash during deep research");
      }
      console.log(`[deepresearch:smoke] report: ${hasReport ? "produced" : "degraded"} | ${types.length} SSE events`);
      console.log("[deepresearch:smoke] ALL CHECKS PASSED — deep-research SSE + WS cortex flashes reached the bus.");
    }
  } catch (err) {
    exitCode = 1;
    console.error("[deepresearch:smoke] FAILED:", err instanceof Error ? err.message : err);
    console.error('[deepresearch:smoke] "result": "FAIL"');
  } finally {
    console.log("[deepresearch:smoke] shutting down server…");
    await killTree(child);
    process.exit(exitCode);
  }
}

main();