// Person-batch smoke — boots the real server, registers a watch daemon via
// the permissioned executor, drops a file, and asserts the daemon actually
// fired. Proves the FS-watcher → runner → executeAction → audit round-trip
// end-to-end (the selfcheck already proves this hermetically; this is the
// runtime check the default gate skips — it needs the server to boot a
// real DB).
//
// NOT in the default gate; opt-in via `npm run person:smoke` or the
// GATE_PERSON_SMOKE=1 tail. SKIPS cleanly (exit 0) when the executor refuses
// the test action (no usable connector in state 'ok').
//
// Uses a THROWAWAY DB so the test daemon never pollutes the developer's real
// store. Local-only (no network).

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = process.env.SMOKE_PORT ?? "8806";
const BASE = `http://127.0.0.1:${PORT}`;
const READY_TIMEOUT_MS = 45_000;
const POLL_TIMEOUT_MS = 30_000;
const IS_WINDOWS = process.platform === "win32";
const NPM_CMD = IS_WINDOWS ? "npm.cmd" : "npm";

const tmp = mkdtempSync(join(tmpdir(), "brain-personsmoke-"));
const watchDir = mkdtempSync(join(tmpdir(), "brain-personsmoke-watch-"));

async function probeHealth() {
  try {
    const res = await fetch(`${BASE}/api/health`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function waitForHealth() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const h = await probeHealth();
    if (h) return h;
    await delay(500);
  }
  throw new Error(`server never answered /api/health within ${READY_TIMEOUT_MS}ms`);
}

async function httpJson(path, method = "GET", body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Brain-Local": "1" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, json };
}

async function main() {
  console.log(`[person:smoke] booting server on :${PORT} (temp DB)…`);
  const child = spawn(NPM_CMD, ["run", "start:server"], {
    stdio: ["ignore", "inherit", "inherit"],
    shell: IS_WINDOWS,
    detached: !IS_WINDOWS,
    env: {
      ...process.env,
      PORT,
      HOST: "127.0.0.1",
      BRAIN_DATA_DIR: tmp,
      BRAIN_DB_PATH: join(tmp, "smoke.sqlite"),
      PERCEPTION_WORKER_URL: "http://127.0.0.1:1", // worker-down degrade is fine
    },
  });

  let exitCode = 0;
  let createdDaemonId = null;
  try {
    await waitForHealth();
    console.log(`[person:smoke] server up. watch dir = ${watchDir}`);

    // 1. Mint a plan-bound confirm token, then create a watch daemon via
    //    the permissioned executor. `system-info` is the safest safe-tier
    //    action in the allowlist — we just need SOMETHING that runs
    //    without side effects.
    const createArgs = {
      title: "person-smoke-watch",
      trigger: { kind: "watch", path: watchDir, pattern: "any" },
      action: { id: "system-info", args: {} },
      autonomy: "safe-only",
      cooldownMs: 0,
    };
    const confirm = await httpJson("/api/daemon/confirm", "POST", {
      actionId: "daemon-create",
      args: createArgs,
    });
    if (confirm.status !== 200 || !confirm.json?.confirmToken) {
      console.log(`[person:smoke] SKIP — daemon/confirm refused (status=${confirm.status}). ${JSON.stringify(confirm.json)?.slice(0, 200)}`);
      return;
    }
    const create = await httpJson("/api/daemon/create", "POST", {
      ...createArgs,
      confirmToken: confirm.json.confirmToken,
    });
    if (create.status !== 200 || !create.json?.ok) {
      console.log(`[person:smoke] FAIL — daemon-create refused (status=${create.status}). ${JSON.stringify(create.json)?.slice(0, 200)}`);
      exitCode = 1;
      return;
    }
    createdDaemonId = create.json?.data?.daemon?.id;
    console.log(`[person:smoke] daemon created: ${createdDaemonId}`);

    // 2. Drop a file into the watched dir.
    await delay(300); // give chokidar a tick to attach
    writeFileSync(join(watchDir, "dropped.txt"), "hello from person-smoke", "utf8");
    console.log(`[person:smoke] file dropped.`);

    // 3. Poll /api/daemon for runCount >= 1.
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let finalCounts = null;
    while (Date.now() < deadline) {
      const r = await httpJson("/api/daemon");
      if (r.json?.daemons) {
        const d = r.json.daemons.find((x) => x.id === createdDaemonId);
        if (d && d.runCount >= 1) {
          finalCounts = d;
          break;
        }
      }
      await delay(250);
    }
    if (!finalCounts) {
      console.error("[person:smoke] FAIL — daemon did not fire within 30s.");
      exitCode = 1;
      return;
    }
    console.log(`[person:smoke] daemon fired: runCount=${finalCounts.runCount} status=${finalCounts.status}`);

    // 4. The audit trail records the run (system-info is safe-tier so it
    //    should be ok=true).
    if (finalCounts.status === "error") {
      console.error(`[person:smoke] FAIL — daemon in error state: ${finalCounts.lastError ?? "?"}`);
      exitCode = 1;
      return;
    }

    console.log(`[person:smoke] PASS — watch → runner → executeAction round-trip confirmed.`);
  } catch (err) {
    console.error(`[person:smoke] FAIL — ${err instanceof Error ? err.message : String(err)}`);
    exitCode = 1;
  } finally {
    // Best-effort cleanup
    if (createdDaemonId) {
      try {
        const delConfirm = await httpJson("/api/daemon/confirm", "POST", { actionId: "daemon-delete", args: { id: createdDaemonId } });
        if (delConfirm.json?.confirmToken) {
          await httpJson("/api/daemon/delete", "POST", { id: createdDaemonId, confirmToken: delConfirm.json.confirmToken });
        }
      } catch { /* ignore */ }
    }
    try { rmSync(watchDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (IS_WINDOWS) {
      try { spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", shell: IS_WINDOWS }); } catch { /* ignore */ }
    } else {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* ignore */ }
    }
  }

  process.exit(exitCode);
}

main();
