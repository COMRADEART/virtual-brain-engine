// LLM-path smoke for the command/action layer: boots the server, fires a live
// POST /api/actions/resolve against the real connector, and proves the resolver
// turns a plain command into a VALIDATED, ALLOWLISTED plan — then executes it
// end-to-end (with the confirm token for a confirm-tier plan). This is the gap
// the hermetic actions:selfcheck cannot cover (it stubs the LLM): whether the
// real model emits allowlisted, parseable JSON.
//
// NOT in the default gate: needs a local chat model and a cold load is slow.
// Opt-in via `npm run actions:smoke` or the GATE_ASK_SMOKE=1 gate tail. SKIPS
// cleanly (exit 0) when no chat model is reachable.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const PORT = process.env.SMOKE_PORT ?? "8801";
const BASE = `http://127.0.0.1:${PORT}`;
const READY_TIMEOUT_MS = 45_000;
const RESOLVE_TIMEOUT_MS = Number(process.env.RESOLVE_TIMEOUT_MS ?? 120_000);
const PROMPT = process.env.ACTIONS_PROMPT ?? "list my most recent memories";
const IS_WINDOWS = process.platform === "win32";
const NPM_CMD = IS_WINDOWS ? "npm.cmd" : "npm";

const headers = { "Content-Type": "application/json", "X-Brain-Local": "1" };

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
  throw new Error(`server never answered /api/health at ${BASE} within ${READY_TIMEOUT_MS}ms`);
}

async function postJson(path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RESOLVE_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

async function runResolveExecute() {
  // 0) Derive the allowlist from the LIVE registry (GET /api/actions) rather than
  // a hand-maintained mirror — a stale local copy would spuriously reject a
  // newly-added action (e.g. learn-url) the resolver legitimately picks.
  const specs = await fetch(`${BASE}/api/actions`).then((r) => r.json()).catch(() => null);
  const allowlist = new Set((specs?.actions ?? []).map((s) => s.id));
  if (allowlist.size === 0) throw new Error("GET /api/actions returned no specs");

  // 1) Resolve a plain command into a plan.
  const resolved = await postJson("/api/actions/resolve", { prompt: PROMPT });
  console.log(`[actions:smoke] POST /api/actions/resolve -> HTTP ${resolved.status}`);
  console.log(`[actions:smoke] resolve body: ${JSON.stringify(resolved.json)}`);
  if (resolved.status !== 200 || !resolved.json) throw new Error(`/api/actions/resolve returned HTTP ${resolved.status}`);

  const { plan, needsConfirm, confirmToken } = resolved.json;
  if (!plan) {
    throw new Error(`model produced no allowlisted plan for "${PROMPT}" (reason: ${resolved.json.reason})`);
  }
  if (!allowlist.has(plan.actionId)) {
    throw new Error(`resolver returned a NON-allowlisted action id: ${plan.actionId}`);
  }
  console.log(`[actions:smoke] plan: actionId=${plan.actionId} needsConfirm=${needsConfirm} confidence=${plan.confidence}`);

  // 2) Execute it end-to-end (confirm-tier carries the minted token).
  const execBody = { actionId: plan.actionId, args: plan.args };
  if (needsConfirm) execBody.confirmToken = confirmToken;
  const executed = await postJson("/api/actions/execute", execBody);
  console.log(`[actions:smoke] POST /api/actions/execute -> HTTP ${executed.status}`);
  console.log(`[actions:smoke] execute body: ${JSON.stringify(executed.json)?.slice(0, 300)}`);
  if (executed.status !== 200 || !executed.json?.ok) {
    throw new Error(`execute failed: HTTP ${executed.status} ${JSON.stringify(executed.json)}`);
  }
  console.log("[actions:smoke] ALL CHECKS PASSED — live resolve → validated allowlisted plan → execute.");
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

async function main() {
  console.log(`[actions:smoke] booting server on :${PORT}…`);
  const child = spawn(NPM_CMD, ["run", "start:server"], {
    stdio: ["ignore", "inherit", "inherit"],
    shell: IS_WINDOWS,
    detached: !IS_WINDOWS,
    env: { ...process.env, PORT, HOST: "127.0.0.1" },
  });

  let exitCode = 0;
  try {
    const h = await waitForHealth();
    const okConnectors = Array.isArray(h.connectors) ? h.connectors.filter((c) => c.state === "ok") : [];
    if (okConnectors.length === 0) {
      console.log("[actions:smoke] SKIP — no local chat model reachable (no connector in state 'ok').");
      console.log('[actions:smoke] "result": "SKIP"');
      exitCode = 0;
    } else {
      await runResolveExecute();
    }
  } catch (err) {
    exitCode = 1;
    console.error("[actions:smoke] FAILED:", err instanceof Error ? err.message : err);
    console.error('[actions:smoke] "result": "FAIL"');
  } finally {
    console.log("[actions:smoke] shutting down server…");
    await killTree(child);
    process.exit(exitCode);
  }
}

main();
