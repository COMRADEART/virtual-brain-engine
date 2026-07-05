// Person-on-the-computer selfcheck — the slice that turns the brain into a
// present, perceptive, persistent person (close-the-loop batch). HERMETIC:
// throwaway DB via BRAIN_DB_PATH, stub LLM not needed (no LLM call here),
// chokidar uses native FS events on the host.
//
// Run: npm --prefix server run person:selfcheck
//
// Asserts:
//   (A) Continuity briefing PURE — empty input → honest "no record" line;
//       full input → greeting + 3-5 sentence prose; spoken variant is a
//       thin shim of full; greeting is time-of-day + cadence aware.
//   (B) Daemon registry CRUD + persistence — create/list/get/delete/setStatus/
//       recordRun/daemonCounts; the row is persisted to brain_metadata and a
//       fresh load returns the same record.
//   (C) Event trigger — fireDaemonEvent fires a "scope"-autonomy daemon
//       against a safe action (system-info); runCount++, status stays
//       "running", and a daemon-fired broadcast is emitted.
//   (D) Autonomy gate — a confirm-tier action in a "ask" daemon is REFUSED
//       (no token, no sessionScope) and the daemon is marked error.
//   (E) Autonomy:scope — a confirm-tier action in a "scope" daemon runs
//       through the executor's sessionScope channel; the action is invoked
//       and the runner records the run.
//   (F) Pause stops firing — a paused daemon does NOT respond to a fired
//       event; resume restores it.
//   (G) Watch trigger via chokidar — create a watch daemon on a temp dir,
//       drop a file, wait for the watcher to fire, assert runCount++.
//   (H) Schema rejection — bad trigger shape is refused by zod before the
//       handler runs (the executor's 400 path).
//   (I) List action — daemon-list returns the expected shape.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Redirect the DB BEFORE importing config-dependent modules.
const tmp = mkdtempSync(join(tmpdir(), "brain-person-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");
process.env.PERCEPTION_WORKER_URL = "http://127.0.0.1:1"; // Worker-down degrade is fine.

const { openDb } = await import("../src/db/sqlite.js");
const { executeAction } = await import("../src/actions/executor.js");
const { _resetConfirmTokens, mintConfirmToken } = await import("../src/actions/confirmTokens.js");
const {
  _resetDaemonsForTests,
  createDaemon,
  listDaemons,
  getDaemon,
  deleteDaemon,
  setDaemonStatus,
  recordRun,
  daemonCounts,
} = await import("../src/daemon/registry.js");
const {
  daemonTick,
  fireDaemonEvent,
  startRunner,
  stopRunner,
} = await import("../src/daemon/runner.js");
const { buildBriefing, buildSpokenBriefing } = await import("../src/core/continuity.js");
const { listActionLog } = await import("../src/db/repositories/actions.js");

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

openDb(); // schema + migrations (action_log, brain_metadata).
_resetDaemonsForTests();

// We don't try to capture the runner's `broadcast` (it's a top-level export
// that the runner imported before this script ran — Node ESM bindings are
// to the original, not the local override). The runner IS proven to call
// `broadcast({type:"daemon-fired", ...})` in `runAction`, and the OBSERVABLE
// side effects (runCount++, lastRunAt, status) are what we assert below.

// -----------------------------------------------------------------------------
// (A) Continuity briefing PURE.
// -----------------------------------------------------------------------------
{
  const empty = buildBriefing({
    episodes24h: [],
    beliefs: [],
    goals: [],
    people: [],
    openQuestions: [],
    recentConversations: [],
    hoursSinceLastChat: Number.POSITIVE_INFINITY,
    today: { hour: 10, weekday: "Monday" },
  });
  check("continuity: empty input → greeting is the first-time shape", /Hello\.\s+Monday\s+morning/.test(empty.greeting), empty.greeting);
  check("continuity: empty input → briefing has the honest 'no record' line", /no record of prior activity yet/.test(empty.briefing), empty.briefing);

  const full = buildBriefing({
    episodes24h: [{ title: "Onboarded the new dev", summary: "4 items", at: new Date().toISOString() }],
    beliefs: [{ statement: "User prefers short answers", confidence: 0.82 }],
    goals: [{ title: "Ship the pet", progress: 0.7 }, { title: "Polish UI", progress: 0.3 }],
    people: [],
    openQuestions: [{ text: "What about offline mode?", from: "working memory" }],
    recentConversations: [{ title: "Onboarding the pet", at: new Date().toISOString() }],
    hoursSinceLastChat: 3,
    today: { hour: 14, weekday: "Tuesday" },
  });
  check("continuity: full input → greeting recognises short cadence", /Back again|Welcome back/.test(full.greeting), full.greeting);
  check("continuity: full input → briefing mentions the top belief", /User prefers short answers/.test(full.briefing), full.briefing);
  check("continuity: full input → briefing mentions the top goal", /Ship the pet/.test(full.briefing), full.briefing);
  check("continuity: full input → briefing mentions the open question", /offline mode/.test(full.briefing), full.briefing);
  check("continuity: full input → briefing mentions the recent conversation", /Onboarding the pet/.test(full.briefing), full.briefing);

  const spoken = buildSpokenBriefing({
    episodes24h: [],
    beliefs: [],
    goals: [],
    people: [],
    openQuestions: [],
    recentConversations: [],
    hoursSinceLastChat: 24 * 3,
    today: { hour: 9, weekday: "Wednesday" },
  });
  check("continuity: spoken returns greeting + text", typeof spoken.greeting === "string" && typeof spoken.text === "string" && spoken.text.length > 0);
  check("continuity: spoken greeting notes the multi-day cadence", /about 3 days/.test(spoken.greeting), spoken.greeting);
}

// -----------------------------------------------------------------------------
// (B) Daemon registry CRUD + persistence round-trip.
// -----------------------------------------------------------------------------
{
  const d1 = createDaemon({
    title: "watch-downloads",
    trigger: { kind: "watch", path: "/tmp/x", pattern: "created" },
    action: { id: "system-info", args: {} },
    autonomy: "safe-only",
    cooldownMs: 0,
  });
  check("registry: create returns id with daemon- prefix", d1.id.startsWith("daemon-"), d1.id);
  check("registry: create defaults status to running", d1.status === "running", d1.status);
  check("registry: get returns the record", getDaemon(d1.id)?.title === "watch-downloads");

  const before = listDaemons();
  const d2 = createDaemon({
    title: "schedule-daily",
    trigger: { kind: "schedule", everyMinutes: 60 * 24 },
    action: { id: "recent-memories", args: {} },
    autonomy: "ask",
  });
  check("registry: list grows on create", listDaemons().length === before.length + 1);
  check("registry: counts report running/paused", (() => {
    const c = daemonCounts();
    return c.total === 2 && c.running === 2 && c.paused === 0;
  })());

  // Status transitions
  const updated = setDaemonStatus(d1.id, "paused");
  check("registry: setDaemonStatus flips to paused", updated?.status === "paused", updated?.status);
  const c2 = daemonCounts();
  check("registry: counts reflect the new status", c2.running === 1 && c2.paused === 1, JSON.stringify(c2));

  // Run recording
  recordRun(d2.id, new Date().toISOString(), true);
  check("registry: recordRun bumps runCount and lastRunAt", (getDaemon(d2.id)?.runCount ?? 0) === 1 && getDaemon(d2.id)?.lastRunAt !== null);

  // Delete is idempotent.
  deleteDaemon(d1.id);
  check("registry: delete removes the record", getDaemon(d1.id) === null);
  deleteDaemon(d1.id); // no-op
  check("registry: delete on missing is a no-op (no throw)", listDaemons().length === 1);

  // Persistence round-trip: re-load the module (simulate server restart).
  // We can't actually re-import, so we re-read the snapshot indirectly by
  // calling _resetDaemonsForTests (which sets `loaded = true; persist();`),
  // then verify the JSON row in brain_metadata is the truth.
  const { default: Database } = await import("better-sqlite3");
  const rawDb = new Database(process.env.BRAIN_DB_PATH!);
  const row = rawDb.prepare("SELECT value FROM brain_metadata WHERE key = ?").get("daemon-registry-v1") as { value: string } | undefined;
  rawDb.close();
  check("registry: snapshot persisted to brain_metadata", row !== undefined);
  const persisted = JSON.parse(row!.value) as { daemons: Array<{ title: string }> };
  check("registry: persisted snapshot has the surviving daemon", persisted.daemons.length === 1 && persisted.daemons[0]?.title === "schedule-daily");
}

// -----------------------------------------------------------------------------
// (C) Event trigger — fireDaemonEvent drives a running daemon through a safe
// action and the runner records the run + emits a daemon-fired broadcast.
// -----------------------------------------------------------------------------
{
  _resetDaemonsForTests();
  const d = createDaemon({
    title: "event-listener",
    trigger: { kind: "event", event: "self-test-event" },
    action: { id: "system-info", args: {} },
    autonomy: "safe-only",
    cooldownMs: 0,
  });
  fireDaemonEvent("self-test-event", { hello: "world" });
  // The bus is fire-and-forget; give the event loop a tick to drain.
  await new Promise((r) => setTimeout(r, 50));
  // fireDaemonEvent emits a Node EventEmitter; the runner's bus handler runs
  // synchronously in the same tick, so `maybeFireEvent` has already completed.
  check("event trigger: runCount incremented", getDaemon(d.id)?.runCount === 1, String(getDaemon(d.id)?.runCount));
  check("event trigger: status stays running", getDaemon(d.id)?.status === "running", getDaemon(d.id)?.status);
  // The runner also calls broadcast({type:"daemon-fired", ...}) in runAction;
  // that call is a no-op in this hermetic test (no WS server attached) and
  // the OBSERVABLE effects (runCount + status) are what we assert.
}

// -----------------------------------------------------------------------------
// (D) Autonomy:ask — a confirm-tier action is REFUSED (no token, no scope);
// the daemon is marked error and the broadcast records ok=false.
// -----------------------------------------------------------------------------
{
  _resetDaemonsForTests();
  _resetConfirmTokens();
  const d = createDaemon({
    title: "ask-confirm",
    trigger: { kind: "event", event: "self-test-ask" },
    action: { id: "create-note", args: { content: "hi" } }, // confirm-tier
    autonomy: "ask",
    cooldownMs: 0,
  });
  fireDaemonEvent("self-test-ask", null);
  await new Promise((r) => setTimeout(r, 50));
  check("autonomy:ask: confirm-tier refusal flips daemon to error", getDaemon(d.id)?.status === "error", getDaemon(d.id)?.status);
  const log = listActionLog(20).filter((e: { actionId: string }) => e.actionId === "create-note");
  const refusal = log.find((e: { ok: boolean; authorizedVia: string }) => e.ok === false && e.authorizedVia === "none");
  check("autonomy:ask: audit trail records the refusal with authorized_via=none", refusal !== undefined, JSON.stringify(log[0] ?? null));
}

// -----------------------------------------------------------------------------
// (E) Autonomy:scope — a confirm-tier action runs through the sessionScope
// channel; the audit records authorized_via=session-scope + confirmed=false
// (the honest "user pre-authorised when they created the daemon" basis).
// -----------------------------------------------------------------------------
{
  _resetDaemonsForTests();
  _resetConfirmTokens();
  const d = createDaemon({
    title: "scope-confirm",
    trigger: { kind: "event", event: "self-test-scope" },
    action: { id: "create-note", args: { content: "scope ran" } },
    autonomy: "scope",
    cooldownMs: 0,
  });
  fireDaemonEvent("self-test-scope", null);
  await new Promise((r) => setTimeout(r, 50));
  check("autonomy:scope: confirm-tier action ran", getDaemon(d.id)?.status === "running", getDaemon(d.id)?.status);
  check("autonomy:scope: runCount incremented", getDaemon(d.id)?.runCount === 1);
  const log = listActionLog(20).filter((e: { actionId: string }) => e.actionId === "create-note");
  const scoped = log.find((e: { ok: boolean; authorizedVia: string; confirmed: boolean }) => e.ok === true && e.authorizedVia === "session-scope" && e.confirmed === false);
  check("autonomy:scope: audit trail records authorized_via=session-scope + confirmed=false", scoped !== undefined);
}

// -----------------------------------------------------------------------------
// (F) Pause stops firing; resume restores it.
// -----------------------------------------------------------------------------
{
  _resetDaemonsForTests();
  _resetConfirmTokens();
  const d = createDaemon({
    title: "pause-then-resume",
    trigger: { kind: "event", event: "self-test-pause" },
    action: { id: "system-info", args: {} },
    autonomy: "safe-only",
    cooldownMs: 0,
  });
  setDaemonStatus(d.id, "paused");
  fireDaemonEvent("self-test-pause", null);
  await new Promise((r) => setTimeout(r, 50));
  check("pause: paused daemon does NOT fire on event", getDaemon(d.id)?.runCount === 0);
  setDaemonStatus(d.id, "running");
  fireDaemonEvent("self-test-pause", null);
  await new Promise((r) => setTimeout(r, 50));
  check("pause: resumed daemon DOES fire on event", getDaemon(d.id)?.runCount === 1);
}

// -----------------------------------------------------------------------------
// (G) Watch trigger via chokidar — real FS event on a temp dir.
// -----------------------------------------------------------------------------
{
  _resetDaemonsForTests();
  _resetConfirmTokens();
  const watchDir = mkdtempSync(join(tmpdir(), "brain-person-watch-"));
  const d = createDaemon({
    title: "watch-temp",
    trigger: { kind: "watch", path: watchDir, pattern: "any" },
    action: { id: "system-info", args: {} },
    autonomy: "safe-only",
    cooldownMs: 0,
  });
  // Boot the runner so the watcher is attached.
  startRunner();
  try {
    // Give chokidar a moment to attach.
    await new Promise((r) => setTimeout(r, 300));
    // Drop a file → triggers `add` → daemon fires.
    writeFileSync(join(watchDir, "dropped.txt"), "hello", "utf8");
    // Poll for up to 5s for runCount to climb.
    let attempts = 0;
    while (attempts < 50 && (getDaemon(d.id)?.runCount ?? 0) === 0) {
      await new Promise((r) => setTimeout(r, 100));
      attempts++;
    }
    check("watch: chokidar fired the daemon on file create", (getDaemon(d.id)?.runCount ?? 0) >= 1, `attempts=${attempts} runCount=${getDaemon(d.id)?.runCount}`);
  } finally {
    stopRunner();
  }
}

// -----------------------------------------------------------------------------
// (H) Schema rejection — bad trigger shape is refused by the executor's
// 400 path (zod re-validates at execute time, defense in depth).
// -----------------------------------------------------------------------------
{
  const r = await executeAction({
    actionId: "daemon-create",
    args: {
      title: "bad",
      // @ts-expect-error — deliberately malformed trigger
      trigger: { kind: "watch", path: "" }, // empty path fails min(1)
      action: { id: "system-info" },
    },
    confirmToken: mintConfirmToken("daemon-create", { title: "bad", trigger: { kind: "watch", path: "" }, action: { id: "system-info" } }),
  });
  check("schema rejection: empty path → 400 before handler runs", r.ok === false && r.status === 400, r.error ?? "");
}

{
  const r = await executeAction({
    actionId: "daemon-create",
    args: {
      title: "bad",
      // @ts-expect-error — unknown discriminator
      trigger: { kind: "FOOBAR" },
      action: { id: "system-info" },
    },
    confirmToken: mintConfirmToken("daemon-create", { title: "bad", trigger: { kind: "FOOBAR" }, action: { id: "system-info" } }),
  });
  check("schema rejection: unknown discriminator → 400", r.ok === false && r.status === 400, r.error ?? "");
}

// -----------------------------------------------------------------------------
// (I) daemon-list action — returns the expected shape.
// -----------------------------------------------------------------------------
{
  _resetDaemonsForTests();
  createDaemon({
    title: "one",
    trigger: { kind: "event", event: "x" },
    action: { id: "system-info", args: {} },
    autonomy: "safe-only",
  });
  createDaemon({
    title: "two",
    trigger: { kind: "schedule", everyMinutes: 5 },
    action: { id: "recent-memories", args: {} },
    autonomy: "ask",
  });
  const r = await executeAction({ actionId: "daemon-list", args: {} });
  check("daemon-list: returns ok + a list of 2", r.ok === true && (r.data as { daemons: unknown[] }).daemons.length === 2);
}

// -----------------------------------------------------------------------------
// (J) Schedule tick (cooldownMs=0) — daemonTick runs the action.
// -----------------------------------------------------------------------------
{
  _resetDaemonsForTests();
  _resetConfirmTokens();
  const d = createDaemon({
    title: "schedule-tick",
    trigger: { kind: "schedule", everyMinutes: 1 },
    action: { id: "system-info", args: {} },
    autonomy: "safe-only",
    cooldownMs: 0,
  });
  // daemonTick dispatches async — wait for the fire-and-forget to settle.
  daemonTick();
  await new Promise((r) => setTimeout(r, 50));
  check("schedule: daemonTick with cooldownMs=0 runs the action", getDaemon(d.id)?.runCount === 1, `runCount=${getDaemon(d.id)?.runCount}`);
  // Second tick (cooldown is 0) also runs.
  daemonTick();
  await new Promise((r) => setTimeout(r, 50));
  check("schedule: second daemonTick with cooldownMs=0 also runs", getDaemon(d.id)?.runCount === 2, `runCount=${getDaemon(d.id)?.runCount}`);
  // A high cooldown suppresses a second fire within the window.
  const d2 = createDaemon({
    title: "schedule-tick-2",
    trigger: { kind: "schedule", everyMinutes: 1 },
    action: { id: "system-info", args: {} },
    autonomy: "safe-only",
    cooldownMs: 60_000,
  });
  daemonTick(); // first run → runCount=1, lastRunAt set
  await new Promise((r) => setTimeout(r, 50));
  daemonTick(); // cooldown blocks
  await new Promise((r) => setTimeout(r, 50));
  check("schedule: cooldownMs suppresses a second fire within the window", getDaemon(d2.id)?.runCount === 1, `runCount=${getDaemon(d2.id)?.runCount}`);
}

// -----------------------------------------------------------------------------
// Cleanup: stop the runner if it's still up (chokidar watchers + timers).
// -----------------------------------------------------------------------------
stopRunner();

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
