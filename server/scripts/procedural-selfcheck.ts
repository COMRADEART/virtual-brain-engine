// Procedural-memory + monologue-unification selfcheck — hermetic (throwaway
// DB via BRAIN_DB_PATH, NO LLM, NO network).
//
// Run: npm --prefix server run procedural:selfcheck
//
// Asserts:
//   (A) PURE mining: consecutive ok-sequences inside the 10-min window become
//       candidates; failures and time gaps break runs; self-loops skipped;
//       frequency floor holds; longest-first ordering; laplaceScore math;
//       isOrderedSubsequence; procedureMatch lexical overlap;
//       proceduresPromptBlock empty/filled.
//   (B) extractProcedures over a seeded action_log: a twice-seen sequence
//       persists as a procedure + emits a `cognition` procedure-learned
//       event; re-extraction is idempotent (no duplicate rows).
//   (C) recordOutcome Laplace scoring; creditMatchingProcedures credits a
//       procedure whose steps appear in order in a successful run.
//   (D) proceduresFor retrieves by task tokens; listProcedures shape.
//   (E) toCognition (brainCore bridge): all five legacy thought events map to
//       cognition kinds with bounded magnitude; self-snapshot monologue
//       dedups on the watermark; unrelated events map to null.
//   (F) Failure isolation: with the procedures table dropped, nothing throws.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

