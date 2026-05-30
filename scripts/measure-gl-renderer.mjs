// One-off measurement (NOT a gate step): print Chrome's WebGL UNMASKED_RENDERER
// string under the current GPU mode, so the Phase 4 spiking-capability probe's
// software-renderer regex is written against MEASURED strings, not guessed ones.
//
//   node scripts/measure-gl-renderer.mjs            # software (--disable-gpu, SwiftShader)
//   VERIFY_GPU=1 node scripts/measure-gl-renderer.mjs   # real GPU / ANGLE
//
// The renderer string depends on Chrome's GL backend, not the page, so we probe
// about:blank — no dev server required.
import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const USE_GPU = process.env.VERIFY_GPU === "1" || process.argv.includes("--gpu");
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

async function waitForPort(userDataDir) {
  const p = path.join(userDataDir, "DevToolsActivePort");
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
    socket.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = this.id++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  close() { this.socket.close(); }
}

const userDataDir = path.join(os.tmpdir(), `gl-measure-${process.pid}`);
await mkdir(userDataDir, { recursive: true });
const chrome = spawn(chromePath, [
  "--headless=new",
  ...(USE_GPU ? [] : ["--disable-gpu"]),
  "--no-first-run",
  "--remote-debugging-port=0",
  `--user-data-dir=${userDataDir}`,
  "about:blank",
], { stdio: ["ignore", "ignore", "ignore"] });

try {
  const port = await waitForPort(userDataDir);
  const tabs = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const client = await Cdp.connect(tabs[0].webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  const res = await client.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const out = { mode: ${JSON.stringify(USE_GPU ? "GPU" : "software(--disable-gpu)")} };
      for (const type of ["webgl2", "webgl"]) {
        try {
          const gl = document.createElement("canvas").getContext(type);
          if (!gl) { out[type] = null; continue; }
          const dbg = gl.getExtension("WEBGL_debug_renderer_info");
          out[type] = {
            hasDebugExt: !!dbg,
            unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
            unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
            plainRenderer: gl.getParameter(gl.RENDERER),
          };
        } catch (e) { out[type] = "throw: " + e.message; }
      }
      return out;
    })()`,
  });
  console.log(JSON.stringify(res.result.value, null, 2));
  await client.close();
} finally {
  try { chrome.kill(); } catch {}
  await delay(300);
  try { await rm(userDataDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }); } catch {}
}
