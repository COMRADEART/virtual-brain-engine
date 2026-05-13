// Orchestrated smoke runner: boots Vite, waits for it, runs verify:canvas and
// test:actions, then cleanly tears Vite down. Removes the dev-server-prereq
// footgun for one-shot testing.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const TARGET = process.env.VERIFY_URL ?? "http://127.0.0.1:5173/";
const READY_TIMEOUT_MS = 30_000;
const IS_WINDOWS = process.platform === "win32";
// Node 20+ blocks spawning .bat/.cmd without shell:true for security. We always
// pass shell:true on Windows so `npm` (npm.cmd) resolves and runs correctly.
const NPM_CMD = IS_WINDOWS ? "npm.cmd" : "npm";

async function probe() {
  try {
    const res = await fetch(TARGET, { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForServer() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probe()) {
      return;
    }
    await delay(400);
  }
  throw new Error(`Vite never came up at ${TARGET} within ${READY_TIMEOUT_MS}ms.`);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      shell: IS_WINDOWS,
      ...opts,
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`))));
  });
}

function spawnDetached(cmd, args) {
  // Group-leadership trick: on POSIX, detached:true lets us SIGTERM the whole
  // process tree via -pid. On Windows we use taskkill /T /F below, and we MUST
  // pass shell:true so npm.cmd resolves under Node 20+.
  const child = spawn(cmd, args, {
    stdio: ["ignore", "inherit", "inherit"],
    detached: !IS_WINDOWS,
    shell: IS_WINDOWS,
  });
  return child;
}

async function killTree(child) {
  if (!child || child.exitCode !== null) {
    return;
  }
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      killer.on("exit", () => resolve());
      killer.on("error", () => resolve());
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
  await delay(500);
}

async function preflightVite() {
  // If something is already listening on 5173 (developer already has `npm run dev`
  // running), reuse it instead of double-binding.
  if (await probe()) {
    console.log(`[test:all] reusing existing dev server at ${TARGET}`);
    return null;
  }
  console.log("[test:all] booting Vite…");
  const child = spawnDetached(NPM_CMD, ["run", "dev"]);
  await waitForServer();
  console.log("[test:all] Vite ready.");
  return child;
}

async function main() {
  let vite = null;
  let failed = false;
  try {
    vite = await preflightVite();
    await run(NPM_CMD, ["run", "verify:canvas"]);
    await run(NPM_CMD, ["run", "test:actions"]);
    console.log("[test:all] all smoke tests passed.");
  } catch (err) {
    failed = true;
    console.error("[test:all] FAILED:", err instanceof Error ? err.message : err);
  } finally {
    if (vite) {
      console.log("[test:all] shutting down Vite…");
      await killTree(vite);
    }
    process.exit(failed ? 1 : 0);
  }
}

main();
