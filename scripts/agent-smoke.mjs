// Agentic-loop smoke: boots the server and fires LIVE POST /api/agent requests
// against the real DB + a local chat model, proving the brain's "main thinking"
// works end-to-end — triage→pipeline for a plain question, and the ReAct loop
// driving real tools through the permissioned executor (safe auto-run + granted
// session-scope) for a command. This is the runtime check the default gate skips
// (it needs Ollama). Uses a THROWAWAY DB so the scope-mode note never pollutes
// the developer's real store.
//
// NOT in the default gate; run via `npm run agent:smoke` or the GATE_ASK_SMOKE=1
// gate tail. SKIPS cleanly (exit 0) when no chat model is reachable.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = process.env.SMOKE_PORT ?? "8804";
const BASE = `http://127.0.0.1:${PORT}`;
const READY_TIMEOUT_MS = 45_000;
const TURN_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS ?? 200_000);
const IS_WINDOWS = process.platform === "win32";
const NPM_CMD = IS_WINDOWS ? "npm.cmd" : "npm";
const tmp = mkdtempSync(join(tmpdir(), "brain-agentsmoke-"));

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

// Drive ONE /api/agent (or /api/agent/confirm) turn; collect the agent frames.
async function runTurn(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Brain-Local": "1" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`${path} returned HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const out = { final: "", tools: [], error: null, confirm: null, status: null, sawDone: false };
  const deadline = Date.now() + TURN_TIMEOUT_MS;
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
      if (evLine && evLine.slice(6).trim() === "done") { out.sawDone = true; break outer; }
      if (!dataLine) continue;
      const json = dataLine.slice(5).trim();
      if (!json || json === "{}") continue;
      let ev;
      try { ev = JSON.parse(json); } catch { continue; }
      if (!ev.type) continue; // PipelineEvent telemetry — skip
      if (ev.type === "final") out.final = ev.text ?? out.final;
      else if (ev.type === "tool-result" && ev.tool) out.tools.push(ev.tool);
      else if (ev.type === "confirm-request" && ev.confirm) out.confirm = ev.confirm;
      else if (ev.type === "error") out.error = ev.detail ?? "error";
      else if (ev.type === "metrics" && ev.metrics) out.status = ev.metrics.status;
    }
  }
  return out;
}

async function main() {
  console.log(`[agent:smoke] booting server on :${PORT} (temp DB)…`);
  const child = spawn(NPM_CMD, ["run", "start:server"], {
    stdio: ["ignore", "inherit", "inherit"],
    shell: IS_WINDOWS,
    detached: !IS_WINDOWS,
    env: { ...process.env, PORT, HOST: "127.0.0.1", BRAIN_DATA_DIR: tmp, BRAIN_DB_PATH: join(tmp, "smoke.sqlite") },
  });

  let exitCode = 0;
  try {
    const h = await waitForHealth();
    const okConnectors = Array.isArray(h.connectors) ? h.connectors.filter((c) => c.state === "ok") : [];
    if (okConnectors.length === 0) {
      console.log("[agent:smoke] SKIP — no local chat model reachable (no connector in state 'ok').");
      console.log('[agent:smoke] "result": "SKIP"');
      exitCode = 0;
    } else {
      let failures = 0;
      const check = (label, ok, extra = "") => {
        console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
        if (!ok) failures++;
      };

      // 1) Plain question → triage routes to the 7-step pipeline → final answer.
      const q = await runTurn("/api/agent", { prompt: "In one word, what is two plus two?" });
      check("plain question completes with a final answer", q.sawDone && !q.error && q.final.length > 0, q.final.slice(0, 60));

      // 2) Command → the loop runs a SAFE tool autonomously (safe-only mode).
      const sys = await runTurn("/api/agent", {
        prompt: "Use your tools to report this computer's system info (CPU, memory, platform), then tell me.",
        forceLoop: true,
        confirmMode: "safe-only",
      });
      const ranSafe = sys.tools.some((t) => t.ok && t.risk === "safe");
      check("command turn completes (loop + final answer)", sys.sawDone && !sys.error && sys.final.length > 0, sys.final.slice(0, 60));
      check("loop ran a safe tool autonomously", ranSafe, sys.tools.map((t) => `${t.actionId}:${t.ok ? "ok" : "x"}`).join(",") || "(model answered directly)");

      // 3) Confirm-tier under granted session-scope → autonomous, honestly audited.
      const scoped = await runTurn("/api/agent", {
        prompt: 'Save a note that says "agent smoke milk".',
        forceLoop: true,
        confirmMode: "scope",
        scope: { allow: ["safe", "confirm"] },
      });
      const note = scoped.tools.find((t) => t.actionId === "create-note");
      check("scope-mode turn completes", scoped.sawDone && !scoped.error, scoped.final.slice(0, 60));
      if (note) {
        check("scope: create-note ran via session-scope (honest audit)", note.ok === true && note.authorizedVia === "session-scope");
      } else {
        console.log("INFO  scope: model didn't choose create-note this run (tools: " +
          (scoped.tools.map((t) => t.actionId).join(",") || "none") + ") — loop + scope path still exercised by the selfcheck");
      }

      if (failures === 0) {
        console.log("[agent:smoke] ALL CHECKS PASSED — /api/agent main-thinking path works end-to-end.");
        console.log('[agent:smoke] "result": "PASS"');
      } else {
        throw new Error(`${failures} agent-smoke check(s) failed`);
      }
    }
  } catch (err) {
    exitCode = 1;
    console.error("[agent:smoke] FAILED:", err instanceof Error ? err.message : err);
    console.error('[agent:smoke] "result": "FAIL"');
  } finally {
    console.log("[agent:smoke] shutting down server…");
    if (child && child.exitCode === null) {
      if (IS_WINDOWS) {
        await new Promise((resolve) => {
          const k = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
          k.on("exit", () => resolve());
          k.on("error", () => resolve());
        });
      } else {
        try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
        await delay(500);
      }
    }
    process.exit(exitCode);
  }
}

main();
