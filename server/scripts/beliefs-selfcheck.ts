// Belief-engine selfcheck — hermetic (throwaway DB via BRAIN_DB_PATH, scripted
// stub connector, NO LLM, NO network). Mirrors sleep-selfcheck.ts.
//
// Run: npm --prefix server run beliefs:selfcheck
//
// Asserts:
//   (A) PURE math: normalize/hash dedup key; updateConfidence bounds +
//       asymmetry (one contradiction outweighs one support); decayConfidence
//       drifts toward 0.5 monotonically; statusFor transitions (retire,
//       sticky contested, revival); lexicalMatch overlap scoring.
//   (B) Migration: a raw legacy DB (no beliefs table) gains it via
//       applyMigrations; the fresh temp DB has it from schema.sql.
//   (C) Engine over the temp DB: form persists + emits `cognition`
//       belief-formed on the bus; a duplicate statement ACCRUES (no second
//       row); recordContradiction lowers confidence + sets contested + emits
//       belief-update; noteSurprise erodes only lexically-related beliefs;
//       onAnswerFeedback nudges supported beliefs; decayTick drifts stale
//       beliefs and retires the deeply eroded; stats/list/candidates shapes.
//   (D) Workspace loop closure: collectBids() carries a belief bid for a
//       contested belief; runWorkspaceCycle with a scripted connector writes
//       the re-examination micro-thought as a memory (bidKind "belief").
//   (E) End-to-end sleep: distilled facts become beliefs (report.beliefs).
//   (F) Failure isolation: with the beliefs table dropped, no public method
//       throws and every read degrades to an empty/zero shape.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

