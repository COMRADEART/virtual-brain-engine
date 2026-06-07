// Full-page screenshot via CDP (adapted from verify-canvas.mjs) so I can SEE the
// redesign. Requires a dev server already running on VERIFY_URL.
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TARGET_URL = process.env.VERIFY_URL ?? "http://127.0.0.1:5173/";
const WAIT_MS = Number(process.env.SHOT_WAIT_MS ?? 3500);
const OUT = process.env.SHOT_OUT ?? path.join(process.cwd(), "artifacts", "ui-modern.png");
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
  const userDataDir = path.join(os.tmpdir(), `star-shot-${process.pid}`);
  await mkdir(userDataDir, { recursive: true });
  const chrome = spawn(chromePath, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions",
    "--remote-debugging-port=0", `--user-data-dir=${userDataDir}`,
    "--window-size=1440,900", "--hide-scrollbars", TARGET_URL,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  try {
    const port = await waitForPort(userDataDir);
    const tabs = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const tab = tabs[0];
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
    let id = 1; const pending = new Map();
    ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
    const send = (method, params = {}) => { const myId = id++; ws.send(JSON.stringify({ id: myId, method, params })); return new Promise((r) => pending.set(myId, r)); };
    await send("Page.enable");
    await send("Page.navigate", { url: TARGET_URL });
    await delay(WAIT_MS);
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await mkdir(path.dirname(OUT), { recursive: true });
    await writeFile(OUT, Buffer.from(shot.data, "base64"));
    console.log("SHOT_OK", OUT);
    ws.close();
  } finally {
    chrome.kill();
    try { await rm(userDataDir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  }
}
async function waitForPort(dir) {
  const p = path.join(dir, "DevToolsActivePort"); const start = Date.now();
  while (Date.now() - start < 10000) { if (existsSync(p)) return (await readFile(p, "utf8")).split("\n")[0].trim(); await delay(100); }
  throw new Error("no devtools port");
}
main().catch((e) => { console.error(e); process.exit(1); });
