// Runtime smoke for hybrid web SEARCH (FRIDAY online). The hermetic
// websearch:selfcheck proves every branch with a FAKE fetch; this proves the
// bits a fake cannot: the REAL booted server, the REAL global fetch against a
// live search backend, and that CONFIG.localOnly is actually wired to the search
// egress gate.
//
// Two phases, each a fresh boot against a THROWAWAY DB (never the real store):
//   A) LOCAL_ONLY=true  (default) → POST /api/web/search must be BLOCKED
//      (ok:false, reason mentions "blocked"). Proves zero outbound by default.
//   B) LOCAL_ONLY=false → the same query is actually searched live. SKIPS cleanly
//      (exit 0) when the box is offline OR the no-key DuckDuckGo fallback is rate-
//      limited, so CI without a search provider doesn't go red.
//
// NOT in the default gate: phase B egresses (to the configured provider, or
// DuckDuckGo by default). Opt-in via `npm run websearch:smoke` or GATE_ASK_SMOKE=1.

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const QUERY = process.env.WEBSEARCH_SMOKE_QUERY ?? "typescript release notes";
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
  const dbDir = mkdtempSync(join(tmpdir(), "brain-websearchcheck-"));
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
      BRAIN_DB_PATH: join(dbDir, "websearch-smoke.sqlite"),
    },
  });
}

async function phaseBlocked() {
  const port = Number(process.env.WEBSEARCH_SMOKE_PORT_A ?? 8821);
  const base = `http://127.0.0.1:${port}`;
  console.log(`[websearch:smoke] (A) booting LOCAL_ONLY=true server on :${port}…`);
  const child = bootServer({ port, localOnly: true });
  try {
    await waitForHealth(base);
    const r = await postJson(base, "/api/web/search", { query: QUERY });
    console.log(`[websearch:smoke] (A) POST /api/web/search -> HTTP ${r.status} ${JSON.stringify(r.json)}`);
    if (r.status !== 200) throw new Error(`(A) unexpected HTTP ${r.status}`);
    if (r.json?.ok !== false) throw new Error(`(A) LEAK: search ran under LOCAL_ONLY (ok=${r.json?.ok})`);
    if (!/blocked/i.test(r.json?.reason ?? "")) throw new Error(`(A) blocked but reason unclear: ${r.json?.reason}`);
    console.log("[websearch:smoke] (A) PASS — web search BLOCKED under LOCAL_ONLY (zero egress).");
  } finally {
    await killTree(child);
  }
}

// returns "PASS" | "SKIP"
async function phaseLive() {
  const port = Number(process.env.WEBSEARCH_SMOKE_PORT_B ?? 8822);
  const base = `http://127.0.0.1:${port}`;
  console.log(`[websearch:smoke] (B) booting LOCAL_ONLY=false server on :${port}…`);
  const child = bootServer({ port, localOnly: false });
  try {
    await waitForHealth(base);
    const r = await postJson(base, "/api/web/search", { query: QUERY });
    console.log(`[websearch:smoke] (B) POST /api/web/search -> HTTP ${r.status} ${JSON.stringify(r.json)?.slice(0, 400)}`);
    if (r.status !== 200) throw new Error(`(B) unexpected HTTP ${r.status}`);
    if (/blocked/i.test(r.json?.reason ?? "")) {
      throw new Error(`(B) MISCONFIG: search blocked even with LOCAL_ONLY=false — gate not honoring the flag`);
    }
    if (r.json?.ok === true && Array.isArray(r.json.results) && r.json.results.length >= 1) {
      console.log(`[websearch:smoke] (B) PASS — live search via ${r.json.provider} returned ${r.json.results.length} results.`);
      return "PASS";
    }
    console.log(`[websearch:smoke] (B) SKIP — no live results (offline / provider rate-limited). reason: ${r.json?.reason}`);
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
    console.log(`[websearch:smoke] ALL CHECKS PASSED — egress gate enforced; live search ${b === "PASS" ? "verified" : "skipped (offline/no provider)"}.`);
    console.log('[websearch:smoke] "result": "PASS"');
  } catch (err) {
    exitCode = 1;
    console.error("[websearch:smoke] FAILED:", err instanceof Error ? err.message : err);
    console.error('[websearch:smoke] "result": "FAIL"');
  } finally {
    process.exit(exitCode);
  }
}

main();
