// SystemSensorAgent — the Digital Twin's SENSORY agent.
//
// It OWNS the snapshot cadence (DIGITAL_TWIN_SPEC.md §3): think() decides
// whether a capture interval has elapsed; act() (only reached after the safety
// gate permits + audits "act") performs the capture. Routing cadence through
// the agent — instead of a private setInterval like scheduleDecayTick — is
// what gets the twin safety-gating + agent_audit for free and keeps it
// consistent with ObserverAgent / SchedulerAgent.

import type { Agent, AgentContext } from "./Agent.js";
import { captureSnapshot, analyzeAndPersist } from "../twin/snapshotEngine.js";

// The runtime cycles every 60s (AGENT_CYCLE_MS). One capture per cycle is the
// natural twin resolution; the guard keeps it correct if the cycle changes.
const CAPTURE_INTERVAL_MS = 60_000;

export class SystemSensorAgent implements Agent {
  private ctx: AgentContext | null = null;
  private lastCaptureMs = 0;
  private captureDue = false;

  name(): string {
    return "system-sensor";
  }

  capabilities(): string[] {
    return ["digital-twin", "snapshot-capture", "system-telemetry"];
  }

  init(ctx: AgentContext): void {
    this.ctx = ctx;
    // Seed one snapshot at startup so the dashboard has data before the first
    // 60s cycle. Non-blocking and isolated — a failure here must not wedge the
    // runtime's init loop.
    try {
      const snap = captureSnapshot();
      analyzeAndPersist(snap);
      this.lastCaptureMs = Date.now();
      ctx.log("captured initial twin snapshot");
    } catch (err) {
      ctx.log(`initial snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Purely proactive — no bus events drive it.
  handleEvent(): void {}

  think(): void {
    this.captureDue = Date.now() - this.lastCaptureMs >= CAPTURE_INTERVAL_MS;
  }

  act(): void {
    if (!this.captureDue) return;
    this.captureDue = false;
    try {
      const snap = captureSnapshot();
      const anomalies = analyzeAndPersist(snap);
      this.lastCaptureMs = Date.now();
      this.ctx?.log(
        `snapshot ${snap.id.slice(-6)} — cpu ${snap.hardware.cpuPct}%, ` +
          `health ${snap.healthScore.toFixed(2)}` +
          (anomalies.length ? `, ${anomalies.length} anomaly(ies)` : ""),
      );
    } catch (err) {
      this.ctx?.log(
        `capture failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  shutdown(): void {
    // The runtime owns the cycle timer; nothing agent-local to tear down.
  }
}
