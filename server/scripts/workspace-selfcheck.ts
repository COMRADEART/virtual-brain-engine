// Global-workspace selfcheck — hermetic (throwaway DB, scripted stub
// connector, NO LLM, NO network).
//
// Run: npm --prefix server run workspace:selfcheck
//
// Asserts:
//   (A) PURE arbitration: highest salience wins; deterministic id tie-break;
//       empty → null.
//   (B) Bid assembly over a temp DB: an open question held in BrainState
//       working memory becomes an open-question bid; a quiet brain (no open
//       questions, no causal links, no goals) yields no bids.
//   (C) The cycle with a scripted connector: the winner gets ONE micro-thought,
//       the result is written back as a memory (metadata.kind
//       "workspace-thought"), and an `idle-thought` bus event is emitted with
//       a workspace reason.
//   (D) Degrade: no connector → clear reason, nothing written, no throw; an
//       empty thought is not persisted.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

const tmp = mkdtempSync(join(tmpdir(), "brain-workspace-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const { selectWinner, collectBids, runWorkspaceCycle } = await import("../src/core/workspace.js");
const { getBrainState } = await import("../src/core/brainState.js");
const { getEventBus } = await import("../src/core/eventBus.js");
const { openDb } = await import("../src/db/sqlite.js");
import type { Connector } from "../src/connectors/Connector.js";
import type { WorkspaceBid } from "../src/core/workspace.js";

const db = openDb();

// -----------------------------------------------------------------------------
// (A) PURE arbitration.
// -----------------------------------------------------------------------------

{
  const bids: WorkspaceBid[] = [
    { id: "b", kind: "goal", label: "g", salience: 0.3 },
    { id: "a", kind: "open-question", label: "q", salience: 0.9 },
    { id: "c", kind: "curiosity", label: "c", salience: 0.5 },
  ];
  check("highest salience wins", selectWinner(bids)?.id === "a");
  const tied: WorkspaceBid[] = [
    { id: "z", kind: "goal", label: "z", salience: 0.5 },
    { id: "a", kind: "goal", label: "a", salience: 0.5 },
  ];
  check("ties break deterministically on id", selectWinner(tied)?.id === "a");
  check("empty bids → null", selectWinner([]) === null);
}

// -----------------------------------------------------------------------------
// (B) Bid assembly.
// -----------------------------------------------------------------------------

// Quiet brain: no working memory, no causal links, no organism goals.
{
  const bids = collectBids();
  check("quiet brain yields no bids", bids.length === 0, `bids=${bids.length}`);
}

// An open question in working memory becomes a bid.
getBrainState().noteOpenQuestion("why does the staging deploy keep failing?");
{
  const bids = collectBids();
  check("open question becomes an open-question bid",
    bids.some((b) => b.kind === "open-question" && b.label.includes("staging deploy")),
    JSON.stringify(bids.map((b) => b.kind)));
  check("open-question salience is high", (selectWinner(bids)?.salience ?? 0) > 0.5);
  check("open-question bid is raised by the Reasoning cortex",
    bids.find((b) => b.kind === "open-question")?.cortex === "Reasoning");
}

// noteOpenQuestion dedups the same label.
getBrainState().noteOpenQuestion("why does the staging deploy keep failing?");
check("duplicate open question is not stacked",
  collectBids().filter((b) => b.kind === "open-question").length === 1);

// -----------------------------------------------------------------------------
// (C) The cycle with a scripted connector.
// -----------------------------------------------------------------------------

let sends = 0;
const stubConnector = {
  descriptor: { id: "stub", kind: "ollama" },
  send: async (prompt: string) => {
    sends += 1;
    return `Reframed: check whether the staging env file is present before the deploy step. (re: ${prompt.slice(0, 24)})`;
  },
} as unknown as Connector;

{
  let idleEvent: { reason: string; memoryId: string } | null = null;
  const off = getEventBus().on("idle-thought", (e) => {
    idleEvent = { reason: e.reason, memoryId: e.memoryId };
  });
  const report = await runWorkspaceCycle({ connector: stubConnector });
  off();
  check("cycle ran the micro-thought", sends === 1 && report.thought !== null, JSON.stringify({ bids: report.bids, reason: report.reason }));
  check("winner was the open question", report.winner?.kind === "open-question");
  check("thought written back as memory", report.memoryId !== null);
  if (report.memoryId) {
    const row = db
      .prepare(`SELECT metadata FROM memory_points WHERE id = ?`)
      .get(report.memoryId) as { metadata: string } | undefined;
    const meta = row ? (JSON.parse(row.metadata) as { kind?: string; bidKind?: string; cortex?: string }) : {};
    check("memory tagged workspace-thought", meta.kind === "workspace-thought" && meta.bidKind === "open-question");
    check("memory carries the winning cortex", meta.cortex === "Reasoning");
  }
  check("winner is tagged with its cortex", report.winner?.cortex === "Reasoning");
  check("idle-thought bus event emitted with workspace reason",
    idleEvent !== null && (idleEvent as unknown as { reason: string }).reason.startsWith("workspace:"));
}

// -----------------------------------------------------------------------------
// (C2) Named cortices: a Safety bid pre-empts under stress.
// -----------------------------------------------------------------------------

{
  // Force high cortisol (stress) directly in the modulator store; collectBids
  // reads it live and the Safety cortex should out-arbitrate the open question.
  db.prepare("INSERT INTO brain_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run("neuromodulators-v1", JSON.stringify({ levels: { dopamine: 0.5, norepinephrine: 0.2, acetylcholine: 0.2, serotonin: 0.5, cortisol: 0.85, oxytocin: 0.2 }, updatedAt: Date.now(), pulses: 1 }));
  const bids = collectBids();
  check("high cortisol raises a Safety-cortex bid", bids.some((b) => b.cortex === "Safety"));
  check("Safety cortex pre-empts idle cognition (top salience)", selectWinner(bids)?.cortex === "Safety");
  // Reset cortisol to baseline so the later degrade tests are unaffected.
  db.prepare("DELETE FROM brain_metadata WHERE key = 'neuromodulators-v1'").run();
}

// -----------------------------------------------------------------------------
// (D) Degrades.
// -----------------------------------------------------------------------------

{
  const noConn = await runWorkspaceCycle({ connector: null });
  check("no connector → clear reason, nothing written", noConn.reason === "no connector" && noConn.memoryId === null);

  const empty = {
    descriptor: { id: "stub2", kind: "ollama" },
    send: async () => "   ",
  } as unknown as Connector;
  const emptyReport = await runWorkspaceCycle({ connector: empty });
  check("empty thought is not persisted", emptyReport.memoryId === null && emptyReport.reason === "empty thought");

  const throwing = {
    descriptor: { id: "stub3", kind: "ollama" },
    send: async () => {
      throw new Error("model exploded");
    },
  } as unknown as Connector;
  const failed = await runWorkspaceCycle({ connector: throwing });
  check("a throwing connector degrades to a reason", failed.reason === "micro-thought failed");
}

// Failure isolation: with the working-memory table gone, the cycle still
// returns (the bid assembly degrades to whatever sources survive).
db.exec("DROP TABLE IF EXISTS organism_state");
let threw = false;
try {
  await runWorkspaceCycle({ connector: null });
} catch {
  threw = true;
}
check("cycle never throws with a broken BrainState table", threw === false);

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
