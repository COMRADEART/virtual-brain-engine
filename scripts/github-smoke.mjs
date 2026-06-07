// Runtime smoke for GitHub project discovery ("learn from popular repos"). The
// hermetic github:selfcheck proves every branch with a FAKE fetch; this proves
// the bits a fake cannot: the REAL booted server, the REAL global fetch against
// the live api.github.com, and that CONFIG.localOnly is actually wired to the
// discovery egress gate.
//
// Two phases, each a fresh boot against a THROWAWAY DB (never the real store):
//   A) LOCAL_ONLY=true  (default) → POST /api/github/discover must be BLOCKED
//      (ok:false, reason mentions "blocked"). Proves zero outbound by default.
//   B) LOCAL_ONLY=false → the same topic is discovered live. SKIPS cleanly
//      (exit 0) when the box is offline OR GitHub rate-limits the unauthenticated
//      search (set GITHUB_TOKEN to make it reliable), so CI stays green.
//
// NOT in the default gate: phase B egresses to api.github.com. Opt-in via
// `npm run github:smoke` or GATE_ASK_SMOKE=1.

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const QUERY = process.env.GITHUB_SMOKE_QUERY ?? "react";
const READY_TIMEOUT_MS = 45_000;
const REQ_TIMEOUT_MS = 30_000;
const IS_WINDOWS = process.platform === "win32";
const NPM_CMD = IS_WINDOWS ? "npm.cmd" : "npm";
const headers = { "Content-Type": "application/json", "X-Brain-Local": "1" };

async function probeHealth(base) {
  try {
    const res = await fetch(`${base}/api/health`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function waitForHealth(base) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const h = await probeHealth(base);
    if (h) return h;
    await delay(500);
  }
  throw new Error(`server never answered /api/health at ${base}`);
}

async function postJson(base, path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    return { status: res.status, json: await res.json().catch(() => null) };
  } finally {
    clearTimeout(timer);
  }
}

async function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (IS_WINDOWS) {
    await new Promise((resolve) => {
      const k = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      k.on("exit", () => resolve());
      k.on("error", () => resolve());
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
  await delay(500);
}

function bootServer({ port, localOnly }) {
  const dbDir = mkdtempSync(join(tmpdir(), "brain-githubcheck-"));
  return spawn(NPM_CMD, ["run", "start:server"], {
    stdio: ["ignore", "inherit", "inherit"],
    shell: IS_WINDOWS,
    detached: !IS_WINDOWS,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      LOCAL_ONLY: localOnly ? "true" : "false",
      BRAIN_DATA_DIR: dbDir,
      BRAIN_DB_PATH: join(dbDir, "github-smoke.sqlite"),
    },
  });
}

async function phaseBlocked() {
  const port = Number(process.env.GITHUB_SMOKE_PORT_A ?? 8823);
  const base = `http://127.0.0.1:${port}`;
  console.log(`[github:smoke] (A) booting LOCAL_ONLY=true server on :${port}…`);
  const child = bootServer({ port, localOnly: true });
  try {
    await waitForHealth(base);
    const r = await postJson(base, "/api/github/discover", { query: QUERY });
    console.log(`[github:smoke] (A) POST /api/github/discover -> HTTP ${r.status} ${JSON.stringify(r.json)}`);
    if (r.status !== 200) throw new Error(`(A) unexpected HTTP ${r.status}`);
    if (r.json?.ok !== false) throw new Error(`(A) LEAK: discovery ran under LOCAL_ONLY (ok=${r.json?.ok})`);
    if (!/blocked/i.test(r.json?.reason ?? "")) throw new Error(`(A) blocked but reason unclear: ${r.json?.reason}`);
    console.log("[github:smoke] (A) PASS — GitHub discovery BLOCKED under LOCAL_ONLY (zero egress).");
  } finally {
    await killTree(child);
  }
}

// returns "PASS" | "SKIP"
async function phaseLive() {
  const port = Number(process.env.GITHUB_SMOKE_PORT_B ?? 8824);
  const base = `http://127.0.0.1:${port}`;
  console.log(`[github:smoke] (B) booting LOCAL_ONLY=false server on :${port}…`);
  const child = bootServer({ port, localOnly: false });
  try {
    await waitForHealth(base);
    const r = await postJson(base, "/api/github/discover", { query: QUERY, limit: 5 });
    console.log(`[github:smoke] (B) POST /api/github/discover -> HTTP ${r.status} ${JSON.stringify(r.json)?.slice(0, 500)}`);
    if (r.status !== 200) throw new Error(`(B) unexpected HTTP ${r.status}`);
    if (/blocked/i.test(r.json?.reason ?? "")) {
      throw new Error(`(B) MISCONFIG: discovery blocked even with LOCAL_ONLY=false — gate not honoring the flag`);
    }
    if (r.json?.ok === true && Array.isArray(r.json.repos) && r.json.repos.length >= 1) {
      const allOver1k = r.json.repos.every((x) => typeof x.stars === "number" && x.stars >= 1000);
      if (!allOver1k) throw new Error(`(B) a repo below the min-stars floor slipped through`);
      const top = r.json.repos[0];
      console.log(`[github:smoke] (B) PASS — live discovery returned ${r.json.repos.length} repos; top: ${top.fullName} (★${top.stars}).`);
      return "PASS";
    }
    console.log(`[github:smoke] (B) SKIP — no live results (offline / GitHub rate-limited; set GITHUB_TOKEN). reason: ${r.json?.reason}`);
    return "SKIP";
  } finally {
    await killTree(child);
  }
}

async function main() {
  let exitCode = 0;
  try {
    await phaseBlocked();
    const b = await phaseLive();
    console.log(`[github:smoke] ALL CHECKS PASSED — egress gate enforced; live discovery ${b === "PASS" ? "verified" : "skipped (offline/rate-limited)"}.`);
    console.log('[github:smoke] "result": "PASS"');
  } catch (err) {
    exitCode = 1;
    console.error("[github:smoke] FAILED:", err instanceof Error ? err.message : err);
    console.error('[github:smoke] "result": "FAIL"');
  } finally {
    process.exit(exitCode);
  }
}

main();
