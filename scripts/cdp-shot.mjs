// One-off render verification: navigate, let the scene draw, screenshot, exit.
import { spawn } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TARGET_URL = process.env.VERIFY_URL ?? "http://127.0.0.1:5173/";
const OUT = path.resolve("artifacts/render-check.png");
const log = (...a) => console.log("[shot]", ...a);
const WATCHDOG_MS = Number(process.env.SHOT_WATCHDOG_MS ?? 25000);
const RENDER_WAIT_MS = Number(process.env.SHOT_WAIT_MS ?? 8000);
setTimeout(() => { log("WATCHDOG timeout — forcing exit"); process.exit(2); }, WATCHDOG_MS);

const chromeCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];
const chromePath = chromeCandidates.find((c) => existsSync(c));
log("chrome:", chromePath);
const userDataDir = path.join(os.tmpdir(), `cdp-shot-${process.pid}`);
const chrome = spawn(chromePath, [
  "--headless=new", "--no-first-run",
  "--remote-debugging-port=0", `--user-data-dir=${userDataDir}`,
  "--window-size=1440,900", TARGET_URL,
], { stdio: ["ignore", "ignore", "pipe"] });

let stderr = "";
chrome.stderr.on("data", (c) => { stderr += String(c); });
const port = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("no devtools port")), 10000);
  const iv = setInterval(() => {
    const m = stderr.match(/ws:\/\/127\.0\.0\.1:(\d+)\//);
    if (m) { clearInterval(iv); clearTimeout(t); resolve(Number(m[1])); }
  }, 100);
});
log("devtools port:", port);

const tabs = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
log("targets:", JSON.stringify(tabs.map((t) => ({ type: t.type, url: (t.url || "").slice(0, 50) }))));
const pageTab = tabs.find((t) => t.type === "page") ?? tabs[0];
log("using target:", pageTab.type, (pageTab.url || "").slice(0, 50));
const ws = new WebSocket(pageTab.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const errors = [];
ws.addEventListener("message", (ev) => {
  let msg; try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
  if (msg.method === "Runtime.exceptionThrown") {
    errors.push("EXC: " + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text ?? "").split("\n")[0]);
  }
  if (msg.method === "Runtime.consoleAPICalled" && /error|warning/.test(msg.params.type)) {
    errors.push("CON." + msg.params.type + ": " + msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ").split("\n")[0]);
  }
  if (msg.method === "Log.entryAdded" && /error|warning/.test(msg.params.entry.level)) {
    errors.push("LOG." + msg.params.entry.level + ": " + (msg.params.entry.text || "").split("\n")[0] + " " + (msg.params.entry.url || ""));
  }
});
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

await new Promise((r) => ws.addEventListener("open", r));
log("ws open");
await send("Runtime.enable");
await send("Page.enable");
await send("Log.enable");
await send("Page.navigate", { url: TARGET_URL });
log(`navigated, waiting ${RENDER_WAIT_MS}ms for render…`);
await new Promise((r) => setTimeout(r, RENDER_WAIT_MS));
log("errors-so-far:", errors.length ? errors.slice(0, 8) : "none");

// Main-thread liveness + canvas state (this evaluate runs on the page main
// thread; if it returns promptly the thread is responsive).
const tEval = Date.now();
const info = await send("Runtime.evaluate", {
  expression: `(() => {
    const c = document.querySelector('canvas');
    return JSON.stringify({
      canvases: document.querySelectorAll('canvas').length,
      w: c && c.width, h: c && c.height, cssW: c && c.clientWidth, cssH: c && c.clientHeight,
      hasWebGL: !!(c && (c.getContext('webgl2') || c.getContext('webgl'))),
      rootChildren: (document.getElementById('root') || {}).childElementCount,
      rootHtmlLen: ((document.getElementById('root') || {}).innerHTML || '').length,
      title: document.title,
      body: (document.body.innerText || '').replace(/\\s+/g,' ').slice(0,100)
    });
  })()`,
  returnByValue: true,
});
log("evaluate returned in", Date.now() - tEval, "ms:", info?.result?.value);

const shot = await send("Page.captureScreenshot", { format: "png" });
mkdirSync(path.dirname(OUT), { recursive: true });
if (shot?.data) { writeFileSync(OUT, Buffer.from(shot.data, "base64")); log("screenshot saved:", OUT); }
else log("screenshot FAILED");
log("exceptions:", errors.length ? errors.slice(0, 5) : "none");
chrome.kill();
process.exit(0);
