// Offline, deterministic sanity check for the agent runtime + curiosity. No
// DB rows are read/written and no network is touched at RUNTIME.
// Run: npm --prefix server run agents:selfcheck
//
// Asserts (runtime):
//   (1) lifecycle order is init → think → act → shutdown,
//   (2) act() only runs after the safety gate is consulted for "act",
//   (3) an event emitted on the bus reaches the agent's handleEvent(),
//   (4) agent-status events are emitted across the lifecycle (bus delivery).
// Asserts (curiosity): the pure computeCuriosity() scorer — frontier fires,
//   noisy-TV avoided, empty corpus, topTarget, determinism/bounds, health damp.
//
// The safety gate is stubbed (not imported) so the runtime section stays free
// of that path. NOTE: importing core/curiosity.ts transitively loads
// causalMap.ts → sqlite.ts → better-sqlite3 (the native binding) at IMPORT
// time — but no DB file is opened, since openDb() is lazy and only the PURE
// computeCuriosity() is exercised here (gatherCuriosity() is never called).

import { BrainBus } from "../src/core/eventBus.js";
import { AgentRuntime } from "../src/agents/runtime.js";
import type { Agent, AgentContext } from "../src/agents/Agent.js";
import { computeCuriosity } from "../src/core/curiosity.js";
import type { CausalLink } from "../src/core/causalMap.js";
import { CURIOSITY_EXPLORE_THRESHOLD } from "../src/agents/idleAgent.js";

const lifecycle: string[] = [];
let receivedTestEvent = false;

class DummyAgent implements Agent {
  name(): string {
    return "dummy";
  }
  capabilities(): string[] {
    return ["selfcheck"];
  }
  init(_ctx: AgentContext): void {
    lifecycle.push("init");
  }
  handleEvent(event: Parameters<Agent["handleEvent"]>[0]): void {
    if (event.kind === "file-changed") receivedTestEvent = true;
  }
  think(): void {
    lifecycle.push("think");
  }
  act(): void {
    lifecycle.push("act");
  }
  shutdown(): void {
    lifecycle.push("shutdown");
  }
}

const safetyCalls: Array<{ agent: string; action: string }> = [];
const safety = {
  permitAndAudit(agent: string, action: string): boolean {
    safetyCalls.push({ agent, action });
    return true;
  },
};

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// Curiosity-section harness — PASS/FAIL line printer, accumulating failures.
// ---------------------------------------------------------------------------
let failures = 0;
function check(label: string, ok: boolean, extra?: unknown): void {
  if (!ok) failures += 1;
  const tag = ok ? "PASS" : "FAIL";
  if (extra === undefined) {
    console.log(`[${tag}] ${label}`);
  } else {
    console.log(`[${tag}] ${label} — ${JSON.stringify(extra)}`);
  }
}

/** CausalLink factory for the pure curiosity tests (no DB). */
function makeLink(over: Partial<CausalLink> = {}): CausalLink {
  return {
    causeClass: "deploy",
    effectClass: "failure",
    observations: 1,
    occurrences: 0,
    strength: 0.5,
    confidence: 1 - Math.exp(-1 / 5), // ≈ 0.18127 (one observation)
    lastObservedAt: new Date().toISOString(),
    source: "test",
    ...over,
  };
}