// Throwaway DB BEFORE importing anything that opens it.
const tmp = mkdtempSync(join(tmpdir(), "brain-beliefs-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const {
  normalizeStatement,
  statementHash,
  updateConfidence,
  decayConfidence,
  statusFor,
  lexicalMatch,
  getBeliefEngine,
  __resetBeliefEngineForTests,
  __createBeliefEngineForTests,
  INITIAL_CONFIDENCE,
  CONFIDENCE_CEIL,
  CONFIDENCE_FLOOR,
  RETIRE_BELOW,
  WEAKENING_BELOW,
} = await import("../src/core/beliefs.js");
const { BrainBus } = await import("../src/core/eventBus.js");
const { openDb, applyMigrations } = await import("../src/db/sqlite.js");
const { tokens } = await import("../src/attention/saliency.js");
import type { BrainEvent } from "../src/core/eventBus.js";
import type { Connector } from "../src/connectors/Connector.js";

const db = openDb();

// -----------------------------------------------------------------------------
// (A) PURE math.
// -----------------------------------------------------------------------------

check(
  "normalizeStatement collapses case/whitespace/punctuation",
  normalizeStatement("  The   Staging Deploy NEEDS the env FILE!! ") ===
    "the staging deploy needs the env file",
);
check(
  "statementHash is stable across formatting",
  statementHash("Paris is in France.") === statementHash("  paris   is in france "),
);
check(
  "statementHash differs for different statements",
  statementHash("Paris is in France") !== statementHash("Paris is in Texas"),
);

{
  const up = updateConfidence(0.5, "support");
  const down = updateConfidence(0.5, "contradict");
  check("support raises confidence", up > 0.5, `up=${up}`);
  check("contradiction lowers confidence", down < 0.5, `down=${down}`);
  check(
    "asymmetry: one contradiction outweighs one support",
    0.5 - down > up - 0.5,
    `Δdown=${(0.5 - down).toFixed(3)} Δup=${(up - 0.5).toFixed(3)}`,
  );
  check("confidence never exceeds the ceiling", updateConfidence(0.97, "support") <= CONFIDENCE_CEIL);
  check("confidence never drops below the floor", updateConfidence(0.03, "contradict") >= CONFIDENCE_FLOOR);
  check("weight 0 is a no-op", updateConfidence(0.5, "support", 0) === 0.5);
  check("non-finite prev collapses safely", Number.isFinite(updateConfidence(Number.NaN, "support")));
}

{
  const d10 = decayConfidence(0.9, 10);
  const d40 = decayConfidence(0.9, 40);
  check("decay drifts a high belief toward 0.5", d10 < 0.9 && d10 > 0.5);
  check("decay is monotonic in elapsed days", d40 < d10);
  check("decay drifts a LOW belief UP toward 0.5", decayConfidence(0.1, 40) > 0.1);
  check("decay with 0 days is identity", decayConfidence(0.7, 0) === 0.7);
}

check("statusFor retires below the retire floor", statusFor(RETIRE_BELOW - 0.01, "active") === "retired");
check("statusFor weakens below the weakening floor", statusFor(WEAKENING_BELOW - 0.01, "active") === "weakening");
check("statusFor keeps contested sticky at middling confidence", statusFor(0.5, "contested") === "contested");
check(
  "statusFor clears contested once confidence recovers",
  statusFor(INITIAL_CONFIDENCE + 0.05, "contested") === "active",
);
check("statusFor revives a retired belief on strong evidence", statusFor(0.6, "retired") === "active");

{
  const qt = new Set(tokens("the staging deploy script failed"));
  check("lexicalMatch scores overlapping statements", lexicalMatch(qt, "The staging deploy needs the env file") > 0);
  check("lexicalMatch is 0 for unrelated statements", lexicalMatch(qt, "cherry tomatoes thrive in pots") === 0);
  check("lexicalMatch handles empty token set", lexicalMatch(new Set<string>(), "anything") === 0);
}

// -----------------------------------------------------------------------------
// (B) Migration paths.
// -----------------------------------------------------------------------------

{
  const fresh = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='beliefs'")
    .get();
  check("(B) fresh DB has the beliefs table from schema.sql", Boolean(fresh));

  // Legacy DB: a raw connection with only schema_migrations — applyMigrations
  // must create the beliefs table (the 0010 create-on-legacy path).
  const BetterSqlite3 = (await import("better-sqlite3")).default;
  const legacy = new BetterSqlite3(join(tmp, "legacy.sqlite"));
  legacy.exec(
    "CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL)",
  );
  applyMigrations(legacy);
  const migrated = legacy
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='beliefs'")
    .get();
  check("(B) legacy DB gains the beliefs table via migration 0010", Boolean(migrated));
  legacy.close();
}

// -----------------------------------------------------------------------------
// (C) Engine over the temp DB — private bus, injected clock.
// -----------------------------------------------------------------------------

const bus = new BrainBus();
const events: BrainEvent[] = [];
bus.onAny((e) => events.push(e));
const clk = Date.parse("2026-06-01T00:00:00.000Z");
const engine = __createBeliefEngineForTests(bus, () => new Date(clk).toISOString());

const formed = engine.formBeliefFromFact(
  "The staging deploy script requires the staging env file.",
  ["mem-1", "mem-2"],
  "star",
);
check("form persists a belief", formed !== null && formed.confidence === INITIAL_CONFIDENCE);
check("form starts active with supporting evidence", formed?.status === "active" && formed?.supportingIds.length === 2);
{
  const cog = events.find((e) => e.kind === "cognition");
  check("form emits a cognition belief-formed event", cog?.kind === "cognition" && cog.event.kind === "belief-formed");
  if (cog?.kind === "cognition") {
    check("cognition event carries regions + bounded magnitude",
      cog.event.logicalRegions.length > 0 && cog.event.magnitude >= 0 && cog.event.magnitude <= 1);
  }
}

// Duplicate statement (different formatting) ACCRUES, never duplicates.
const dup = engine.formBeliefFromFact(
  "  the STAGING deploy script requires the staging env file!  ",
  ["mem-3"],
  "star",
);
check("duplicate statement accrues instead of duplicating", dup?.id === formed?.id);
check("accrual raises confidence", (dup?.confidence ?? 0) > INITIAL_CONFIDENCE);
check("accrual appends fresh supporting evidence", dup?.supportingIds.includes("mem-3") === true);
{
  const n = db.prepare("SELECT COUNT(*) AS n FROM beliefs").get() as { n: number };
  check("exactly one row for the deduped statement", n.n === 1, `rows=${n.n}`);
}
check("re-forming with NO fresh ids still gently reinforces",
  (engine.formBeliefFromFact("The staging deploy script requires the staging env file.", ["mem-1"]) ?.confidence ?? 0) > (dup?.confidence ?? 1));

// Contradiction: a memory the belief leans on is contradicted.
{
  const before = engine.byId(formed!.id)!.confidence;
  events.length = 0;
  const affected = engine.recordContradiction("mem-99", "mem-1");
  const after = engine.byId(formed!.id)!;
  check("recordContradiction finds beliefs via supporting ids", affected === 1, `affected=${affected}`);
  check("contradiction lowers confidence", after.confidence < before);
  check("contradiction sets status contested", after.status === "contested");
  check("contradicting evidence is recorded", after.contradictingIds.includes("mem-99"));
  const cog = events.find((e) => e.kind === "cognition");
  check("contradiction emits a belief-update event", cog?.kind === "cognition" && cog.event.kind === "belief-update");
}

// addEvidence support recovers confidence.
{
  const before = engine.byId(formed!.id)!.confidence;
  engine.addEvidence(formed!.id, "mem-4", "support");
  check("addEvidence(support) raises confidence", engine.byId(formed!.id)!.confidence > before);
}

// noteSurprise erodes ONLY lexically-related beliefs.
{
  const unrelated = engine.formBeliefFromFact("Cherry tomatoes thrive in balcony pots.", ["mem-t"], null)!;
  const relBefore = engine.byId(formed!.id)!.confidence;
  const unrelBefore = engine.byId(unrelated.id)!.confidence;
  const eroded = engine.noteSurprise("why did the staging deploy script fail with the env file", 0.9);
  check("noteSurprise erodes a related belief", eroded >= 1 && engine.byId(formed!.id)!.confidence < relBefore, `eroded=${eroded}`);
  check("noteSurprise leaves unrelated beliefs alone", engine.byId(unrelated.id)!.confidence === unrelBefore);
  check("noteSurprise with zero surprise is a no-op", engine.noteSurprise("staging deploy", 0) === 0);
}

// onAnswerFeedback nudges beliefs supported by the cited memories.
{
  const before = engine.byId(formed!.id)!.confidence;
  const nDown = engine.onAnswerFeedback(["mem-2"], -1);
  check("👎 nudges a supported belief down", nDown === 1 && engine.byId(formed!.id)!.confidence < before);
  const mid = engine.byId(formed!.id)!.confidence;
  engine.onAnswerFeedback(["mem-2"], 1);
  check("👍 nudges it back up", engine.byId(formed!.id)!.confidence > mid);
}

// decayTick: stale beliefs drift toward 0.5; deep-eroded ones retire.
{
  // Make one belief deeply eroded + stale, another high + stale.
  const doomed = engine.formBeliefFromFact("Floppy disks are the best backup medium.", ["mem-f"], null)!;
  db.prepare("UPDATE beliefs SET confidence = 0.21, last_updated = ? WHERE id = ?")
    .run("2025-01-01T00:00:00.000Z", doomed.id);
  db.prepare("UPDATE beliefs SET confidence = 0.95, last_updated = ? WHERE id = ?")
    .run("2026-04-01T00:00:00.000Z", formed!.id);
  const r = engine.decayTick(new Date("2026-06-01T00:00:00.000Z"));
  check("decayTick decays stale beliefs", r.decayed >= 2, JSON.stringify(r));
  const high = engine.byId(formed!.id)!;
  check("stale high belief drifts toward 0.5", high.confidence < 0.95 && high.confidence > 0.5);
  // 17 months of drift pulls 0.21 back toward 0.5, so it does NOT retire;
  // verify the retire path directly: barely-stale + already below the floor
  // (decay nudges 0.18 toward 0.5 but it stays under RETIRE_BELOW → retired).
  db.prepare("UPDATE beliefs SET confidence = 0.18, last_updated = ? WHERE id = ?")
    .run("2026-05-30T00:00:00.000Z", doomed.id);
  const r2 = engine.decayTick(new Date("2026-06-01T00:00:00.000Z"));
  check("decayTick retires a belief that stays under the floor",
    engine.byId(doomed.id)!.status === "retired" && r2.retired >= 1,
    `status=${engine.byId(doomed.id)!.status} conf=${engine.byId(doomed.id)!.confidence.toFixed(3)}`);
}

// Stats / list / candidates.
{
  const stats = engine.beliefStats();
  check("beliefStats counts rows", stats.total >= 3, JSON.stringify(stats));
  check("avgConfidence in [0,1]", stats.avgConfidence >= 0 && stats.avgConfidence <= 1);
  const all = engine.listBeliefs();
  check("listBeliefs returns records with parsed evidence arrays",
    all.length === stats.total && all.every((b) => Array.isArray(b.supportingIds)));
  const contested = engine.listBeliefs({ status: "contested" });
  check("listBeliefs filters by status", contested.every((b) => b.status === "contested"));
}

// reExaminationCandidates: contested first.
{
  // Ensure the main belief is contested for the workspace section below.
  db.prepare("UPDATE beliefs SET status = 'contested', confidence = 0.4 WHERE id = ?").run(formed!.id);
  const cands = engine.reExaminationCandidates(2);
  check("reExaminationCandidates returns contested/weakening beliefs",
    cands.length >= 1 && cands[0].status === "contested", `n=${cands.length}`);
}

// -----------------------------------------------------------------------------
// (D) Workspace loop closure — the belief bids for the micro-thought slot.
// -----------------------------------------------------------------------------

{
  __resetBeliefEngineForTests(); // the workspace uses the singleton
  // Belief bids are developmentally gated (stage ≥ 2, core/stages.ts); this
  // section tests the BIDDER mechanics, so persist a mature stage first
  // (the gates themselves are covered by stages:selfcheck).
  db.prepare(
    "INSERT INTO brain_metadata (key, value) VALUES ('developmental-stage-v1', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(JSON.stringify({ stage: 5, reachedAt: new Date().toISOString(), history: [] }));
  const { collectBids, runWorkspaceCycle } = await import("../src/core/workspace.js");
  const bids = collectBids();
  const beliefBid = bids.find((b) => b.kind === "belief");
  check("(D) collectBids carries a belief bid for a contested belief", Boolean(beliefBid), JSON.stringify(bids.map((b) => b.kind)));
  check("(D) belief bid salience reflects (1 - confidence)",
    (beliefBid?.salience ?? 0) > 0.3 && (beliefBid?.salience ?? 1) <= 0.7,
    `sal=${beliefBid?.salience}`);
  check("(D) belief bid label asks for re-examination", /re-examine/i.test(beliefBid?.label ?? ""));

  let sends = 0;
  const stub = {
    descriptor: { id: "stub", kind: "ollama" },
    send: async () => {
      sends += 1;
      return "On reflection, the staging env requirement only holds for the legacy deploy path.";
    },
  } as unknown as Connector;
  const report = await runWorkspaceCycle({ connector: stub });
  check("(D) workspace cycle ran a micro-thought", report.thought !== null && sends === 1, report.reason ?? "");
  if (report.memoryId) {
    const row = db
      .prepare("SELECT metadata FROM memory_points WHERE id = ?")
      .get(report.memoryId) as { metadata: string } | undefined;
    const meta = row ? (JSON.parse(row.metadata) as { kind?: string; bidKind?: string }) : {};
    check("(D) the re-examination thought persists with its bid kind",
      meta.kind === "workspace-thought" && typeof meta.bidKind === "string");
  }
}

// -----------------------------------------------------------------------------
// (E) End-to-end sleep: distilled facts become beliefs.
// -----------------------------------------------------------------------------

{
  const { upsertMemoryPoint } = await import("../src/db/repositories/memory.js");
  const { runSleepCycle } = await import("../src/memory/sleepCycle.js");
  const seed = (content: string) =>
    upsertMemoryPoint({
      sourceType: "conversation",
      content,
      contentHash: createHash("sha1").update(content).digest("hex"),
      importance: 0.6,
    });
  seed("Q: how does the backup retention policy rotate snapshots A: the backup retention policy keeps seven daily backup snapshots");
  seed("Q: where does the backup retention policy store snapshots A: the backup retention policy stores backup snapshots under data backups");
  seed("Q: how does the backup retention policy prune snapshots A: the backup retention policy prunes the oldest backup snapshots first");

  const stub = {
    descriptor: { id: "stub", kind: "ollama" },
    send: async () => '{"facts":["Backup retention keeps seven daily snapshots and prunes the oldest first."]}',
  } as unknown as Connector;
  const before = (db.prepare("SELECT COUNT(*) AS n FROM beliefs").get() as { n: number }).n;
  const report = await runSleepCycle({ connector: stub });
  const after = (db.prepare("SELECT COUNT(*) AS n FROM beliefs").get() as { n: number }).n;
  check("(E) sleep distillation formed a belief", report.beliefs.formed >= 1 && after > before, JSON.stringify(report.beliefs));
  check("(E) sleep report carries belief decay counters",
    typeof report.beliefs.decayed === "number" && typeof report.beliefs.retired === "number");
}

// -----------------------------------------------------------------------------
// (F) Failure isolation — drop the table; nothing throws, reads degrade.
// -----------------------------------------------------------------------------

{
  db.exec("DROP TABLE IF EXISTS beliefs");
  __resetBeliefEngineForTests();
  const broken = getBeliefEngine();
  let threw = false;
  try {
    broken.formBeliefFromFact("Anything at all worth believing.", ["m"], null);
    broken.addEvidence("belief-x", "m", "support");
    broken.recordContradiction("a", "b");
    broken.noteSurprise("anything", 0.9);
    broken.onAnswerFeedback(["m"], -1);
    broken.decayTick();
    broken.listBeliefs();
    broken.beliefStats();
    broken.reExaminationCandidates();
    broken.topBeliefsFor(new Set(["anything"]));
  } catch {
    threw = true;
  }
  check("(F) no public method throws without the beliefs table", threw === false);
  check("(F) stats degrade to zeros", broken.beliefStats().total === 0);
  const { collectBids } = await import("../src/core/workspace.js");
  let bidsThrew = false;
  try {
    collectBids();
  } catch {
    bidsThrew = true;
  }
  check("(F) collectBids survives a broken belief engine", bidsThrew === false);
}

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
