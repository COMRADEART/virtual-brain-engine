// UI-settings smoke: drives the Settings panel end-to-end in headless Chrome.
// Opens Settings via the status-bar gear, switches the accent preset + density,
// asserts the CSS custom properties / data attributes actually changed and were
// persisted to localStorage, saves a camera bookmark (asserting the toast +
// bookmark row appear), and screenshots each state into artifacts/.
//
// Like verify-canvas.mjs this REQUIRES a dev server to already be running
// (npm run dev). Not part of `npm test` — it's the manual UI-surface smoke for
// the customization layer. Override the target with VERIFY_URL=...

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TARGET_URL = process.env.VERIFY_URL ?? "http://127.0.0.1:5173/";
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
    console.error(`smoke-ui-settings could not reach ${TARGET_URL}: ${err.message}`);
    console.error("Start a dev server first: npm run dev");
    process.exit(2);
  }

  const userDataDir = path.join(os.tmpdir(), `brain-ui-smoke-${process.pid}`);
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
  const consoleErrors = [];

  try {
    const port = await waitForDevToolsPort(userDataDir);
    const tabs = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const tab = tabs.find((entry) => entry.url === TARGET_URL) ?? tabs[0];
    const client = await CdpClient.connect(tab.webSocketDebuggerUrl);

    client.on("Runtime.exceptionThrown", (params) => {
      const message = params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "Runtime exception";
      consoleErrors.push(message);
    });
    client.on("Log.entryAdded", (params) => {
      if (params.entry?.level === "error") consoleErrors.push(params.entry.text);
    });

    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Log.enable");
    const loadEvent = client.waitForEvent("Page.loadEventFired", FIRST_LOAD_MS);
    await client.send("Page.navigate", { url: TARGET_URL });
    await loadEvent;
    // Full layout (the status bar with the gear lives there).
    await client.send("Runtime.evaluate", {
      expression: `localStorage.setItem("brain-layout", JSON.stringify("full"))`,
    });
    const reloadEvent = client.waitForEvent("Page.loadEventFired", 10000);
    await client.send("Page.reload", { ignoreCache: true });
    await reloadEvent;
    await delay(2500);

    const evaluate = async (expression) => {
      const out = await client.send("Runtime.evaluate", { returnByValue: true, awaitPromise: true, expression });
      return out.result.value;
    };
    const check = (name, ok, detail = "") => {
      console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
      if (!ok) failures.push(name);
    };
    const shoot = async (name) => {
      const shot = await client.send("Page.captureScreenshot", { format: "png" });
      const file = path.join(artifactsDir, name);
      await writeFile(file, Buffer.from(shot.data, "base64"));
      return file;
    };

    // 1. Onboarding card shows on first run (fresh profile).
    await delay(1500); // card appears after a 1.2s delay
    const onboarding = await evaluate(`!!document.querySelector(".onboarding-card")`);
    check("onboarding card appears on first run", onboarding === true);

    // 2. Open Settings via the status-bar gear.
    const gearClicked = await evaluate(`(() => {
      const btn = document.querySelector('button[aria-label="Open settings"]');
      if (!btn) return false; btn.click(); return true;
    })()`);
    check("status-bar gear opens settings", gearClicked === true);
    await delay(400);
    const settingsOpen = await evaluate(`!!document.querySelector(".settings-modal")`);
    check("settings modal rendered", settingsOpen === true);
    await shoot("ui-settings-open.png");

    // 3. Switch accent to Teal — --accent var must change and persist.
    const accentBefore = await evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()`);
    await evaluate(`(() => {
      const btn = document.querySelector('.accent-swatch[aria-label="Teal"]');
      if (btn) btn.click(); return !!btn;
    })()`);
    await delay(250);
    const accentAfter = await evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()`);
    check("accent swatch changes --accent", accentAfter !== accentBefore && accentAfter === "#2dd4bf", `${accentBefore} → ${accentAfter}`);
    const persisted = await evaluate(`JSON.parse(localStorage.getItem("brain-ui-prefs") ?? "{}").accentId`);
    check("accent persisted to localStorage", persisted === "teal");
    await shoot("ui-settings-teal.png");

    // 4. Density compact — data attribute flips.
    await evaluate(`(() => {
      const btns = [...document.querySelectorAll(".settings-segmented button")];
      const b = btns.find((x) => x.textContent.trim() === "Compact");
      if (b) b.click(); return !!b;
    })()`);
    await delay(200);
    const density = await evaluate(`document.documentElement.getAttribute("data-density")`);
    check("density toggle sets data-density", density === "compact");

    // 5. Reset preferences — back to defaults.
    await evaluate(`(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("Reset all preferences"));
      if (b) b.click(); return !!b;
    })()`);
    await delay(250);
    const accentReset = await evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()`);
    const densityReset = await evaluate(`document.documentElement.getAttribute("data-density")`);
    check("reset restores default accent", accentReset === "#7c5cff", accentReset);
    check("reset restores comfortable density", densityReset === "comfortable");
    const resetToast = await evaluate(`!!document.querySelector(".toast-success")`);
    check("reset shows a success toast", resetToast === true);

    // 6. Close settings, save a camera bookmark from RegionControls.
    await evaluate(`(() => {
      const b = document.querySelector('.settings-modal button[aria-label="Close settings"]');
      if (b) b.click(); return !!b;
    })()`);
    await delay(300);
    await evaluate(`(() => {
      const b = [...document.querySelectorAll(".camera-tool-btn")].find((x) => x.textContent.includes("Save view"));
      if (b) b.click(); return !!b;
    })()`);
    await delay(300);
    const bookmarkRow = await evaluate(`document.querySelector(".camera-bookmarks .bookmark-go")?.textContent ?? ""`);
    check("camera bookmark saved + listed", bookmarkRow.includes("View 1"), bookmarkRow);
    const bookmarkStored = await evaluate(`(JSON.parse(localStorage.getItem("brain-camera-bookmarks") ?? "[]")).length`);
    check("bookmark persisted to localStorage", bookmarkStored === 1);
    await shoot("ui-bookmark-saved.png");

    // 7. Fly to the bookmark (must not throw).
    await evaluate(`(() => { document.querySelector(".bookmark-go")?.click(); return true; })()`);
    await delay(1000);

    await client.close();
  } finally {
    await terminateChrome(chrome);
    try {
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
    } catch {}
  }

  // The brainBus reconnect loop against a down backend logs browser-level
  // network errors (ERR_CONNECTION_REFUSED on ws://…/ws/brain) that the bus's
  // quiet logging cannot suppress — running without the server is a supported
  // mode, so only NON-bus errors are findings.
  const realErrors = consoleErrors.filter(
    (msg) => !(msg.includes("/ws/brain") && msg.includes("ERR_CONNECTION_REFUSED")),
  );
  if (realErrors.length > 0) {
    console.error("console errors:", realErrors);
    failures.push("console errors");
  }
  if (failures.length > 0) {
    console.error(`\nsmoke-ui-settings FAILED: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("\nsmoke-ui-settings: all checks passed.");
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
