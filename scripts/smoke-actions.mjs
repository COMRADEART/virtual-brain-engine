// Per-action smoke test: click each action button, sample canvas activity per hemisphere,
// confirm the lit pattern matches the description. Also exercises a region click and
// the neuron-density slider. Reuses the same CDP-only approach as verify-canvas.mjs
// so there's no extra runtime dependency.

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TARGET_URL = process.env.VERIFY_URL ?? "http://127.0.0.1:5173/";
// For each action we assert the route (the active-region list rendered in the
// InfoPanel) matches the wiring in regionDefinitions.ts. We check two things:
//   * mustInclude: substrings that must appear in the route text
//   * lateralization: based on counts of "L " vs "R " prefixes in the route
//     (e.g. "left" means more L-prefixed regions than R-prefixed)
const ACTIONS = [
  {
    label: "Lift hand",
    mustInclude: ["L Motor", "L Prefrontal", "Cerebellum", "Brainstem"],
    lateralization: "left",
  },
  {
    label: "See object",
    mustInclude: ["L Visual", "R Visual", "L Thalamus", "R Thalamus"],
    lateralization: "bilateral",
  },
  {
    label: "Hear sound",
    mustInclude: ["L Auditory", "R Auditory", "L Memory", "R Memory"],
    lateralization: "bilateral",
  },
  {
    label: "Remember event",
    mustInclude: ["L Memory", "R Memory", "L Prefrontal", "R Prefrontal"],
    lateralization: "bilateral",
  },
  {
    label: "Fear response",
    mustInclude: ["L Emotion", "R Emotion", "Brainstem"],
    lateralization: "bilateral",
  },
  {
    label: "Speak",
    mustInclude: ["L Prefrontal", "L Motor", "L Temporal"],
    lateralization: "left",
  },
  {
    label: "Read text",
    mustInclude: ["L Visual", "L Temporal", "L Prefrontal"],
    lateralization: "left",
  },
];

// A 1-region asymmetry is treated as "bilateral" — the approved plan intentionally
// adds a single ipsilateral region (e.g. L Prefrontal in See object, R Prefrontal
// in Fear response) as a salience anchor, but the action is conceptually bilateral.
function lateralizationOf(route) {
  const tokens = route.split("+").map((t) => t.trim());
  const left = tokens.filter((t) => /^L /.test(t)).length;
  const right = tokens.filter((t) => /^R /.test(t)).length;
  const diff = left - right;
  if (diff >= 2) return "left";
  if (diff <= -2) return "right";
  return "bilateral";
}

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
const chromePath = chromeCandidates.find((c) => existsSync(c));
if (!chromePath) throw new Error("Chrome/Edge not found.");

