import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TARGET_URL = process.env.VERIFY_URL ?? "http://127.0.0.1:5173/";
const chromeCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];
const chromePath = chromeCandidates.find((c) => existsSync(c));
const userDataDir = path.join(os.tmpdir(), `cdp-probe-${process.pid}`);

const chrome = spawn(chromePath, [
  "--headless=new", "--disable-gpu", "--no-first-run",
  "--remote-debugging-port=0", `--user-data-dir=${userDataDir}`,
  "--window-size=1440,900", "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

let stderr = "";
chrome.stderr.on("data", (c) => { stderr += String(c); });

function waitPort() {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no devtools port")), 10000);
    const iv = setInterval(() => {
      const m = stderr.match(/ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) { clearInterval(iv); clearTimeout(t); resolve(Number(m[1])); }
    }, 100);
  });
}

const port = await waitPort();
const tabs = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const wsUrl = tabs[0].webSocketDebuggerUrl;
const ws = new WebSocket(wsUrl);
let id = 0;
const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));

let loadFired = false;
const t0 = Date.now();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === "Page.loadEventFired") {
    loadFired = true;
    console.log(`[load] fired at +${Date.now() - t0}ms`);
  }
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    console.log("[EXCEPTION]", (d.exception?.description ?? d.text ?? "").split("\n").slice(0, 4).join("\n"));
  }
  if (msg.method === "Runtime.consoleAPICalled" && (msg.params.type === "error" || msg.params.type === "warning")) {
    console.log(`[console.${msg.params.type}]`, msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ").split("\n").slice(0, 3).join("\n"));
  }
});

await new Promise((r) => ws.addEventListener("open", r));
send("Runtime.enable");
send("Page.enable");
send("Log.enable");
send("Page.navigate", { url: TARGET_URL });

await new Promise((r) => setTimeout(r, 20000));
console.log(`\n[summary] loadFired=${loadFired} after 20s`);
chrome.kill();
process.exit(0);
