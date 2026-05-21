// AgentRuntime — the "brain core" lifecycle manager.
//
// Owns the set of registered agents and drives the three loops:
//   start()      -> init() each agent, wire its handleEvent() to the bus
//   cycleOnce()  -> for each agent: think(), then (if safety permits) act()
//   stop()       -> shutdown() each agent, detach handlers
//
// Faults are isolated per agent: one agent throwing in any phase is logged and
// reported as agent-status "error" but never wedges the others or the loop.

import type { Agent, AgentContext, AgentLifecycleState } from "./Agent.js";
import type { BrainBus, BrainEvent } from "../core/eventBus.js";
import type { SafetyGate } from "../core/safety.js";

export interface AgentRuntimeDeps {
  bus: BrainBus;
  safety: SafetyGate;
  log?: (message: string) => void;
}

export class AgentRuntime {
  private readonly bus: BrainBus;
  private readonly safety: SafetyGate;
  private readonly baseLog: (message: string) => void;
  private readonly agents: Agent[] = [];
  private readonly unsubscribers: Array<() => void> = [];
  private started = false;
  private cycleRunning = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: AgentRuntimeDeps) {
    this.bus = deps.bus;
    this.safety = deps.safety;
    this.baseLog = deps.log ?? ((m) => console.log(m));
  }

  register(agent: Agent): void {
    if (this.started) {
      throw new Error("AgentRuntime: register before start()");
    }
    this.agents.push(agent);
  }

  private contextFor(agent: Agent): AgentContext {
    const name = agent.name();
    return {
      bus: this.bus,
      safety: this.safety,
      log: (message: string) => this.baseLog(`[agent:${name}] ${message}`),
      setStatus: (state: AgentLifecycleState, detail?: string) =>
        this.bus.emit({
          kind: "agent-status",
          agent: name,
          state,
          detail,
          at: new Date().toISOString(),
        }),
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const agent of this.agents) {
      const ctx = this.contextFor(agent);
      try {
        ctx.setStatus("init");
        await agent.init(ctx);
        // Reactive wiring: every bus event reaches every agent's handleEvent.
        this.unsubscribers.push(
          this.bus.onAny((event: BrainEvent) => {
            Promise.resolve()
              .then(() => agent.handleEvent(event))
              .catch((err) =>
                ctx.log(`handleEvent threw: ${err instanceof Error ? err.message : String(err)}`),
              );
          }),
        );
        ctx.setStatus("idle");
      } catch (err) {
        ctx.setStatus("error", err instanceof Error ? err.message : String(err));
        ctx.log(`init failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** One think/act pass over all agents. Used directly by the self-check. */
  async cycleOnce(): Promise<void> {
    if (this.cycleRunning) return;
    this.cycleRunning = true;
    try {
      for (const agent of this.agents) {
        const ctx = this.contextFor(agent);
        try {
          ctx.setStatus("thinking");
          await agent.think();
          if (this.safety.permitAndAudit(agent.name(), "act")) {
            ctx.setStatus("acting");
            await agent.act();
          }
          ctx.setStatus("idle");
        } catch (err) {
          ctx.setStatus("error", err instanceof Error ? err.message : String(err));
          ctx.log(`cycle failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      this.cycleRunning = false;
    }
  }

  /** Production loop. Skips a tick if the previous cycle is still running. */
  startCycle(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.cycleOnce();
    }, intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const unsub of this.unsubscribers.splice(0)) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    for (const agent of this.agents) {
      const ctx = this.contextFor(agent);
      try {
        await agent.shutdown();
        ctx.setStatus("stopped");
      } catch (err) {
        ctx.log(`shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.started = false;
  }
}
