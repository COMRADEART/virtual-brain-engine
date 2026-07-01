// Sleep-cycle selfcheck — hermetic (throwaway DB, scripted stub connector,
// NO LLM, NO network).
//
// Run: npm --prefix server run sleep:selfcheck
//
// Asserts:
//   (A) PURE grouping: related episodes cluster, unrelated don't, min-size and
//       group caps hold; parseFacts handles clean JSON / embedded JSON / junk.
//   (B) The full cycle over a temp DB with an injected connector: related
//       conversation episodes are distilled into semantic FACT memories
//       (sourceType manual + metadata.kind "semantic"), provenance
//       "distilled-from" relations are written, and the source episodes are
//       DEMOTED (importance reduced), never deleted.
//   (C) Idempotency: distilled episodes are excluded from the next gather, so
//       a second cycle reports nothing to do.
//   (D) Degrade: no connector → no distillation, a clear reason, no throw.
//   (E) The Hebbian decay piggybacks on the cycle (report carries it).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

const tmp = mkdtempSync(join(tmpdir(), "brain-sleep-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const { groupEpisodes, parseFacts, gatherEpisodes, runSleepCycle, MIN_GROUP } = await import(
  "../src/memory/sleepCycle.js"
);
const { openDb } = await import("../src/db/sqlite.js");
const { upsertMemoryPoint, getMemoryPoint, getRelationsFor } = await import(
  "../src/db/repositories/memory.js"
);
import type { Connector } from "../src/connectors/Connector.js";

const db = openDb();

// -----------------------------------------------------------------------------
// (A) PURE grouping + parsing.
// -----------------------------------------------------------------------------

{
  const ep = (id: string, content: string) => ({ id, content, projectName: null, importance: 0.5 });
  const related = [
    ep("a", "Q: how do I deploy the staging server A: run the deploy script with staging flag"),
    ep("b", "Q: the staging deploy script failed A: the deploy script needs the staging env file"),
    ep("c", "Q: where is the staging env file for deploy A: the deploy env file lives in config staging"),
  ];
  const unrelated = ep("z", "Q: best tomato varieties for a balcony garden A: cherry tomatoes thrive in pots");
  const groups = groupEpisodes([...related, unrelated]);
  check("related episodes form one group", groups.length === 1 && groups[0].length === 3, `groups=${groups.length}`);
  check("unrelated episode stays out", !groups[0]?.some((e) => e.id === "z"));
  check("below min-size → no group", groupEpisodes(related.slice(0, MIN_GROUP - 1)).length === 0);
  check("maxGroups cap holds", groupEpisodes(
    Array.from({ length: 30 }, (_, i) => ep(`g${Math.floor(i / 3)}-${i}`, `topic${Math.floor(i / 3)} alpha beta gamma delta`)),
    { maxGroups: 2, simFloor: 0.5 },
  ).length <= 2);
}

check("parseFacts: clean JSON", parseFacts('{"facts":["A fact.","Another."]}').length === 2);
check("parseFacts: embedded JSON", parseFacts('Sure! {"facts":["Only one."]} hope that helps').length === 1);
check("parseFacts: junk → empty", parseFacts("no json here").length === 0);
check("parseFacts: caps at 3", parseFacts('{"facts":["1","2","3","4","5"]}').length === 3);

// -----------------------------------------------------------------------------
// (B) Full cycle with a scripted connector.
// -----------------------------------------------------------------------------

function insertEpisode(content: string): string {
  return upsertMemoryPoint({
    sourceType: "conversation",
    content,
    contentHash: createHash("sha1").update(content).digest("hex"),
    importance: 0.6,
  }).id;
}

const e1 = insertEpisode("Q: how do I deploy the staging server A: run the deploy script with the staging flag");
insertEpisode("Q: the staging deploy failed A: the deploy script needs the staging env file present");
insertEpisode("Q: where does the staging deploy read config A: the deploy script reads config from the staging env file");

check("gatherEpisodes finds the un-distilled episodes", gatherEpisodes().length === 3);

let sends = 0;
const stubConnector = {
  descriptor: { id: "stub", kind: "ollama" },
  send: async () => {
    sends += 1;
    return '{"facts":["The staging deploy script requires the staging env file in the config directory."]}';
  },
} as unknown as Connector;

const report = await runSleepCycle({ connector: stubConnector });
check("cycle distilled at least one fact", report.distilled >= 1, JSON.stringify(report));
check("cycle scanned + grouped the episodes", report.scanned === 3 && report.groups === 1);
check("the connector was actually consulted", sends >= 1);
check("episodes were demoted, not deleted", report.demoted === 3 && getMemoryPoint(e1) !== null);
check("demotion reduced importance", (getMemoryPoint(e1)?.importance ?? 1) < 0.6, `imp=${getMemoryPoint(e1)?.importance}`);
check("(E) hebbian decay report present", typeof report.hebbian.decayed === "number" && typeof report.hebbian.pruned === "number");

// The fact memory exists with semantic provenance.
{
  const fact = db
    .prepare(
      `SELECT id, importance FROM memory_points WHERE json_extract(metadata, '$.kind') = 'semantic'`,
    )
    .get() as { id: string; importance: number } | undefined;
  check("semantic fact memory persisted", Boolean(fact));
  if (fact) {
    check("fact importance above the episodes", fact.importance > 0.6);
    const rels = getRelationsFor(fact.id).filter((r) => r.kind === "distilled-from");
    check("distilled-from provenance links every source episode", rels.length === 3, `rels=${rels.length}`);
  }
}

// (C) Idempotency: the distilled episodes are excluded from the next gather.
check("distilled episodes excluded from the next gather", gatherEpisodes().length === 0);
const second = await runSleepCycle({ connector: stubConnector });
check("second cycle has nothing to do", second.distilled === 0 && Boolean(second.reason), second.reason ?? "");

// (D) No-connector degrade.
{
  const e4 = insertEpisode("Q: tell me about the backup retention policy A: backups keep seven daily snapshots");
  const e5 = insertEpisode("Q: where do the backup snapshots live A: backup snapshots live in data backups");
  const e6 = insertEpisode("Q: how are old backup snapshots pruned A: backup retention prunes the oldest snapshots");
  void [e4, e5, e6];
  const noConn = await runSleepCycle({ connector: null });
  check("no connector → distillation skipped with a reason", noConn.distilled === 0 && /connector/.test(noConn.reason ?? ""));
  check("episodes remain for the next cycle", gatherEpisodes().length === 3);
}

// Failure isolation: drop the table; the cycle reports instead of throwing.
db.exec("DROP TABLE IF EXISTS memory_relations");
let threw = false;
try {
  await runSleepCycle({ connector: null });
} catch {
  threw = true;
}
check("cycle never throws with a broken graph table", threw === false);

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
