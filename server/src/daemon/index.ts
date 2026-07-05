// Daemon registry integration with brainCore. Wires the runner's 60s tick
// into the same cadence as the autonomous-goal-pursuit tick, and registers
// the daemon module with the Brain Kernel so /api/brain/kernel reports it.
// The registry is the persistent source of truth; this file is the
// lifecycle owner.

import { getKernel } from "../core/kernel.js";
import { surfaceError } from "../util/diagnostics.js";
import { daemonTick, reconcile, startRunner, stopRunner } from "./runner.js";

let started = false;

export function startDaemonSystem(): void {
  if (started) return;
  started = true;
  try {
    startRunner();
    getKernel().registerModule("daemon-registry", () => {
      try {
        return { ok: true, running: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
  } catch (err) {
    surfaceError("daemon.start", err, "error");
  }
}

export function stopDaemonSystem(): void {
  if (!started) return;
  started = false;
  try {
    stopRunner();
  } catch (err) {
    surfaceError("daemon.stop", err);
  }
}

export { daemonTick, reconcile };