const tmp = mkdtempSync(join(tmpdir(), "brain-proc-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const {
  mineSequences,
  laplaceScore,
  isOrderedSubsequence,
  procedureMatch,
  proceduresPromptBlock,
  extractProcedures,
  recordOutcome,
  proceduresFor,
  listProcedures,
  creditMatchingProcedures,
  MIN_OCCURRENCES,
  SEQUENCE_WINDOW_MS,
} = await import("../src/memory/procedural.js");
const { openDb } = await import("../src/db/sqlite.js");
const { getEventBus } = await import("../src/core/eventBus.js");
import type { BrainEvent } from "../src/core/eventBus.js";
import type { ProcedureRecord } from "../src/memory/procedural.js";

const db = openDb();

// -----------------------------------------------------------------------------
// (A) PURE mining + matching.
// -----------------------------------------------------------------------------

const t0 = Date.parse("2026-06-01T10:00:00.000Z");
const at = (offsetMs: number) => new Date(t0 + offsetMs).toISOString();
const e = (actionId: string, offsetMs: number, ok = true) => ({ actionId, ok, createdAt: at(offsetMs) });

{
  // web-search → learn-url appears twice (two separate sessions) → mined.
  const entries = [
    e("web-search", 0),
    e("learn-url", 60_000),
    e("system-info", 30 * 60_000), // isolated (gap) — not part of a pair
    e("web-search", 60 * 60_000),
    e("learn-url", 61 * 60_000),
  ];
  const mined = mineSequences(entries);
  check("mining finds the twice-seen pair", mined.some((m) => m.steps.join("→") === "web-search→learn-url" && m.occurrences === 2), JSON.stringify(mined));
  check("an isolated action never mines", !mined.some((m) => m.steps.includes("system-info")));
}

{
  // A failure breaks the run: the pair around it must not count.
  const entries = [
    e("a-act", 0),
    e("b-act", 30_000, false),
    e("c-act", 60_000),
    e("a-act", 120_000),
    e("b-act", 150_000, false),
    e("c-act", 180_000),
  ];
  check("a failed action breaks the sequence", mineSequences(entries).length === 0);
}

{
  // A gap beyond the window breaks the run.
  const entries = [
    e("a-act", 0),
    e("b-act", SEQUENCE_WINDOW_MS + 60_000),
    e("a-act", 2 * (SEQUENCE_WINDOW_MS + 60_000)),
    e("b-act", 3 * (SEQUENCE_WINDOW_MS + 60_000)),
  ];
  check("a window gap breaks the sequence", mineSequences(entries).length === 0);
}

{
  // Self-loops are not skills; below-frequency sequences don't mine.
  const loop = [e("a-act", 0), e("a-act", 30_000), e("a-act", 60_000), e("a-act", 90_000)];
  check("pure self-loops are skipped", mineSequences(loop).length === 0);
  const once = [e("a-act", 0), e("b-act", 30_000)];
  check("frequency floor holds", mineSequences(once).length === 0 && MIN_OCCURRENCES >= 2);
}

{
  // Longer sequences sort first.
  const session = (base: number) => [e("a-act", base), e("b-act", base + 30_000), e("c-act", base + 60_000)];
  const mined = mineSequences([...session(0), ...session(60 * 60_000)]);
  check("longest sequences sort first", mined[0]?.steps.length === 3, JSON.stringify(mined[0]));
}

check("laplaceScore: fresh = (1)/(2)", laplaceScore(0, 0) === 0.5);
check("laplaceScore: 3 wins 1 loss", Math.abs(laplaceScore(3, 1) - 4 / 6) < 1e-9);
check("isOrderedSubsequence: in-order hit", isOrderedSubsequence(["a", "c"], ["a", "b", "c"]));
check("isOrderedSubsequence: order matters", !isOrderedSubsequence(["c", "a"], ["a", "b", "c"]));
check("isOrderedSubsequence: empty steps never match", !isOrderedSubsequence([], ["a"]));

{
  const proc: ProcedureRecord = {
    id: "proc-x",
    title: "web-search → learn-url",
    triggerClass: "web-search",
    steps: ["web-search", "learn-url"],
    source: "action-sequence",
    successCount: 2,
    failureCount: 0,
    score: 0.75,
    lastUsedAt: null,
    createdAt: at(0),
  };
  const { tokens } = await import("../src/attention/saliency.js");
  check("procedureMatch scores a related task", procedureMatch(new Set(tokens("search the web and learn the page")), proc) > 0);
  check("procedureMatch is 0 for unrelated", procedureMatch(new Set(tokens("paint the bedroom wall")), proc) === 0);
  check("proceduresPromptBlock: empty → empty string", proceduresPromptBlock([]) === "");
  const block = proceduresPromptBlock([proc]);
  check("proceduresPromptBlock lists steps + score", /web-search → learn-url/.test(block) && /75%/.test(block));
}

// -----------------------------------------------------------------------------
// (B) extractProcedures over a seeded action_log.
// -----------------------------------------------------------------------------

function seedAction(actionId: string, offsetMs: number, ok = 1): void {
  db.prepare(
    `INSERT INTO action_log (id, action_id, args, risk, confirmed, ok, summary, created_at, authorized_via)
     VALUES (?, ?, '{}', 'safe', 0, ?, '', ?, 'safe')`,
  ).run(`al-${ulid()}`, actionId, ok, at(offsetMs));
}

const cogEvents: BrainEvent[] = [];
const offCog = getEventBus().onAny((ev) => {
  if (ev.kind === "cognition") cogEvents.push(ev);
});

seedAction("web-search", 0);
seedAction("learn-url", 60_000);
seedAction("web-search", 60 * 60_000);
seedAction("learn-url", 61 * 60_000);

{
  const learned = extractProcedures();
  check("(B) extract learned the recurring sequence", learned >= 1, `learned=${learned}`);
  const rows = listProcedures();
  const proc = rows.find((p) => p.steps.join("→") === "web-search→learn-url");
  check("(B) the procedure persisted with its steps", Boolean(proc), JSON.stringify(rows.map((r) => r.title)));
  check("(B) success evidence = occurrences", (proc?.successCount ?? 0) >= 2);
  check("(B) a cognition procedure-learned event fired",
    cogEvents.some((ev) => ev.kind === "cognition" && ev.event.kind === "procedure-learned"));

  const again = extractProcedures();
  const rowCount = (db.prepare("SELECT COUNT(*) AS n FROM procedures").get() as { n: number }).n;
  check("(B) re-extraction is idempotent", again === 0 && rowCount === rows.length, `rows=${rowCount}`);
}
offCog();

// -----------------------------------------------------------------------------
// (C) Outcomes + crediting + reasoning configs.
// -----------------------------------------------------------------------------

{
  const proc = listProcedures().find((p) => p.source === "action-sequence")!;
  const before = proc.score;
  recordOutcome(proc.id, false);
  const after = listProcedures().find((p) => p.id === proc.id)!;
  check("(C) a failure lowers the Laplace score", after.score < before && after.failureCount === 1);

  const credited = creditMatchingProcedures(["deep-reason", "web-search", "system-info", "learn-url"]);
  const re = listProcedures().find((p) => p.id === proc.id)!;
  check("(C) creditMatchingProcedures credits an in-order match", credited >= 1 && re.successCount === after.successCount + 1);
  check("(C) no credit for an out-of-order trail", creditMatchingProcedures(["learn-url", "web-search"]) === 0);
}

// -----------------------------------------------------------------------------
// (D) Retrieval.
// -----------------------------------------------------------------------------

{
  const hits = proceduresFor("search the web for the page and learn the url", 3);
  check("(D) proceduresFor retrieves the relevant procedure",
    hits.some((p) => p.steps.includes("web-search")), JSON.stringify(hits.map((h) => h.title)));
  check("(D) proceduresFor on an unrelated task is empty",
    proceduresFor("water the balcony tomatoes", 3).length === 0);
}

// -----------------------------------------------------------------------------
// (E) toCognition — the unified inner-monologue mapping (brainCore bridge).
// -----------------------------------------------------------------------------

{
  const { toCognition } = await import("../src/agents/brainCore.js");
  const now = new Date().toISOString();

  const thought = toCognition({ kind: "idle-thought", memoryId: "m", preview: "an idle recollection", importance: 0.4, reason: "idle", at: now });
  check("(E) idle-thought → thought", thought?.kind === "thought" && thought.magnitude === 0.4);

  const spike = toCognition({ kind: "exploration-scheduled", target: "cluster-3", curiosity: 0.8, reason: "curiosity", at: now });
  check("(E) exploration-scheduled → curiosity-spike", spike?.kind === "curiosity-spike" && /cluster-3/.test(spike.label));

  const refl = toCognition({
    kind: "imagination-reflection",
    reflection: { id: "r", sessionId: "s", futureId: "f", predictedSummary: "p", actualSummary: "a", predictedRisk: 0.2, actualRisk: 0.7, accuracy: 0.3, lesson: "risk underestimated", createdAt: now },
    at: now,
  });
  check("(E) imagination-reflection → reflection", refl?.kind === "reflection" && Math.abs(refl.magnitude - 0.7) < 1e-9);

  const dream = toCognition({ kind: "imagination-dream", abstractions: [], at: now });
  check("(E) imagination-dream → dream", dream?.kind === "dream");

  const mono = (ts: string) =>
    toCognition(
      {
        kind: "self-snapshot",
        state: {
          recentMonologues: [
            { id: "m1", timestamp: ts, content: "I notice my confidence dropped.", kind: "metacognitive", trigger: "cycle", confidence: 0.6, abstractionLevel: 2 },
          ],
        } as never,
        at: ts,
      },
      "2026-01-01T00:00:00.000Z",
    );
  const fresh = mono("2026-06-01T00:00:00.000Z");
  check("(E) self-snapshot → monologue (newer than watermark)", fresh?.kind === "monologue");
  const stale = toCognition(
    { kind: "self-snapshot", state: { recentMonologues: [{ id: "m1", timestamp: "2025-01-01T00:00:00.000Z", content: "old", kind: "narrative", trigger: "cycle", confidence: 0.5, abstractionLevel: 1 }] } as never, at: now },
    "2026-01-01T00:00:00.000Z",
  );
  check("(E) stale monologue dedups on the watermark", stale === null);

  const other = toCognition({ kind: "memory- count" as never, at: now } as never);
  check("(E) unrelated events map to null", other === null);
  check("(E) magnitudes stay bounded", [thought, spike, refl, dream, fresh].every((c) => c !== null && c.magnitude >= 0 && c.magnitude <= 1));
}

// -----------------------------------------------------------------------------
// (F) Failure isolation.
// -----------------------------------------------------------------------------

{
  db.exec("DROP TABLE IF EXISTS procedures");
  let threw = false;
  try {
    extractProcedures();
    recordOutcome("proc-x", true);
    proceduresFor("anything");
    listProcedures();
    creditMatchingProcedures(["a"]);
  } catch {
    threw = true;
  }
  check("(F) no public function throws without the procedures table", threw === false);
  check("(F) retrieval degrades to empty", listProcedures().length === 0);
}

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