function runCuriosityChecks(): void {
  // (1) Frontier fires: a single fresh high-impact link → curiosity ≥ 0.7.
  // This is exactly what makes the IdleAgent switch to exploration-scheduled.
  const fresh = makeLink({ effectClass: "failure", confidence: 1 - Math.exp(-1 / 5) });
  const freshRes = computeCuriosity({ causalLinks: [fresh] });
  check(
    "curiosity: fresh high-impact link fires frontier (≥ threshold)",
    freshRes.curiosity >= CURIOSITY_EXPLORE_THRESHOLD,
    { curiosity: freshRes.curiosity, threshold: CURIOSITY_EXPLORE_THRESHOLD },
  );

  // (2) Noisy-TV avoided: a saturated corpus (high observations) with random-
  // looking strength must NOT spike curiosity. Epistemic confidence is high →
  // 1−confidence is tiny → nothing left to learn, even though strength≈0.5.
  const saturatedConf = 1 - Math.exp(-25 / 5); // ≈ 0.99326
  const saturated: CausalLink[] = [
    makeLink({ causeClass: "a", effectClass: "failure", observations: 25, confidence: saturatedConf, strength: 0.51 }),
    makeLink({ causeClass: "b", effectClass: "high-risk", observations: 25, confidence: saturatedConf, strength: 0.49 }),
    makeLink({ causeClass: "c", effectClass: "prediction-divergent", observations: 25, confidence: saturatedConf, strength: 0.5 }),
    makeLink({ causeClass: "d", effectClass: "success", observations: 25, confidence: saturatedConf, strength: 0.5 }),
  ];
  const saturatedRes = computeCuriosity({ causalLinks: saturated });
  check(
    "curiosity: noisy-TV avoided (saturated corpus < 0.3)",
    saturatedRes.curiosity < 0.3,
    { curiosity: saturatedRes.curiosity },
  );

  // (3) Empty corpus → curiosity 0, topTarget null.
  const empty = computeCuriosity({ causalLinks: [] });
  check(
    "curiosity: empty corpus → 0 / null",
    empty.curiosity === 0 && empty.topTarget === null,
    { curiosity: empty.curiosity, topTarget: empty.topTarget },
  );

  // (4) topTarget: the lower-confidence higher-impact link's causeClass wins.
  // Link A: high impact (failure) + low confidence → high information value.
  // Link B: lower impact (success) + high confidence → low information value.
  const linkA = makeLink({ causeClass: "deploy-migration", effectClass: "failure", observations: 1, confidence: 1 - Math.exp(-1 / 5) });
  const linkB = makeLink({ causeClass: "read-file", effectClass: "success", observations: 20, confidence: 1 - Math.exp(-20 / 5) });
  const twoRes = computeCuriosity({ causalLinks: [linkB, linkA] });
  check(
    "curiosity: topTarget = lower-confidence higher-impact causeClass",
    twoRes.topTarget === "deploy-migration",
    { topTarget: twoRes.topTarget },
  );

  // (5) Determinism + bounds: same input twice → identical; values in [0,1].
  const detA = computeCuriosity({ causalLinks: [fresh, ...saturated] });
  const detB = computeCuriosity({ causalLinks: [fresh, ...saturated] });
  const inBounds = (r: { curiosity: number; frontier: number }): boolean =>
    r.curiosity >= 0 && r.curiosity <= 1 && r.frontier >= 0 && r.frontier <= 1;
  check(
    "curiosity: deterministic + bounded across cases",
    detA.curiosity === detB.curiosity &&
      detA.frontier === detB.frontier &&
      detA.topTarget === detB.topTarget &&
      inBounds(freshRes) &&
      inBounds(saturatedRes) &&
      inBounds(empty) &&
      inBounds(twoRes) &&
      inBounds(detA),
    { detA, detB },
  );

  // (6) Health damping: low organism health suppresses exploration. The fresh
  // frontier link with health=0.1 must score LOWER than with health omitted.
  const healthy = computeCuriosity({ causalLinks: [fresh] }); // health omitted ⇒ factor 1
  const stressed = computeCuriosity({ causalLinks: [fresh], organismHealth: 0.1 });
  check(
    "curiosity: low health damps exploration below baseline",
    stressed.curiosity < healthy.curiosity,
    { stressed: stressed.curiosity, healthy: healthy.curiosity },
  );
}

async function main(): Promise<void> {
  const bus = new BrainBus();
  const statusEvents: string[] = [];
  bus.on("agent-status", (e) => statusEvents.push(e.state));

  const runtime = new AgentRuntime({ bus, safety, log: () => {} });
  runtime.register(new DummyAgent());

  await runtime.start();

  bus.emit({
    kind: "file-changed",
    path: "selfcheck.ts",
    change: "change",
    projectName: "selfcheck",
    at: new Date().toISOString(),
  });
  await flush();

  await runtime.cycleOnce();
  await runtime.stop();
  await flush();

  const order = lifecycle.join(",");
  const orderOk = order === "init,think,act,shutdown";
  const thinkBeforeAct = lifecycle.indexOf("think") < lifecycle.indexOf("act");
  const safetyGatedAct = safetyCalls.some((c) => c.agent === "dummy" && c.action === "act");
  const eventDelivered = receivedTestEvent;
  const statusDelivered =
    statusEvents.includes("thinking") &&
    statusEvents.includes("acting") &&
    statusEvents.includes("stopped");

  // Roll the pre-existing runtime assertions into the same failure counter the
  // curiosity section uses, so a single result reflects BOTH sections.
  check("runtime: lifecycle order init,think,act,shutdown", orderOk, { order });
  check("runtime: think before act", thinkBeforeAct);
  check("runtime: act is safety-gated", safetyGatedAct);
  check("runtime: bus event delivered to handleEvent", eventDelivered);
  check("runtime: agent-status events delivered", statusDelivered, { statusEvents });

  // Curiosity section — pure computeCuriosity tests, no DB.
  runCuriosityChecks();

  const result = failures === 0 ? "PASS" : "FAIL";
  console.log(JSON.stringify({ failures, result }));

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("agents-selfcheck crashed:", err);
  process.exit(2);
});
