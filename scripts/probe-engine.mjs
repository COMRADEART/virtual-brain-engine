// Phase 4 runtime verification helper (NOT a gate step): read which simulation
// engine BrainScene actually selected in the running app, under the current GPU
// mode. This is the binary gate the advisor flagged — `verify:canvas` passing
// green proves the canvas is non-black, NOT that spiking engaged; a probe that
// silently fell back to SignalSimulation under VERIFY_GPU=1 would pass vacuously.
//
//   node scripts/probe-engine.mjs                  # software (--disable-gpu) → expect "signal"
//   VERIFY_GPU=1 node scripts/probe-engine.mjs     # real GPU            → expect "spiking"
//
// Requires the dev server already running (npm run dev). Mirrors verify-canvas's
// launch flags + full-layout reload so the engine decision matches that gate.
import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TARGET_URL = process.env.VERIFY_URL ?? "http://127.0.0.1:5173/";
const USE_GPU = process.env.VERIFY_GPU === "1" || process.argv.includes("--gpu");
const WAIT_MS = Number(process.env.VERIFY_WAIT_MS ?? 2600);
const chromeCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];
const chromePath = chromeCandidates.find((c) => existsSync(c));
if (!chromePath) throw new Error("Chrome/Edge not found");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPort(dir) {
  const p = path.join(dir, "DevToolsActivePort");
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (existsSync(p)) return (await readFile(p, "utf8")).split("\n")[0].trim();
    await delay(100);
  }
  throw new Error("no DevTools port");
}

class Cdp {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const s = new WebSocket(url);
      const c = new Cdp(s);
      s.addEventListener("open", () => resolve(c), { once: true });
      s.addEventListener("error", reject, { once: true });
    });
  }
  constructor(socket) {
    this.socket = socket;
    this.id = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
        return;
      }
      (this.listeners.get(m.method) ?? []).forEach((fn) => fn(m.params));
    });
  }
  send(method, params = {}) {
    const id = this.id++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(method, fn) {
    const a = this.listeners.get(method) ?? [];
    a.push(fn);
    this.listeners.set(method, a);
  }
  waitFor(method, ms = 8000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout ${method}`)), ms);
      this.on(method, (p) => { clearTimeout(t); resolve(p); });
    });
  }
  close() { this.socket.close(); }
}

// precheck dev server
try {
  const r = await fetch(TARGET_URL);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
} catch (err) {
  console.error(`probe-engine: dev server not reachable at ${TARGET_URL}: ${err.message}`);
  console.error("Start it with `npm run dev` first.");
  process.exit(2);
}

const dir = path.join(os.tmpdir(), `probe-engine-${process.pid}`);
await mkdir(dir, { recursive: true });
const chrome = spawn(chromePath, [
  "--headless=new",
  ...(USE_GPU ? [] : ["--disable-gpu"]),
  "--no-first-run",
  "--remote-debugging-port=0",
  `--user-data-dir=${dir}`,
  "--window-size=1440,900",
  TARGET_URL,
], { stdio: ["ignore", "ignore", "ignore"] });

let exitCode = 0;
try {
  const port = await waitForPort(dir);
  const tabs = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const tab = tabs.find((t) => t.url === TARGET_URL) ?? tabs[0];
  const client = await Cdp.connect(tab.webSocketDebuggerUrl);
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  const load1 = client.waitFor("Page.loadEventFired");
  await client.send("Page.navigate", { url: TARGET_URL });
  await load1;
  await client.send("Runtime.evaluate", {
    expression: `localStorage.setItem("brain-layout", JSON.stringify("full"))`,
  });
  const load2 = client.waitFor("Page.loadEventFired");
  await client.send("Page.reload", { ignoreCache: true });
  await load2;
  await delay(WAIT_MS);

  const res = await client.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      let renderer = null;
      try {
        const gl = document.createElement("canvas").getContext("webgl2");
        const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
        renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null;
      } catch {}
      return { engine: window.__brainEngine ?? null, renderer };
    })()`,
  });
  const { engine, renderer } = res.result.value;
  const mode = USE_GPU ? "GPU(VERIFY_GPU=1)" : "software(--disable-gpu)";
  const expected = USE_GPU ? "spiking" : "signal";
  const ok = engine === expected;
  console.log(JSON.stringify({ mode, engine, expected, ok, renderer }, null, 2));
  if (!ok) {
    console.error(`probe-engine: FAIL — expected "${expected}" under ${mode}, got "${engine}"`);
    exitCode = 1;
  }
  await client.close();
} catch (err) {
  console.error("probe-engine error:", err.message);
  exitCode = 1;
} finally {
  try { chrome.kill(); } catch {}
  await delay(300);
  try { await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }); } catch {}
}
process.exit(exitCode);
