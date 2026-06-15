// Spinal cord selfcheck — hermetic (throwaway DB via BRAIN_DB_PATH, a scripted
// connector for the deliberate tract, NO LLM, NO network). Run:
//   npm --prefix server run spine:selfcheck
//
// Asserts:
//   (A) PURE reflex matching — matchReflexIn match/no-match, arg extraction, and
//       decline-when-required-arg-missing (falls through to a higher tract).
//   (B) THE SAFETY INVARIANT — registerReflex REFUSES a confirm-tier target; the
//       live reflex set contains only safe-eligible arcs; isReflexEligible.
//   (C) PERSONA routing — pickPersona's deterministic keyword routing; the Reflex
//       pool is never auto-selected; personaDirective carries the flavor + tools.
//   (D) MOTOR PROGRAMS — isProgramStep (safe+no-arg only), canRunAsProgram, and
//       selectProgram (clears the score floor + all-safe steps).
//   (E) DISPATCH ROUTING — a reflex intent fires the safe action through the
//       executor (afferent feedback); a practiced all-safe procedure runs as a
//       PROGRAM (no LLM) and credits the procedure; a confirm/unknown intent
//       routes to the DELIBERATE tract (scripted loop), proving confirm-tier work
//       can never shortcut the reflex/program path.
//   (F) THE HERMES QUEUE — priority ordering; tick() drains due commands.
//   (G) SNAPSHOT shape + failure isolation (no public path throws on bad input).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

