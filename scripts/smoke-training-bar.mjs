// TrainingBar smoke: asserts the boot auto-train progress bar actually renders.
//
// REQUIRES (1) a dev server on 5173 (npm run dev), (2) the brain server on 8787,
// and (3) a scratch-LLM training run IN FLIGHT (boot auto-train, or POST
// /api/learning/llm/start). Exits 2 with a hint when any prerequisite is
// missing — like verify-canvas, it never boots services for you.
//
// Asserts: the bar mounts, the title reads "Growing the brain's own model",
// the live step counter matches the trainer's totalSteps, and the progress
// fill has a real width. Screenshots into artifacts/training-bar.png.

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TARGET_URL = process.env.VERIFY_URL ?? "http://127.0.0.1:5173/";
const API_URL = process.env.BRAIN_API_URL ?? "http://127.0.0.1:8787";
const FIRST_LOAD_MS = Number(process.env.VERIFY_FIRST_LOAD_MS ?? 30000);

const chromeCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

const chromePath = chromeCandidates.find((candidate) => existsSync(candidate));
if (!chromePath) {
  throw new Error("Chrome or Edge executable was not found for UI smoke.");
}

async function main() {
  try {
    const res = await fetch(TARGET_URL);
    if (!res.ok) throw new Error(`dev server returned HTTP ${res.status}`);
  } catch (err) {
    console.error(`smoke-training-bar could not reach ${TARGET_URL}: ${err.message}`);
    console.error("Start a dev server first: npm run dev");
    process.exit(2);
  }

  let trainer;
  try {
    trainer = await fetch(`${API_URL}/api/learning/llm/status`).then((r) => r.json());
  } catch (err) {
    console.error(`smoke-training-bar could not reach the brain server at ${API_URL}: ${err.message}`);
    process.exit(2);
  }
  if (trainer.state !== "running") {
    console.error(
      `smoke-training-bar needs a training run in flight (trainer state: "${trainer.state}").`,
    );
    console.error("Boot the worker + server (auto-train kicks in) or POST /api/learning/llm/start.");
    process.exit(2);
  }

  const userDataDir = path.join(os.tmpdir(), `brain-trainbar-smoke-${process.pid}`);
  await mkdir(userDataDir, { recursive: true });

  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-extensions",
      "--no-first-run",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--window-size=1440,900",
      TARGET_URL,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  const artifactsDir = path.join(process.cwd(), "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  const failures = [];

  try {
    const port = await waitForDevToolsPort(userDataDir);
    const tabs = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const tab = tabs.find((entry) => entry.url === TARGET_URL) ?? tabs[0];
    const client = await CdpClient.connect(tab.webSocketDebuggerUrl);

    await client.send("Page.enable");
    await client.send("Runtime.enable");
    const loadEvent = client.waitForEvent("Page.loadEventFired", FIRST_LOAD_MS);
    await client.send("Page.navigate", { url: TARGET_URL });
    await loadEvent;
    // The bar mounts from the initial status fetch; give it (plus a bus frame
    // or two) a moment.
    await delay(4000);

    const evaluate = async (expression) => {
      const out = await client.send("Runtime.evaluate", { returnByValue: true, awaitPromise: true, expression });
      return out.result.value;
    };
    const check = (name, ok, detail = "") => {
      console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
      if (!ok) failures.push(name);
    };

    const barPresent = await evaluate(`!!document.querySelector(".training-bar")`);
    check("training bar renders while a run is live", barPresent === true);

    const title = await evaluate(`document.querySelector(".training-bar__title")?.textContent ?? ""`);
    check("bar title says the brain is growing its model", title.includes("Growing the brain's own model"), title);

    const meta = await evaluate(`document.querySelector(".training-bar__meta")?.textContent ?? ""`);
    const stepMatch = /step [\d,]+\/([\d,]+)/.exec(meta);
    const totalInBar = stepMatch ? Number(stepMatch[1].replaceAll(",", "")) : null;
    check(
      "bar step counter matches the trainer's totalSteps",
      totalInBar === trainer.totalSteps,
      `bar="${meta}" trainer=${trainer.totalSteps}`,
    );

    const fillWidth = await evaluate(
      `document.querySelector(".training-bar__fill")?.getBoundingClientRect().width ?? 0`,
    );
    check("progress fill has real width", typeof fillWidth === "number" && fillWidth > 0, `${fillWidth}px`);

    const shot = await client.send("Page.captureScreenshot", { format: "png" });
    const file = path.join(artifactsDir, "training-bar.png");
    await writeFile(file, Buffer.from(shot.data, "base64"));
    console.log(`screenshot: ${file}`);

    await client.close();
  } finally {
    await terminateChrome(chrome);
    try {
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
    } catch {}
  }

  if (failures.length > 0) {
    console.error(`\nsmoke-training-bar FAILED: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("\nsmoke-training-bar: all checks passed.");
}

async function waitForDevToolsPort(userDataDir) {
  const activePortPath = path.join(userDataDir, "DevToolsActivePort");
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (existsSync(activePortPath)) {
      const [port] = (await readFile(activePortPath, "utf8")).split("\n");
      return port.trim();
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for Chrome DevTools port.");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function terminateChrome(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.killed) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, 1500);
    proc.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    proc.kill();
  });
}

class CdpClient {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const client = new CdpClient(socket);
      socket.addEventListener("open", () => resolve(client), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          reject(new Error(message.error.message));
        } else {
          resolve(message.result);
        }
        return;
      }
      const listeners = this.listeners.get(message.method) ?? [];
      listeners.forEach((listener) => listener(message.params));
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  waitForEvent(method, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.on(method, (params) => {
        clearTimeout(timeout);
        resolve(params);
      });
    });
  }

  close() {
    this.socket.close();
    return Promise.resolve();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
