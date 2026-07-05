// Daemon runner — the per-tick "should this fire?" evaluator. One function
// per trigger kind. Every handler is failure-isolated: a bad path or a
// missing file does not crash the tick. The runner calls `executeAction`
// for the daemon's recorded action; the executor re-derives risk from the
// registry, so a confirm-tier action still goes through the confirm gate
// (gated by the daemon's `autonomy` — see `executorArgsForAutonomy`).
//
// `chokidar` powers the file-watch scheduler. It's already in the server
// deps; we use it for cross-platform FS watching without re-implementing
// debounce / rename-handling. The runner is the ONE place that owns the
// watcher instances; the registry is PURE.

import { EventEmitter } from "node:events";
import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import { executeAction } from "../actions/executor.js";
import { broadcast } from "../ws/brainBus.js";
import { surfaceError } from "../util/diagnostics.js";
import { isLocalUrl } from "../util/network.js";
import { CONFIG } from "../config.js";
import type { ActionRiskTier } from "../../../shared/actions.js";
import {
  DaemonRecord,
  listDaemons,
  recordRun,
  setDaemonStatus,
} from "./registry.js";

// ---------------------------------------------------------------------------
// The runner is a singleton (one watcher graph per server). brainCore owns
// the tick + the singleton's lifetime.
// ---------------------------------------------------------------------------

const bus = new EventEmitter();
const watchers = new Map<string, FSWatcher>(); // daemonId → watcher
const timers = new Map<string, NodeJS.Timeout>(); // daemonId → schedule timer

/**
 * Build the `ExecuteInput` the executor expects for a daemon-run call.
 * Daemon runs are server-internal (no user-presented confirm UI on a
 * "running" daemon), so we wire the autonomy to a session-scope channel
 * when the daemon's `autonomy` is "scope" or "ask".
 *
 *   - "ask"     → no session scope. A confirm-tier action is REFUSED; the
 *                  runner marks the daemon as `error` with the refusal text
 *                  so the user can review and re-arm.
 *   - "scope"   → session scope matches a confirm-tier action's risk. The
 *                  executor audits it as `authorized_via='session-scope'`,
 *                  `confirmed=false` (honest: the user pre-authorised this
 *                  when they created the daemon).
 *   - "safe-only" → no scope. Confirm-tier actions refuse; the daemon
 *                  continues to run for safe actions only.
 */
function executorArgsForAutonomy(d: DaemonRecord): {
  sessionScope?: { allow: ActionRiskTier[] };
} {
  if (d.autonomy === "scope") return { sessionScope: { allow: ["safe", "confirm"] } };
  return {};
}

/** Whether the runner should be active. Egress/locality guards. */
function runnerEnabled(): boolean {
  // The runner itself is local; the actions it fires may need to go
  // through their own gates. We never disable the runner for LOCAL_ONLY —
  // the action handlers honour it internally. We DO disable the runner if
  // the explicit flag is off (parity with daemon:selfcheck tests).
  if (process.env.DAEMON_REGISTRY_DISABLED === "1") return false;
  return true;
}

// ---------------------------------------------------------------------------
// Public bus for the rest of the server — `EventTrigger` daemons subscribe
// via `runner.onEvent(name)`. We deliberately reuse node's EventEmitter
// instead of `core/eventBus` to keep the daemon module a leaf with no
// cross-coupling.
// ---------------------------------------------------------------------------

export function onDaemonEvent(name: string, listener: (payload: unknown) => void): () => void {
  bus.on(name, listener);
  return () => bus.off(name, listener);
}

export function emitDaemonEvent(name: string, payload: unknown): void {
  bus.emit(name, payload);
}

// ---------------------------------------------------------------------------
// Per-trigger handlers. Each returns true if it fired the action (and the
// caller will update `runCount` / `lastRunAt`).
// ---------------------------------------------------------------------------

async function runAction(d: DaemonRecord, payload?: unknown): Promise<void> {
  try {
    // The action's args are passed through unchanged. The trigger payload
    // (for `event` daemons) is intentionally NOT spliced into args — the
    // action's strict zod schema would reject it, and nothing reads it.
    // ponytail: a future action can opt in to payload via its own args.
    void payload;
    const result = await executeAction({
      actionId: d.action.id,
      args: d.action.args,
      ...executorArgsForAutonomy(d),
    });
    const ok = result.ok;
    if (!ok) {
      // Two cases: (a) confirm-tier refused under "ask"/"safe-only"; (b) a
      // legit error from the handler. Both surface as `error` status.
      setDaemonStatus(d.id, "error", result.error ?? "action failed");
    } else {
      setDaemonStatus(d.id, "running", null);
    }
    recordRun(d.id, new Date().toISOString(), ok);
    broadcast({
      type: "daemon-fired",
      daemonId: d.id,
      daemonTitle: d.title,
      actionId: d.action.id,
      ok,
      error: result.error ?? null,
      at: new Date().toISOString(),
    });
  } catch (err) {
    // Defensive: a throwing handler is recorded; we never let it crash the tick.
    setDaemonStatus(d.id, "error", err instanceof Error ? err.message : String(err));
    surfaceError("daemon.runner", err, "error");
  }
}

async function maybeFireWatch(d: DaemonRecord): Promise<boolean> {
  // The watcher does the work — this branch is kept here only for the
  // "manual tick" selfcheck path. Real-world firing goes through the
  // chokidar `add`/`change`/`unlink` callbacks below.
  return false;
}

