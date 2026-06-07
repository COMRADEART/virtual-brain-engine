// Theme-aware screenshot using verify-canvas's proven CDP harness.
// THEME=light|dark SHOT_OUT=path node scripts/_shot-theme.mjs
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TARGET_URL = process.env.VERIFY_URL ?? "http://127.0.0.1:5173/";
const THEME = process.env.THEME ?? "light";
const OUT = process.env.SHOT_OUT ?? path.join(process.cwd(), "artifacts", `ui-${THEME}.png`);
const WAIT_MS = Number(process.env.SHOT_WAIT_MS ?? 3000);
const chromeCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];
const chromePath = chromeCandidates.find((c) => existsSync(c));
if (!chromePath) throw new Error("Chrome/Edge not found");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const userDataDir = path.join(os.tmpdir(), `star-theme-shot-${process.pid}`);
  await mkdir(userDataDir, { recursive: true });
  const chrome = spawn(chromePath, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions",
    "--remote-debugging-port=0", `--user-data-dir=${userDataDir}`,
    "--window-size=1440,900", TARGET_URL,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  try {
    const port = await waitForPort(userDataDir);
    const tabs = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const tab = tabs.find((t) => t.url === TARGET_URL) ?? tabs[0];
    const client = await Cdp.connect(tab.webSocketDebuggerUrl);
    await client.send("Page.enable");
    const load1 = client.waitForEvent("Page.loadEventFired", 30000);
    await client.send("Page.navigate", { url: TARGET_URL });
    await load1;
    await client.send("Runtime.evaluate", {
      expression: `localStorage.setItem("brain-theme", ${JSON.stringify(THEME)}); localStorage.setItem("brain-layout", JSON.stringify("full"));`,
    });
    const load2 = client.waitForEvent("Page.loadEventFired", 10000);
    await client.send("Page.reload", { ignoreCache: true });
    await load2;
    await delay(WAIT_MS);
    const shot = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await mkdir(path.dirname(OUT), { recursive: true });
    await writeFile(OUT, Buffer.from(shot.data, "base64"));
    console.log("SHOT_OK", OUT);
    await client.close();
  } finally {
    chrome.kill();
    try { await rm(userDataDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }); } catch {}
  }
}
async function waitForPort(dir) {
  const p = path.join(dir, "DevToolsActivePort"); const start = Date.now();
  while (Date.now() - start < 10000) { if (existsSync(p)) return (await readFile(p, "utf8")).split("\n")[0].trim(); await delay(100); }
  throw new Error("no devtools port");
}
class Cdp {
  static connect(url) { return new Promise((res, rej) => { const s = new WebSocket(url); const c = new Cdp(s); s.addEventListener("open", () => res(c), { once: true }); s.addEventListener("error", rej, { once: true }); }); }
  constructor(s) { this.s = s; this.id = 1; this.pending = new Map(); this.listeners = new Map(); s.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); return; } (this.listeners.get(m.method) ?? []).forEach((l) => l(m.params)); }); }
  send(method, params = {}) { const id = this.id++; this.s.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject })); }
  on(method, l) { const a = this.listeners.get(method) ?? []; a.push(l); this.listeners.set(method, a); }
  waitForEvent(method, t = 5000) { return new Promise((resolve, reject) => { const to = setTimeout(() => reject(new Error("timeout " + method)), t); this.on(method, (p) => { clearTimeout(to); resolve(p); }); }); }
  close() { this.s.close(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