const tmp = mkdtempSync(join(tmpdir(), "brain-spine-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const {
  matchReflexIn,
  extractReflexArg,
  registerReflex,
  removeReflex,
  listReflexes,
  liveReflexes,
  isReflexEligible,
  matchReflex,
} = await import("../src/spine/reflexes.js");
const { pickPersona, personaDirective, getPersona, listPersonas, isPersonaId } = await import(
  "../src/spine/personas.js"
);
const { isProgramStep, canRunAsProgram, selectProgram } = await import("../src/spine/motorPrograms.js");
const { getSpine } = await import("../src/spine/cord.js");
const { __setAgentConnector } = await import("../src/reasoning/agentLoop.js");
const { extractProcedures, listProcedures } = await import("../src/memory/procedural.js");
const { openDb } = await import("../src/db/sqlite.js");
import type { ReflexArc } from "../../shared/spine.js";
type Connector = import("../src/connectors/Connector.js").Connector;

const db = openDb();

function scripted(responses: string[]): Connector {
  let i = 0;
  return {
    descriptor: {
      id: "stub", name: "stub", kind: "ollama", enabled: true, state: "ok",
      createdAt: "", updatedAt: "", isLocal: true,
    },
    async listModels() { return []; },
    async send() { const r = responses[Math.min(i, responses.length - 1)] ?? "{}"; i++; return r; },
    async *stream() { yield ""; },
    async test() { return { ok: true }; },
  } satisfies Connector;
}

// -----------------------------------------------------------------------------
// (A) PURE reflex matching.
// -----------------------------------------------------------------------------
{
  const arcs: ReflexArc[] = [
    { id: "r-sys", name: "sys", triggers: ["system info", "how much ram"], actionId: "system-info", description: "", builtIn: true },
    { id: "r-mem", name: "mem", triggers: ["search memory for"], actionId: "search-memory", argParam: "query", description: "", builtIn: true },
  ];
  check("(A) matches a trigger substring", matchReflexIn("tell me the system info now", arcs)?.arc.id === "r-sys");
  check("(A) no match → null", matchReflexIn("paint the wall blue", arcs) === null);
  const m = matchReflexIn("search memory for quantum notes", arcs);
  check("(A) arg reflex lifts the trailing text", m?.arc.id === "r-mem" && m?.args.query === "quantum notes");
  check("(A) arg reflex DECLINES when no arg is extractable",
    matchReflexIn("search memory for", arcs) === null);
  check("(A) extractReflexArg after 'for'", extractReflexArg("learn about the ocean") === "the ocean");
  check("(A) extractReflexArg none → null", extractReflexArg("just a sentence") === null);
  check("(A) empty intent → null", matchReflexIn("", arcs) === null);
}

// -----------------------------------------------------------------------------
// (B) THE SAFETY INVARIANT.
// -----------------------------------------------------------------------------
{
  const refused = registerReflex({ name: "bad", triggers: ["nuke it"], actionId: "create-note" });
  check("(B) registerReflex REFUSES a confirm-tier target", refused.ok === false && /safe/i.test((refused as { error: string }).error));
  const refusedShell = registerReflex({ name: "bad2", triggers: ["do it"], actionId: "run-command" });
  check("(B) registerReflex REFUSES run-command", refusedShell.ok === false);
  const ok = registerReflex({ name: "ok", triggers: ["whats my system"], actionId: "system-info" });
  check("(B) registerReflex ACCEPTS a safe target", ok.ok === true);
  if (ok.ok) check("(B) removeReflex removes the custom arc", removeReflex(ok.arc.id) === true);
  check("(B) isReflexEligible: system-info safe", isReflexEligible("system-info") === true);
  check("(B) isReflexEligible: create-note NOT safe", isReflexEligible("create-note") === false);
  check("(B) every live reflex targets a safe action", liveReflexes().every((a) => isReflexEligible(a.actionId)));
  check("(B) built-in reflexes present", listReflexes().filter((a) => a.builtIn).length >= 3);
}

// -----------------------------------------------------------------------------
// (C) PERSONA routing.
// -----------------------------------------------------------------------------
{
  check("(C) file/open → Courier", pickPersona("open the file at the path").id === "courier");
  check("(C) remember/memory → Scribe", pickPersona("what do you remember about me").id === "scribe");
  check("(C) shell/command → Mechanic", pickPersona("run a shell command for me").id === "mechanic");
  check("(C) web/research → Scholar", pickPersona("research this topic on the web").id === "scholar");
  check("(C) no cue → defaults to Scribe", pickPersona("hello there friend").id === "scribe");
  check("(C) Reflex pool is never auto-picked", listPersonas().some((p) => p.id === "reflex") && pickPersona("system info reflex").id !== "reflex");
  const dir = personaDirective(getPersona("courier"));
  check("(C) personaDirective carries the pool name + tools", /Courier/.test(dir) && /list-directory/.test(dir));
  check("(C) isPersonaId guards", isPersonaId("scholar") && !isPersonaId("nope"));
}

// -----------------------------------------------------------------------------
// (D) MOTOR PROGRAMS — eligibility.
// -----------------------------------------------------------------------------
{
  check("(D) system-info is a program step (safe, no args)", isProgramStep("system-info") === true);
  check("(D) recent-memories is a program step", isProgramStep("recent-memories") === true);
  check("(D) search-memory is NOT (needs a query arg)", isProgramStep("search-memory") === false);
  check("(D) create-note is NOT (confirm-tier)", isProgramStep("create-note") === false);
  check("(D) open-path is NOT (os-surface)", isProgramStep("open-path") === false);
  check("(D) canRunAsProgram all-safe", canRunAsProgram(["system-info", "recent-memories"]) === true);
  check("(D) canRunAsProgram rejects a confirm step", canRunAsProgram(["system-info", "create-note"]) === false);
  check("(D) canRunAsProgram rejects empty", canRunAsProgram([]) === false);
}

// -----------------------------------------------------------------------------
// (E) DISPATCH ROUTING.
// -----------------------------------------------------------------------------
const spine = getSpine();

// (E1) PROGRAM — seed a practiced all-safe sequence, then dispatch a matching
// intent that does NOT trip any reflex phrase.
function seedAction(actionId: string, iso: string): void {
  db.prepare(
    `INSERT INTO action_log (id, action_id, args, risk, confirmed, ok, summary, created_at, authorized_via)
     VALUES (?, ?, '{}', 'safe', 0, 1, '', ?, 'safe')`,
  ).run(`al-${ulid()}`, actionId, iso);
}
{
  const t = Date.parse("2026-06-01T10:00:00.000Z");
  const at = (off: number) => new Date(t + off).toISOString();
  seedAction("system-info", at(0));
  seedAction("recent-memories", at(60_000));
  seedAction("system-info", at(60 * 60_000));
  seedAction("recent-memories", at(61 * 60_000));
  const learned = extractProcedures();
  check("(E1) procedure mined from the action audit", learned >= 1, `learned=${learned}`);
  const proc = listProcedures().find((p) => p.steps.join("→") === "system-info→recent-memories");
  check("(E1) selectProgram returns the practiced sequence",
    selectProgram("refresh the info and memories overview")?.steps.join("→") === "system-info→recent-memories",
    JSON.stringify(selectProgram("refresh the info and memories overview")));
  const before = proc?.successCount ?? 0;
  const cmd = await spine.dispatch({ intent: "refresh the info and memories overview", personaId: "scribe", mode: "safe-only" });
  check("(E1) dispatch routes to the PROGRAM tract", cmd.tract === "program", JSON.stringify({ tract: cmd.tract, status: cmd.status }));
  check("(E1) program ran both safe steps ok", cmd.ok === true);
  const after = listProcedures().find((p) => p.id === proc?.id)?.successCount ?? 0;
  check("(E1) the program run credited the procedure", after === before + 1, `${before}→${after}`);
}

// (E2) REFLEX — a knee-jerk intent fires system-info through the executor.
{
  const frames: unknown[] = [];
  const cmd = await spine.dispatch({ intent: "give me the system info please", mode: "safe-only" }, (f) => frames.push(f));
  check("(E2) dispatch routes to the REFLEX tract", cmd.tract === "reflex", JSON.stringify({ tract: cmd.tract }));
  check("(E2) the safe action executed ok", cmd.ok === true && /CPU|RAM|free/i.test(cmd.summary ?? ""));
  const spineFrames = frames.filter((f): f is { type: string; event: { kind: string } } =>
    !!f && typeof f === "object" && (f as { type?: string }).type === "spine");
  check("(E2) emits a reflex-fired frame", spineFrames.some((f) => f.event.kind === "reflex-fired"));
  check("(E2) emits an afferent feedback frame", spineFrames.some((f) => f.event.kind === "feedback"));
}

// (E3) DELIBERATE — a confirm-shaped/unknown intent CANNOT shortcut; it goes to
// the agent loop (scripted to finish immediately, no tool).
{
  __setAgentConnector(scripted(['{"thought":"considering","tool":null,"final":"deliberated answer"}']));
  const frames: unknown[] = [];
  const cmd = await spine.dispatch({ intent: "compose a short note: hello world", personaId: "scribe", mode: "safe-only" }, (f) => frames.push(f));
  check("(E3) a write-shaped intent routes to the DELIBERATE tract", cmd.tract === "deliberate", JSON.stringify({ tract: cmd.tract }));
  check("(E3) the deliberate tract captured the loop's answer", /deliberated answer/.test(cmd.summary ?? ""), cmd.summary);
  const spineFrames = frames.filter((f): f is { type: string; event: { kind: string } } =>
    !!f && typeof f === "object" && (f as { type?: string }).type === "spine");
  check("(E3) emits a dispatched frame", spineFrames.some((f) => f.event.kind === "dispatched"));
  __setAgentConnector(null);
}

// (E4) The Reflex POOL never deliberates — an unmatched intent is blocked, not escalated.
{
  const cmd = await spine.dispatch({ intent: "ponder the meaning of existence", personaId: "reflex", mode: "safe-only" });
  check("(E4) Reflex pool blocks an unmatched intent (no deliberation)", cmd.tract === "reflex" && cmd.status === "blocked");
}

// -----------------------------------------------------------------------------
// (F) THE HERMES QUEUE.
// -----------------------------------------------------------------------------
{
  const lo = spine.enqueue({ intent: "system status", priority: 5 });
  const hi = spine.enqueue({ intent: "system info", priority: 9 });
  check("(F) both commands queued", lo.status === "queued" && hi.status === "queued");
  const pendingBefore = spine.snapshot().pending;
  check("(F) higher priority sorts first", pendingBefore[0]?.priority === 9 && pendingBefore[0]?.id === hi.id);
  const ran = await spine.tick();
  check("(F) tick drains the due commands", ran === 2);
  check("(F) queue is empty after the tick", spine.snapshot().queueDepth === 0);
  const reflexCount = spine.snapshot().tractCounts.reflex;
  check("(F) queued reflex intents executed via the reflex tract", reflexCount >= 2, `reflex=${reflexCount}`);
}

// -----------------------------------------------------------------------------
// (G) SNAPSHOT shape + failure isolation.
// -----------------------------------------------------------------------------
{
  const snap = spine.snapshot();
  check("(G) snapshot exposes the 6 motor pools", snap.personas.length === 6);
  check("(G) snapshot exposes the reflex arcs", snap.reflexes.length >= 3);
  check("(G) snapshot has all three tract counters", ["reflex", "program", "deliberate"].every((k) => k in snap.tractCounts));
  check("(G) recent commands recorded", snap.recent.length > 0);

  // Empty intent is rejected, never thrown.
  let threw = false;
  let rejected = false;
  try {
    const c = await spine.dispatch({ intent: "   " });
    rejected = c.status === "rejected";
  } catch {
    threw = true;
  }
  check("(G) empty intent → rejected, not thrown", rejected && !threw);

  // Reflex persistence degrades to empty with the metadata table dropped.
  db.exec("DROP TABLE IF EXISTS brain_metadata");
  let threw2 = false;
  try {
    listReflexes();
    matchReflex("system info");
    registerReflex({ name: "x", triggers: ["x"], actionId: "system-info" });
  } catch {
    threw2 = true;
  }
  check("(G) reflex API does not throw without brain_metadata", threw2 === false);
}

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
