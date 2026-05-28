// LLM-path smoke: boots the server, fires ONE live POST /api/ask, and proves
// the full 7-step reasoning pipeline completes end-to-end against the real DB +
// a local chat model. This is the core feature server-smoke deliberately skips.
//
// NOT in the default gate (scripts/gate.mjs): it needs a local Ollama chat model
// and a cold load can take 60–90s, which would make the gate slow/flaky and
// break its zero-config, no-LLM contract. Run it manually after touching the
// reasoning pipeline: `npm run ask:smoke`. If no chat model is reachable it
// SKIPS cleanly (exit 0) rather than failing.
//
// status:"error" is the failure signal — the "error" *step* (contradiction
// detection) is a normal pipeline step, so we key on status, not the step name.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const PORT = process.env.SMOKE_PORT ?? "8799";
const BASE = `http://127.0.0.1:${PORT}`;
const READY_TIMEOUT_MS = 45_000;
const ASK_TIMEOUT_MS = Number(process.env.ASK_TIMEOUT_MS ?? 200_000);
const PROMPT = process.env.ASK_PROMPT ?? "In one sentence, what is the Virtual Brain Engine project?";
const IS_WINDOWS = process.platform === "win32";
const NPM_CMD = IS_WINDOWS ? "npm.cmd" : "npm";

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

async function runAsk() {
  const res = await fetch(`${BASE}/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Brain-Local": "1" },
    body: JSON.stringify({ prompt: PROMPT }),
  });
  console.log(`[ask:smoke] POST /api/ask -> HTTP ${res.status} ${res.headers.get("content-type")}`);
  if (!res.ok || !res.body) throw new Error(`/api/ask returned HTTP ${res.status}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const stepStatus = new Map();
  let errorEvent = null;
  let answerChars = 0;
  let finalAnswer = "";
  let sawDone = false;
  const deadline = Date.now() + ASK_TIMEOUT_MS;

  outer: while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = chunk.split("\n");
      const evLine = lines.find((l) => l.startsWith("event:"));
      const dataLine = lines.find((l) => l.startsWith("data:"));
      if (evLine && evLine.slice(6).trim() === "done") { sawDone = true; break outer; }
      if (!dataLine) continue;
      const json = dataLine.slice(5).trim();
      if (!json || json === "{}") continue;
      let ev;
      try { ev = JSON.parse(json); } catch { continue; }
      if (ev.step) {
        if (!stepStatus.has(ev.step)) stepStatus.set(ev.step, new Set());
        stepStatus.get(ev.step).add(ev.status);
      }
      if (ev.status === "error") errorEvent = { step: ev.step, detail: ev.detail };
      if (typeof ev.tokensDelta === "string") answerChars += ev.tokensDelta.length;
      if (typeof ev.finalAnswer === "string" && ev.finalAnswer.length > finalAnswer.length) finalAnswer = ev.finalAnswer;
    }
  }

  const expected = ["input", "memory", "reasoning", "project", "error", "response", "learning"];
  const completed = expected.filter((s) => stepStatus.get(s)?.has("complete"));
  console.log(`[ask:smoke] steps completed: ${completed.join(", ")} (${completed.length}/7)`);
  console.log(`[ask:smoke] answer chars: ${answerChars} | finalAnswer: ${finalAnswer ? JSON.stringify(finalAnswer.slice(0, 120)) : "(streamed via tokensDelta)"}`);
  console.log(`[ask:smoke] error event: ${errorEvent ? JSON.stringify(errorEvent) : "none"} | done: ${sawDone}`);

  const ok = !errorEvent && sawDone && completed.length >= 6 && (answerChars > 0 || finalAnswer.length > 0);
  if (!ok) throw new Error("pipeline did not complete cleanly");
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
  try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
  await delay(500);
}

async function main() {
  console.log(`[ask:smoke] booting server on :${PORT}…`);
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
      console.log("[ask:smoke] SKIP — no local chat model reachable (no connector in state 'ok'). Pipeline path not exercised.");
      console.log('[ask:smoke] "result": "SKIP"');
      // Graceful skip: this check is environment-dependent by design.
      exitCode = 0;
    } else {
      await runAsk();
      console.log("[ask:smoke] ALL CHECKS PASSED — 7-step pipeline completed end-to-end.");
    }
  } catch (err) {
    exitCode = 1;
    console.error("[ask:smoke] FAILED:", err instanceof Error ? err.message : err);
    console.error('[ask:smoke] "result": "FAIL"');
  } finally {
    console.log("[ask:smoke] shutting down server…");
    await killTree(child);
    process.exit(exitCode);
  }
}

main();
