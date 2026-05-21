import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TARGET_URL = process.env.VERIFY_URL ?? "http://127.0.0.1:5173/";
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
  throw new Error("Chrome or Edge executable was not found for canvas verification.");
}

// Refuse to launch Chrome against a dead URL. The script used to navigate
// anyway, land on Chrome's `ERR_CONNECTION_REFUSED` page, and report
// `missing canvas` — accurate but unhelpful. Probe first and fail loud.
async function precheckDevServer(url) {
  try {
    const probeUrl = new URL(url);
    const res = await fetch(probeUrl, { method: "GET" });
    if (!res.ok) {
      throw new Error(`dev server returned HTTP ${res.status}`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      [
        `verify:canvas could not reach ${url}: ${reason}`,
        "",
        "This script does NOT start a dev server. Start one in another terminal:",
        "    npm run dev",
        "or run the orchestrated script that boots Vite for you:",
        "    npm run test:all",
        "",
        "Override the target URL with VERIFY_URL=... if the server is on a different port.",
      ].join("\n"),
    );
    process.exit(2);
  }
}

async function main() {
  await precheckDevServer(TARGET_URL);

  const userDataDir = path.join(os.tmpdir(), `virtual-brain-engine-chrome-${process.pid}`);
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

  let stderr = "";
  chrome.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  try {
    const port = await waitForDevToolsPort(userDataDir);
    const tabs = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    const tab = tabs.find((entry) => entry.url === TARGET_URL) ?? tabs[0];
    const client = await CdpClient.connect(tab.webSocketDebuggerUrl);
    const issues = [];
    const blockingIssues = [];

    client.on("Runtime.exceptionThrown", (params) => {
      const message =
        params.exceptionDetails?.exception?.description ??
        params.exceptionDetails?.text ??
        "Runtime exception";
      console.error("[Browser Runtime Exception]", message);
      issues.push(message);
      blockingIssues.push(message);
    });
    client.on("Log.entryAdded", (params) => {
      console.log(`[Browser Log ${params.entry?.level}]`, params.entry?.text);
      if (params.entry?.level === "error") {
        issues.push(params.entry.text);
      }
    });

    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Log.enable");
    await client.send("Page.bringToFront");
    const loadEvent = client.waitForEvent("Page.loadEventFired", 8000);
    await client.send("Page.navigate", { url: TARGET_URL });
    await loadEvent;
    await client.send("Runtime.evaluate", {
      expression: `localStorage.setItem("brain-layout", JSON.stringify("full"))`,
    });
    const reloadEvent = client.waitForEvent("Page.loadEventFired", 8000);
    await client.send("Page.reload", { ignoreCache: true });
    await reloadEvent;
    await delay(2600);

    const result = await client.send("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `
        new Promise((resolve) => {
          setTimeout(() => {
            const canvases = [...document.querySelectorAll("canvas")];
            const canvas = canvases
              .map((candidate) => ({ candidate, bounds: candidate.getBoundingClientRect() }))
              .filter(({ bounds }) => bounds.width > 0 && bounds.height > 0)
              .sort((a, b) => (b.bounds.width * b.bounds.height) - (a.bounds.width * a.bounds.height))[0]?.candidate
              ?? canvases[0];
            const appTitle = document.querySelector("h1")?.textContent ?? "";
            const actionButtons = [...document.querySelectorAll("button")].map((button) => button.textContent?.trim()).filter(Boolean);

            if (!canvas) {
              resolve({ ok: false, reason: "missing canvas", appTitle, actionButtons });
              return;
            }

            requestAnimationFrame(() => requestAnimationFrame(() => {
              const sample = document.createElement("canvas");
              sample.width = 96;
              sample.height = 60;
              const context = sample.getContext("2d", { willReadFrequently: true });
              context.drawImage(canvas, 0, 0, sample.width, sample.height);
              const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
              let activePixels = 0;
              let totalLuma = 0;
              let maxLuma = 0;

              for (let index = 0; index < pixels.length; index += 4) {
                const luma = pixels[index] + pixels[index + 1] + pixels[index + 2];
                totalLuma += luma;
                maxLuma = Math.max(maxLuma, luma);
                if (pixels[index + 3] > 0 && luma > 24) {
                  activePixels += 1;
                }
              }

              const bounds = canvas.getBoundingClientRect();
              resolve({
                ok: activePixels > 90 && maxLuma > 80,
                pageUrl: location.href,
                appTitle,
                buttonCount: actionButtons.length,
                canvasWidth: Math.round(bounds.width),
                canvasHeight: Math.round(bounds.height),
                activePixels,
                averageLuma: Math.round(totalLuma / (pixels.length / 4)),
                maxLuma,
              });
            }));
          }, 600);
        })
      `,
    });

    const screenshot = await client.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    const artifactsDir = path.join(process.cwd(), "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const screenshotPath = path.join(artifactsDir, "virtual-brain-engine.png");
    await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));

    await client.close();

    const verification = {
      ...result.result.value,
      screenshotPath,
      consoleIssues: issues,
    };
    console.log(JSON.stringify(verification, null, 2));

    if (!verification.ok || blockingIssues.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await terminateChrome(chrome);
    try {
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
    } catch {
      // Chrome profile cleanup is best-effort because Windows can hold a lockfile briefly.
    }
    if (process.exitCode && stderr.trim()) {
      console.error(stderr.trim());
    }
  }
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

function terminateChrome(process) {
  return new Promise((resolve) => {
    if (process.exitCode !== null || process.killed) {
      resolve();
      return;
    }

    const timeout = setTimeout(resolve, 1500);
    process.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    process.kill();
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
      const listener = (params) => {
        clearTimeout(timeout);
        resolve(params);
      };
      this.on(method, listener);
    });
  }

  close() {
    this.socket.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
