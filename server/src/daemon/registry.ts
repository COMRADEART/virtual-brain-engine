// Daemon registry — long-running "watch this / schedule this / trigger on
// this event" tasks. Persisted in `brain_metadata` as one JSON row (KV shape,
// no migration — same idiom as the neuromodulator bus, the self-model, and
// the procedural memory subsystem). One action per daemon, by design: a
// daemon's job is "WHEN to fire" + "WHAT one action to run"; the agent loop
// owns composition. A daemon is therefore allowed to do only what the user
// would allow its creator to do in a one-shot /api/agent call — the executor
// re-derives risk from the registry, and a `confirm`-tier action is gated by
// the daemon's granted `autonomy` ("ask" / "scope" / "safe-only").
//
// PURE-shape trigger (a discriminated union by `kind`); validation lives here
// so the action layer and the route can both reuse the same zod schema.

import { z } from "zod";
import { ulid } from "ulid";
import { openDb } from "../db/sqlite.js";
import { surfaceError } from "../util/diagnostics.js";

// ---------------------------------------------------------------------------
// Triggers (PURE shape — every field is a primitive, no callbacks, no I/O).
// ---------------------------------------------------------------------------

const WatchPattern = z.enum(["any", "created", "modified", "deleted"]);
export type WatchPattern = z.infer<typeof WatchPattern>;

export const WatchTrigger = z.object({
  kind: z.literal("watch"),
  path: z.string().min(1).max(1024),
  pattern: WatchPattern,
});
export type WatchTrigger = z.infer<typeof WatchTrigger>;

export const ScheduleTrigger = z.object({
  kind: z.literal("schedule"),
  // `everyMinutes` is the only one we use today; cron/runAt land in a
  // follow-up. The trigger type is forward-compatible (additive only).
  everyMinutes: z.number().int().min(1).max(60 * 24 * 7).optional(),
  runAt: z.string().datetime().optional(),
});
export type ScheduleTrigger = z.infer<typeof ScheduleTrigger>;

export const EventTrigger = z.object({
  kind: z.literal("event"),
  event: z.string().min(1).max(128),
});
export type EventTrigger = z.infer<typeof EventTrigger>;

export const DaemonTrigger = z.discriminatedUnion("kind", [
  WatchTrigger,
  ScheduleTrigger,
  EventTrigger,
]);
export type DaemonTrigger = z.infer<typeof DaemonTrigger>;

// ---------------------------------------------------------------------------
// The daemon record. One action per daemon (composition belongs to the
// agent loop). `cooldownMs` is the floor between runs; `autonomy` controls
// how confirm-tier actions in `action` are gated.
// ---------------------------------------------------------------------------

export const DaemonAutonomy = z.enum(["ask", "scope", "safe-only"]);
export type DaemonAutonomy = z.infer<typeof DaemonAutonomy>;

export const DaemonRecord = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200),
  status: z.enum(["running", "paused", "error", "completed"]),
  createdAt: z.string(),
  lastRunAt: z.string().nullable(),
  lastError: z.string().nullable(),
  runCount: z.number().int().min(0),
  cooldownMs: z.number().int().min(0).max(24 * 60 * 60 * 1000),
  autonomy: DaemonAutonomy,
  trigger: DaemonTrigger,
  action: z.object({
    id: z.string().min(1),
    args: z.record(z.unknown()).default({}),
  }),
});
export type DaemonRecord = z.infer<typeof DaemonRecord>;

// ---------------------------------------------------------------------------
// The persisted snapshot. The registry lives in memory while the server runs
// and is mirrored to `brain_metadata` on every mutation so a restart resumes.
// ---------------------------------------------------------------------------

interface DaemonSnapshot {
  version: 1;
  daemons: DaemonRecord[];
}

const META_KEY = "daemon-registry-v1";
let snapshot: DaemonSnapshot = { version: 1, daemons: [] };
let loaded = false;

function readSnapshot(): DaemonSnapshot {
  try {
    const row = openDb()
      .prepare("SELECT value FROM brain_metadata WHERE key = ?")
      .get(META_KEY) as { value: string } | undefined;
    if (row) {
      const parsed = JSON.parse(row.value) as Partial<DaemonSnapshot>;
      if (parsed.version === 1 && Array.isArray(parsed.daemons)) {
        // Re-validate each record on load so a corrupted row can't crash the
        // server. Anything that fails to parse is dropped (with a log); the
        // user can re-create it from the Mind panel.
        const ok: DaemonRecord[] = [];
        for (const raw of parsed.daemons) {
          const r = DaemonRecord.safeParse(raw);
          if (r.success) ok.push(r.data);
          else surfaceError("daemon.registry.parse", r.error.issues.map((i) => i.message).join("; "));
        }
        return { version: 1, daemons: ok };
      }
    }
  } catch (err) {
    surfaceError("daemon.registry.read", err);
  }
  return { version: 1, daemons: [] };
}

