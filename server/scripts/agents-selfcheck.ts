// Offline, deterministic sanity check for the agent runtime. No DB / network.
// Run: npm --prefix server run agents:selfcheck
//
// Asserts:
//   (1) lifecycle order is init → think → act → shutdown,
//   (2) act() only runs after the safety gate is consulted for "act",
//   (3) an event emitted on the bus reaches the agent's handleEvent(),
//   (4) agent-status events are emitted across the lifecycle (bus delivery).
//
// Imports only the pure modules (runtime + eventBus). It deliberately does NOT
// import core/safety.ts (that pulls in better-sqlite3) — the gate is stubbed
// here so the check stays free of native deps, mirroring ranker:selfcheck.

import { BrainBus } from "../src/core/eventBus.js";
import { AgentRuntime } from "../src/agents/runtime.js";
import type { Agent, AgentContext } from "../src/agents/Agent.js";

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

  const ok =
    orderOk && thinkBeforeAct && safetyGatedAct && eventDelivered && statusDelivered;

  console.log(
    JSON.stringify(
      {
        lifecycle: order,
        orderOk,
        thinkBeforeAct,
        safetyGatedAct,
        eventDelivered,
        statusEvents,
        statusDelivered,
        result: ok ? "PASS" : "FAIL",
      },
      null,
      2,
    ),
  );

  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("agents-selfcheck crashed:", err);
  process.exit(2);
});
