// SchedulerAgent — periodic heartbeat / reminders.
//
// The runtime already supplies the cadence (one think/act per cycle), so this
// agent's job is to mark the passage of time: it emits an `agent-status`
// heartbeat carrying uptime + cycle count. That is the minimal honest version
// of report.txt's "periodic tasks/reminders" — and the extension point where
// future scheduled jobs (digest reminders, etc.) hang off without touching the
// runtime. Memory decay/consolidation is intentionally NOT triggered here; it
// already has its own scheduler (memory/consolidationEngine.scheduleDecayTick).

import type { Agent, AgentContext } from "./Agent.js";

export class SchedulerAgent implements Agent {
  private ctx: AgentContext | null = null;
  private startedAt = Date.now();
  private cycles = 0;

  name(): string {
    return "scheduler";
  }

  capabilities(): string[] {
    return ["heartbeat", "uptime", "schedule-hook"];
  }

  init(ctx: AgentContext): void {
    this.ctx = ctx;
    this.startedAt = Date.now();
  }

  handleEvent(): void {}

  think(): void {
    this.cycles += 1;
  }

  act(): void {
    if (!this.ctx) return;
    const upMin = Math.floor((Date.now() - this.startedAt) / 60000);
    this.ctx.setStatus("idle", `heartbeat · up ${upMin}m · ${this.cycles} cycles`);
  }

  shutdown(): void {}
}