function writeSnapshot(snap: DaemonSnapshot): void {
  try {
    openDb()
      .prepare(
        "INSERT INTO brain_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(META_KEY, JSON.stringify(snap));
  } catch (err) {
    surfaceError("daemon.registry.write", err);
  }
}

function ensureLoaded(): void {
  if (loaded) return;
  snapshot = readSnapshot();
  loaded = true;
}

function persist(): void {
  writeSnapshot(snapshot);
}

// ---------------------------------------------------------------------------
// CRUD. Every mutator is its own function so the route + the action layer
// can both reuse the registry without duplicating validation.
// ---------------------------------------------------------------------------

export interface CreateInput {
  title: string;
  trigger: DaemonTrigger;
  action: { id: string; args?: Record<string, unknown> };
  autonomy?: DaemonAutonomy;
  cooldownMs?: number;
}

export function createDaemon(input: CreateInput): DaemonRecord {
  ensureLoaded();
  const record: DaemonRecord = {
    id: `daemon-${ulid()}`,
    title: input.title,
    status: "running",
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    lastError: null,
    runCount: 0,
    cooldownMs: input.cooldownMs ?? 60_000,
    autonomy: input.autonomy ?? "ask",
    trigger: input.trigger,
    action: { id: input.action.id, args: input.action.args ?? {} },
  };
  snapshot = { ...snapshot, daemons: [...snapshot.daemons, record] };
  persist();
  return record;
}

export function listDaemons(): DaemonRecord[] {
  ensureLoaded();
  return snapshot.daemons;
}

export function getDaemon(id: string): DaemonRecord | null {
  ensureLoaded();
  return snapshot.daemons.find((d) => d.id === id) ?? null;
}

/** Idempotent — missing is fine. */
export function deleteDaemon(id: string): void {
  ensureLoaded();
  snapshot = { ...snapshot, daemons: snapshot.daemons.filter((d) => d.id !== id) };
  persist();
}

export function setDaemonStatus(
  id: string,
  status: DaemonRecord["status"],
  lastError: string | null = null,
): DaemonRecord | null {
  ensureLoaded();
  let updated: DaemonRecord | null = null;
  snapshot = {
    ...snapshot,
    daemons: snapshot.daemons.map((d) => {
      if (d.id !== id) return d;
      updated = { ...d, status, lastError };
      return updated;
    }),
  };
  persist();
  return updated;
}

/** Called by the runner after a successful fire. The status is only
 *  promoted to "running" if the daemon is currently in a transient state
 *  (we don't override an explicit "error" or "paused" — the user is
 *  reviewing those). */
export function recordRun(id: string, ranAt: string, ok: boolean): void {
  ensureLoaded();
  let touched = false;
  snapshot = {
    ...snapshot,
    daemons: snapshot.daemons.map((d) => {
      if (d.id !== id) return d;
      touched = true;
      // Don't clobber an explicit error/paused status on a successful re-run
      // — the user is reviewing it. A failed run keeps the caller's status
      // (which the caller just set before calling recordRun).
      const nextStatus: DaemonRecord["status"] = ok
        ? d.status === "error" || d.status === "paused"
          ? d.status
          : "running"
        : d.status;
      return { ...d, runCount: d.runCount + 1, lastRunAt: ranAt, lastError: null, status: nextStatus };
    }),
  };
  if (touched) persist();
}

/** Total count by status — used by the Mind panel. */
export function daemonCounts(): { total: number; running: number; paused: number; error: number } {
  ensureLoaded();
  let running = 0,
    paused = 0,
    error = 0;
  for (const d of snapshot.daemons) {
    if (d.status === "running") running++;
    else if (d.status === "paused") paused++;
    else if (d.status === "error") error++;
  }
  return { total: snapshot.daemons.length, running, paused, error };
}

// ---------------------------------------------------------------------------
// Test/boot helper. NOT exposed via the route — only the selfcheck resets.
// ---------------------------------------------------------------------------

export function _resetDaemonsForTests(): void {
  snapshot = { version: 1, daemons: [] };
  loaded = true;
  persist();
}