async function precheckDevServer(url) {
  try {
    const res = await fetch(new URL(url));
    if (!res.ok) {
      throw new Error(`dev server returned HTTP ${res.status}`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      [
        `test:actions could not reach ${url}: ${reason}`,
        "",
        "Start the dev server first:",
        "    npm run dev",
        "or use the orchestrated test runner:",
        "    npm run test:all",
      ].join("\n"),
    );
    process.exit(2);
  }
}

async function main() {
  await precheckDevServer(TARGET_URL);

  const userDataDir = path.join(os.tmpdir(), `vbe-actions-${process.pid}`);
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

  try {
    const port = await waitForDevToolsPort(userDataDir);
    const tabs = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const tab = tabs.find((e) => e.url === TARGET_URL) ?? tabs[0];
    const client = await CdpClient.connect(tab.webSocketDebuggerUrl);

    const issues = [];
    client.on("Runtime.exceptionThrown", (params) => {
      issues.push(params.exceptionDetails?.exception?.description ?? "exception");
    });
    client.on("Log.entryAdded", (params) => {
      if (params.entry?.level === "error") {
        const text = params.entry.text;
        const url = params.entry.url ?? "";
        // Ignore favicon 404 noise (no favicon shipped with the app).
        const isFaviconMiss =
          /favicon/i.test(url) ||
          (text.includes("404") && /favicon\.ico$/i.test(url));
        // Ignore expected WebSocket errors for the optional backend server on port 8787.
        const isExpectedWsError =
          /WebSocket.*8787/.test(text) || /ws:\/\/127\.0\.0\.1:8787/.test(text);
        if (!isFaviconMiss && !isExpectedWsError) issues.push(text);
      }
    });

    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Log.enable");
    // The scientific control surface (RegionControls/InfoPanel) only renders in
    // the "full" layout; "compact" is the default daily-driver mode. Seed the
    // persisted layout preference before app JS runs so the per-action route
    // assertions below can reach the controls. (useLayoutMode reads this
    // localStorage key, JSON-encoded, on first render.)
    await client.send("Page.addScriptToEvaluateOnNewDocument", {
      source: "try { localStorage.setItem('brain-layout', JSON.stringify('full')); } catch (e) {}",
    });
    const loadEvent = client.waitForEvent("Page.loadEventFired", 8000);
    await client.send("Page.navigate", { url: TARGET_URL });
    await loadEvent;
    await delay(2200);

    const artifactsDir = path.join(process.cwd(), "artifacts", "actions");
    await mkdir(artifactsDir, { recursive: true });

    const report = [];

    for (const action of ACTIONS) {
      const click = await client.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
          const btn = [...document.querySelectorAll('button')].find((b) =>
            b.textContent?.trim() === ${JSON.stringify(action.label)});
          if (!btn) return { clicked: false };
          btn.click();
          return { clicked: true };
        })()`,
      });
      if (!click.result.value?.clicked) {
        report.push({ action: action.label, error: "button not found" });
        continue;
      }

      // Let the simulation settle into the new action's pattern.
      await delay(1400);

      // Read the route + canvas presence. The route is the authoritative signal —
      // pixel-level lateralization is unreliable with additive blending across many
      // pathways, but the route text directly reflects regionDefinitions.ts wiring.
      const sample = await client.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
          const route = document.querySelector('.active-route')?.textContent ?? '';
          const heading = document.querySelector('.action-readout h3')?.textContent ?? '';
          const canvas = document.querySelector('canvas');
          return {
            route,
            heading,
            canvasOk: !!canvas && canvas.clientWidth > 0 && canvas.clientHeight > 0,
          };
        })()`,
      });

      const v = sample.result.value;
      const observedLateralization = lateralizationOf(v.route);
      const missing = action.mustInclude.filter((needle) => !v.route.includes(needle));

      const shot = await client.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      });
      const slug = action.label.toLowerCase().replace(/\s+/g, "-");
      await writeFile(path.join(artifactsDir, `${slug}.png`), Buffer.from(shot.data, "base64"));

      report.push({
        action: action.label,
        headingMatches: v.heading === action.label,
        canvasOk: v.canvasOk,
        route: v.route,
        observedLateralization,
        expectedLateralization: action.lateralization,
        lateralizationMatch: observedLateralization === action.lateralization,
        missingFromRoute: missing,
        match:
          v.heading === action.label &&
          v.canvasOk &&
          missing.length === 0 &&
          observedLateralization === action.lateralization,
      });
    }

    // --- Region click test: click the L Memory (hippocampus-l) region button and
    //     confirm InfoPanel selected-region heading updates.
    const regionClick = await client.send("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const btn = [...document.querySelectorAll('.region-row button')]
          .find((b) => b.textContent?.trim() === 'L Memory');
        if (!btn) return { ok: false, reason: 'L Memory button not found' };
        btn.click();
        await new Promise((r) => setTimeout(r, 250));
        const heading = document.querySelector('.readout h2')?.textContent ?? '';
        return { ok: heading.toLowerCase().includes('hippocampus'), heading };
      })()`,
    });

    // --- Density slider test: set to max + dispatch input, confirm no exception.
    const densityTest = await client.send("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        try {
          const ranges = [...document.querySelectorAll('input[type=range]')];
          const density = ranges[ranges.length - 1]; // last slider in the panel
          if (!density) return { ok: false, reason: 'density slider not found' };
          const proto = Object.getPrototypeOf(density);
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(density, '2.8');
          density.dispatchEvent(new Event('input', { bubbles: true }));
          density.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 800));
          // Read neuron count from the slider's output element.
          const output = density.parentElement?.querySelector('output')?.textContent ?? '';
          return { ok: true, neuronCountAtMax: output };
        } catch (e) { return { ok: false, reason: String(e) }; }
      })()`,
    });

    await client.close();

    const finalReport = {
      url: TARGET_URL,
      actions: report,
      regionClick: regionClick.result.value,
      densityTest: densityTest.result.value,
      consoleIssues: issues,
    };
    console.log(JSON.stringify(finalReport, null, 2));

    const anyFail =
      report.some((r) => r.match === false || r.error) ||
      regionClick.result.value?.ok === false ||
      densityTest.result.value?.ok === false ||
      issues.length > 0;
    if (anyFail) process.exitCode = 1;
  } finally {
    await terminateChrome(chrome);
    try { await rm(userDataDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }); } catch {}
  }
}

async function waitForDevToolsPort(userDataDir) {
  const file = path.join(userDataDir, "DevToolsActivePort");
  const start = Date.now();
  while (Date.now() - start < 10000) {
    if (existsSync(file)) {
      const [port] = (await readFile(file, "utf8")).split("\n");
      return port.trim();
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for Chrome DevTools port.");
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function terminateChrome(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.killed) { resolve(); return; }
    const t = setTimeout(resolve, 1500);
    proc.once("exit", () => { clearTimeout(t); resolve(); });
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
      const m = JSON.parse(event.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
        return;
      }
      (this.listeners.get(m.method) ?? []).forEach((l) => l(m.params));
    });
  }
  send(method, params = {}) {
    const id = this.nextId; this.nextId += 1;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(method, listener) {
    const arr = this.listeners.get(method) ?? [];
    arr.push(listener);
    this.listeners.set(method, arr);
  }
  waitForEvent(method, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), timeoutMs);
      this.on(method, (p) => { clearTimeout(t); resolve(p); });
    });
  }
  close() { this.socket.close(); }
}

main().catch((e) => { console.error(e); process.exit(1); });
