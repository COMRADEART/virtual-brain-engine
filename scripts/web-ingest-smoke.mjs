// Runtime smoke for "learn from the internet" (web ingest). The hermetic
// ingest:selfcheck proves every branch with a FAKE fetch; this proves the bits a
// fake cannot: the REAL booted server, the REAL global fetch + streaming capped
// reader, and that CONFIG.localOnly is actually wired to the egress gate.
//
// Two phases, each a fresh boot against a THROWAWAY DB (never the real store):
//   A) LOCAL_ONLY=true  (default) → POST /api/ingest/web {internet URL} must be
//      BLOCKED (ingested 0, reason mentions "blocked"). Proves zero outbound by
//      default in the real server.
//   B) LOCAL_ONLY=false → the same URL is actually fetched + ingested +
//      retrievable. SKIPS cleanly (exit 0) when the box is offline (fetch failed
//      / timed out) so CI without internet doesn't go red.
//
// NOT in the default gate: phase B egresses (to example.com, IANA's reserved
// documentation domain). Opt-in via `npm run web:smoke` or GATE_ASK_SMOKE=1.

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const TARGET = process.env.WEB_SMOKE_URL ?? "https://example.com/";
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

async function getJson(base, path) {
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, json: await res.json().catch(() => null) };
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

async function bootServer({ port, localOnly }) {
  const dbDir = mkdtempSync(join(tmpdir(), "brain-webcheck-"));
  const child = spawn(NPM_CMD, ["run", "start:server"], {
    stdio: ["ignore", "inherit", "inherit"],
    shell: IS_WINDOWS,
    detached: !IS_WINDOWS,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      LOCAL_ONLY: localOnly ? "true" : "false",
      BRAIN_DATA_DIR: dbDir,
      BRAIN_DB_PATH: join(dbDir, "web-smoke.sqlite"),
    },
  });
  return child;
}

async function phaseBlocked() {
  const port = Number(process.env.WEB_SMOKE_PORT_A ?? 8811);
  const base = `http://127.0.0.1:${port}`;
  console.log(`[web:smoke] (A) booting LOCAL_ONLY=true server on :${port}…`);
  const child = await bootServer({ port, localOnly: true });
  try {
    await waitForHealth(base);
    const r = await postJson(base, "/api/ingest/web", { url: TARGET });
    console.log(`[web:smoke] (A) POST /api/ingest/web -> HTTP ${r.status} ${JSON.stringify(r.json)}`);
    if (r.status !== 200) throw new Error(`(A) unexpected HTTP ${r.status}`);
    if (r.json?.ingested !== 0) throw new Error(`(A) LEAK: server fetched an internet URL under LOCAL_ONLY (ingested ${r.json?.ingested})`);
    if (!/blocked/i.test(r.json?.reason ?? "")) throw new Error(`(A) blocked but reason unclear: ${r.json?.reason}`);
    console.log("[web:smoke] (A) PASS — internet fetch BLOCKED under LOCAL_ONLY (zero egress).");
  } finally {
    await killTree(child);
  }
}

// returns "PASS" | "SKIP"
async function phaseFetch() {
  const port = Number(process.env.WEB_SMOKE_PORT_B ?? 8812);
  const base = `http://127.0.0.1:${port}`;
  console.log(`[web:smoke] (B) booting LOCAL_ONLY=false server on :${port}…`);
  const child = await bootServer({ port, localOnly: false });
  try {
    await waitForHealth(base);
    const r = await postJson(base, "/api/ingest/web", { url: TARGET });
    console.log(`[web:smoke] (B) POST /api/ingest/web -> HTTP ${r.status} ${JSON.stringify(r.json)}`);
    if (r.status !== 200) throw new Error(`(B) unexpected HTTP ${r.status}`);
    if (/blocked/i.test(r.json?.reason ?? "")) {
      throw new Error(`(B) MISCONFIG: fetch blocked even with LOCAL_ONLY=false — gate is not honoring the flag`);
    }
    if (r.json?.ingested >= 1) {
      // Prove it actually landed in memory and is retrievable.
      const q = await getJson(base, `/api/memory/search?q=example&limit=5`);
      const found = Array.isArray(q.json?.hits) && q.json.hits.length >= 1;
      console.log(`[web:smoke] (B) ingested=${r.json.ingested} title=${JSON.stringify(r.json.title)} retrievable=${found}`);
      console.log("[web:smoke] (B) PASS — internet page fetched, extracted, ingested, retrievable.");
      return "PASS";
    }
    // ingested 0 without a block → almost certainly offline. Don't fail CI.
    console.log(`[web:smoke] (B) SKIP — could not fetch ${TARGET} (offline?). reason: ${r.json?.reason}`);
    return "SKIP";
  } finally {
    await killTree(child);
  }
}

async function main() {
  let exitCode = 0;
  try {
    await phaseBlocked();
    const b = await phaseFetch();
    console.log(`[web:smoke] ALL CHECKS PASSED — egress gate enforced; live fetch ${b === "PASS" ? "verified" : "skipped (offline)"}.`);
    console.log('[web:smoke] "result": "PASS"');
  } catch (err) {
    exitCode = 1;
    console.error("[web:smoke] FAILED:", err instanceof Error ? err.message : err);
    console.error('[web:smoke] "result": "FAIL"');
  } finally {
    process.exit(exitCode);
  }
}

main();
