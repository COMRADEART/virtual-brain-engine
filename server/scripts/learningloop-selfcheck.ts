// Phase 4 — learning-from-use selfcheck. HERMETIC: throwaway DB via
// BRAIN_DB_PATH (set BEFORE importing config-dependent modules), no network, no
// embeddings. Exercises the feedback-signal logic + usage aggregation directly.
//
// Run: npm --prefix server run learningloop:selfcheck
//
// Asserts:
//   Memory feedback — 👍 raises a memory's importance, 👎 lowers it, both
//     clamped to [0,1]; unknown id → null (404 path). Importance is a ranker
//     feature, so this is the live self-improvement loop.
//   Action feedback — recorded as resolver-training data.
//   Usage summary  — aggregates action_log (success rate), ingest_log (volume),
//     and the 👍/👎 tallies correctly.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "brain-loopcheck-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const { openDb } = await import("../src/db/sqlite.js");
const { upsertMemoryPoint, getMemoryPoint } = await import("../src/db/repositories/memory.js");
const { insertActionLog } = await import("../src/db/repositories/actions.js");
const { insertIngestLog } = await import("../src/db/repositories/ingest.js");
const { applyMemoryFeedback, applyActionFeedback, getUsageSummary } = await import("../src/learning/usage.js");

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

openDb();

const sha = (s: string) => s; // content hash not important here; uniqueness via text
function makeMemory(content: string, importance: number): string {
  const m = upsertMemoryPoint({
    sourceType: "manual",
    title: content.slice(0, 20),
    content,
    contentHash: sha(content),
    importance,
  });
  return m.id;
}

// --- Memory feedback raises/lowers importance (the live ranker loop) --------
{
  const id = makeMemory("a useful memory about sqlite", 0.5);
  const up = applyMemoryFeedback(id, 1);
  check("memory 👍 raises importance", !!up && up.importance > 0.5, `→ ${up?.importance}`);
  check("memory 👍 is persisted", (getMemoryPoint(id)?.importance ?? 0) > 0.5);
  const down = applyMemoryFeedback(id, -1);
  check("memory 👎 lowers importance", !!down && down.importance < (up?.importance ?? 1));
}
{
  const hi = makeMemory("nearly-max importance memory", 0.99);
  const r = applyMemoryFeedback(hi, 1);
  check("importance is clamped at 1.0", !!r && r.importance <= 1.0, `→ ${r?.importance}`);
  const lo = makeMemory("nearly-zero importance memory", 0.02);
  const r2 = applyMemoryFeedback(lo, -1);
  check("importance is clamped at 0.0", !!r2 && r2.importance >= 0.0, `→ ${r2?.importance}`);
}
check("feedback on unknown memory returns null", applyMemoryFeedback("does-not-exist", 1) === null);

// --- Action feedback recorded ----------------------------------------------
applyActionFeedback("search-memory", 1);
applyActionFeedback("trigger-scan", -1);

// --- Usage summary aggregation ----------------------------------------------
// Seed action_log: 2 successes, 1 failure.
insertActionLog({ actionId: "recent-memories", args: {}, risk: "safe", confirmed: false, ok: true, summary: "" });
insertActionLog({ actionId: "create-note", args: {}, risk: "confirm", confirmed: true, ok: true, summary: "" });
insertActionLog({ actionId: "search-memory", args: {}, risk: "safe", confirmed: false, ok: false, summary: "boom" });
// Seed ingest_log: 2 runs, 4 ingested total.
insertIngestLog({ sourceId: "manual", received: 2, ingested: 2, deduped: 0, redacted: 0, skipped: 0 });
insertIngestLog({ sourceId: "clipboard", received: 3, ingested: 2, deduped: 1, redacted: 0, skipped: 0 });

{
  const u = getUsageSummary();
  check("usage: action total counted", u.actions.total === 3, `total=${u.actions.total}`);
  check("usage: action successes counted", u.actions.ok === 2, `ok=${u.actions.ok}`);
  check("usage: success rate ≈ 2/3", Math.abs(u.actions.successRate - 2 / 3) < 1e-9, `rate=${u.actions.successRate}`);
  check("usage: ingest total summed", u.ingest.totalIngested === 4, `total=${u.ingest.totalIngested}`);
  // From the memory-feedback section above: 1 up (the 0.99 also +1 = 2 up), the
  // first memory had +1 then -1 (1 up, 1 down), low memory -1. Count by replay:
  // ups = first(+1) + hi(+1) = 2 ; downs = first(-1) + lo(-1) = 2.
  check("usage: memory feedback tallied", u.memoryFeedback.up === 2 && u.memoryFeedback.down === 2, JSON.stringify(u.memoryFeedback));
  check("usage: action feedback tallied", u.actionFeedback.up === 1 && u.actionFeedback.down === 1, JSON.stringify(u.actionFeedback));
}

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