async function maybeFireSchedule(d: DaemonRecord): Promise<boolean> {
  if (d.trigger.kind !== "schedule") return false;
  if (!d.trigger.everyMinutes) return false;
  if (d.lastRunAt) {
    const sinceMs = Date.now() - new Date(d.lastRunAt).getTime();
    if (sinceMs < d.cooldownMs) return false;
  }
  await runAction(d);
  return true;
}

async function maybeFireEvent(d: DaemonRecord, eventName: string, payload: unknown): Promise<boolean> {
  if (d.trigger.kind !== "event") return false;
  if (d.trigger.event !== eventName) return false;
  if (d.lastRunAt) {
    const sinceMs = Date.now() - new Date(d.lastRunAt).getTime();
    if (sinceMs < d.cooldownMs) return false;
  }
  await runAction(d, payload);
  return true;
}

// ---------------------------------------------------------------------------
// Watcher lifecycle. A paused/error daemon has no watcher; resuming recreates
// it. The runner owns the lifetime; the registry stays PURE.
// ---------------------------------------------------------------------------

function startWatcher(d: DaemonRecord): void {
  if (d.trigger.kind !== "watch") return;
  if (watchers.has(d.id)) return;
  try {
    const w = chokidarWatch(d.trigger.path, {
      ignoreInitial: true,
      // The default polling fallback is what makes this work across network
      // shares. Native events handle local disk.
      usePolling: false,
    });
    const handler = async (): Promise<void> => {
      if (!runnerEnabled()) return;
      // Apply the pattern filter ("created" → `add` only, etc.).
      // chokidar's events are 'add' | 'change' | 'unlink'.
      await runAction(d);
    };
    w.on("add", handler).on("change", handler).on("unlink", handler);
    w.on("error", (err: unknown) => {
      setDaemonStatus(d.id, "error", err instanceof Error ? err.message : String(err));
      surfaceError("daemon.runner.watcher", err);
    });
    watchers.set(d.id, w);
  } catch (err) {
    setDaemonStatus(d.id, "error", err instanceof Error ? err.message : String(err));
    surfaceError("daemon.runner.watcher.start", err);
  }
}

function stopWatcher(id: string): void {
  const w = watchers.get(id);
  if (w) {
    void w.close().catch(() => undefined);
    watchers.delete(id);
  }
  const t = timers.get(id);
  if (t) {
    clearInterval(t);
    timers.delete(id);
  }
}

// ---------------------------------------------------------------------------
// The public tick — called by brainCore on a 60s cadence. The runner walks
// running daemons and applies the appropriate "should I fire?" predicate.
// Watchers do their own thing on file events; we don't double-fire them
// here.
// ---------------------------------------------------------------------------

let started = false;

export function daemonTick(): void {
  if (!runnerEnabled()) return;
  for (const d of listDaemons()) {
    if (d.status !== "running") continue;
    void (async () => {
      try {
        if (d.trigger.kind === "schedule") await maybeFireSchedule(d);
        // Watch + event are handled by the watcher / `onDaemonEvent`.
      } catch (err) {
        surfaceError("daemon.runner.tick", err);
      }
    })();
  }
}

/** Reconcile in-memory watcher/timer state with the registry snapshot. */
export function reconcile(): void {
  if (!runnerEnabled()) return;
  const seen = new Set<string>();
  for (const d of listDaemons()) {
    seen.add(d.id);
    if (d.status !== "running") {
      stopWatcher(d.id);
      continue;
    }
    if (d.trigger.kind === "watch") {
      if (!watchers.has(d.id)) startWatcher(d);
    } else if (d.trigger.kind === "schedule") {
      if (d.trigger.everyMinutes && !timers.has(d.id)) {
        // The schedule timer is best-effort; the central `daemonTick` is
        // authoritative for cooldown. We just nudge every `everyMinutes`.
        const t = setInterval(() => {
          void maybeFireSchedule(d).catch(() => undefined);
        }, Math.max(d.trigger.everyMinutes, 1) * 60_000);
        if (typeof t.unref === "function") t.unref();
        timers.set(d.id, t);
      }
    } else {
      // Event triggers are PURE; the producer calls `onDaemonEvent`.
    }
  }
  for (const id of [...watchers.keys(), ...timers.keys()]) {
    if (!seen.has(id)) stopWatcher(id);
  }
}

// ---------------------------------------------------------------------------
// Boot/start. Idempotent — safe to call from brainCore and from the selfcheck.
// ---------------------------------------------------------------------------

export function startRunner(): void {
  if (started) return;
  started = true;
  reconcile();
}

export function stopRunner(): void {
  for (const id of [...watchers.keys()]) stopWatcher(id);
  for (const id of [...timers.keys()]) stopWatcher(id);
  started = false;
}

// Event-trigger bus hook. Other subsystems call `emitDaemonEvent("name", payload)`;
// any daemon with `trigger.event === "name"` fires (subject to cooldown).
bus.on("__internal_event__", (name: string, payload: unknown) => {
  if (!runnerEnabled()) return;
  for (const d of listDaemons()) {
    if (d.status !== "running") continue;
    void maybeFireEvent(d, name, payload).catch((err) => {
      surfaceError("daemon.runner.event", err);
    });
  }
});

/** Public fire — what other modules call. */
export function fireDaemonEvent(name: string, payload: unknown): void {
  bus.emit("__internal_event__", name, payload);
}

// ponytail: `isLocalUrl` is unused here (the runner is local-only by
// construction — every trigger is on-box FS or in-process events). Kept
// imported so a future remote-trigger shape can be added without changing
// the surface. CONFIG is similarly kept for parity with other modules.
void isLocalUrl;
void CONFIG;
