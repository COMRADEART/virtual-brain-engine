// The custom agent contract for the COMPUTER BRAIN agentic layer.
//
// This mirrors, 1:1, the Rust trait sketched in report.txt
// (name / capabilities / init / handle_event / think / act / shutdown) but in
// TypeScript on top of the existing `star` server — per the approved plan's
// "no Rust rewrite" decision. Every agent is driven by the AgentRuntime:
//   init()  once at startup
//   handleEvent()  on every bus event (reactive)
//   think() then act()  on every runtime cycle (proactive, act() is gated)
//   shutdown()  once at stop

import type { BrainBus, BrainEvent } from "../core/eventBus.js";
import type { SafetyGate } from "../core/safety.js";

export type AgentLifecycleState =
  | "init"
  | "idle"
  | "thinking"
  | "acting"
  | "error"
  | "stopped";

export interface AgentContext {
  /** The internal nervous system. Agents emit and (via the runtime) consume here. */
  readonly bus: BrainBus;
  /** Gate the runtime consults before calling act(); also the audit sink. */
  readonly safety: SafetyGate;
  /** Namespaced logger (prefixed with the agent name). */
  log(message: string): void;
  /** Emit an `agent-status` event for this agent — drives the desktop pet's mood. */
  setStatus(state: AgentLifecycleState, detail?: string): void;
}

export interface Agent {
  /** Stable unique id, e.g. "observer". */
  name(): string;
  /** Human-readable capability tags, surfaced for debugging/extensibility. */
  capabilities(): string[];
  /** One-time setup. Start watchers/timers here; keep it non-blocking. */
  init(ctx: AgentContext): Promise<void> | void;
  /** Reactive: called for every event on the bus (including this agent's own). */
  handleEvent(event: BrainEvent): Promise<void> | void;
  /** Proactive: decide whether there is work to do this cycle. */
  think(): Promise<void> | void;
  /** Proactive: perform the work. Only called when the safety gate permits. */
  act(): Promise<void> | void;
  /** One-time teardown. Close watchers/timers; must be idempotent. */
  shutdown(): Promise<void> | void;
}
