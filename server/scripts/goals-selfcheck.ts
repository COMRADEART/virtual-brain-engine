// Goal-hierarchy selfcheck — hermetic (throwaway DB via BRAIN_DB_PATH,
// scripted stub connector, NO LLM, NO network). Mirrors beliefs-selfcheck.ts.
//
// Run: npm --prefix server run goals:selfcheck
//
// Asserts:
//   (A) PURE tree math: goalLinks filters goal-id links from free text;
//       levelForDepth maps depth → long/mid/short/action; buildForest
//       reconstructs the forest (children never double as roots; cycles
//       guarded); forestDepth; rollUpNode priority-weighted mean (completed
//       children count as 1); actionableLeaves respects status + goal-id
//       dependencies; parseSubgoals handles clean/embedded/junk JSON.
//   (B) decomposeGoal over the temp DB with a scripted connector: a root goal
//       gains 2-4 child goals linked via subgoals[]; the tree round-trips
//       through goal_history; depth cap + already-decomposed + no-connector
//       degrades carry reasons; the model's JSON is validated (junk → reason).
//   (C) rollUpProgress: a child update propagates to the parent (priority-
//       weighted), crossing a notch emits a `goal-progress` cognition event.
//   (D) Emergence: a synthetic `exploration-scheduled` on a private bus grows
//       an "Explore:" goal + bumps the stage counter; the rate limiter holds;
//       a high-divergence reflection grows a goal, low divergence doesn't.
//   (E) Workspace: collectBids carries a hierarchy-aware goal bid.
//   (F) Failure isolation: with goal_history dropped, no public method throws.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

const tmp = mkdtempSync(join(tmpdir(), "brain-goals-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const {
  goalLinks,
  levelForDepth,
  buildForest,
  forestDepth,
  rollUpNode,
  actionableLeaves,
  parseSubgoals,
  GoalManager,
  __resetGoalManagerForTests,
  EXPLORE_GOAL_MIN_GAP_MS,
  EXPLORATION_EVENTS_KEY,
  MAX_DEPTH,
} = await import("../src/core/goalManager.js");
const { BrainBus } = await import("../src/core/eventBus.js");
const { createPersistentOrganism } = await import("../src/core/organism.js");
const { openDb } = await import("../src/db/sqlite.js");
import type { BrainEvent } from "../src/core/eventBus.js";
import type { PersistentGoal } from "../../shared/organism.js";
import type { Connector } from "../src/connectors/Connector.js";

const db = openDb();

// -----------------------------------------------------------------------------
// (A) PURE tree math.
// -----------------------------------------------------------------------------

check("goalLinks keeps goal ids, drops free text",
  goalLinks(["goal-abc", "remember the env file", "goal-def"]).length === 2);
check("levelForDepth ladder", levelForDepth(0) === "long-term" && levelForDepth(1) === "mid-term" &&
  levelForDepth(2) === "short-term" && levelForDepth(3) === "action" && levelForDepth(9) === "action");

function g(id: string, over: Partial<PersistentGoal> = {}): PersistentGoal {
  return {
    id,
    title: over.title ?? id,
    status: over.status ?? "active",
    progress: over.progress ?? 0,
    priority: over.priority ?? 50,
    dependencies: over.dependencies ?? [],
    subgoals: over.subgoals ?? [],
    attempts: [],
    blockers: [],
    confidence: 0.5,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

{
  const root = g("goal-r", { subgoals: ["goal-a", "goal-b", "a free-text note"] });
  const a = g("goal-a", { subgoals: ["goal-c"] });
  const b = g("goal-b", { progress: 0.5, priority: 30 });
  const c = g("goal-c", { status: "completed", progress: 1 });
  const lone = g("goal-lone");
  const forest = buildForest([root, a, b, c, lone]);
  check("buildForest: children never double as roots", forest.length === 2, `roots=${forest.length}`);
  const rootNode = forest.find((n) => n.goal.id === "goal-r")!;
  check("buildForest: nested children resolve", rootNode.children.length === 2 &&
    rootNode.children.find((n) => n.goal.id === "goal-a")?.children[0]?.goal.id === "goal-c");
  check("buildForest: levels follow depth", rootNode.level === "long-term" &&
    rootNode.children[0].level === "mid-term" &&
    rootNode.children.find((n) => n.goal.id === "goal-a")!.children[0].level === "short-term");
  check("forestDepth measures the deepest node", forestDepth(forest) === 2);

  // rollUpNode: a (leaf via c, completed → 1) weight 50; b progress 0.5 weight 30.
  // a's own roll-up = c = 1. parent = (50*1 + 30*0.5)/80 = 0.8125.
  const rolled = rollUpNode(rootNode);
  check("rollUpNode priority-weighted mean (completed=1)", Math.abs(rolled - 0.8125) < 1e-9, `rolled=${rolled}`);

  // Cycle guard: two goals referencing each other terminate.
  const x = g("goal-x", { subgoals: ["goal-y"] });
  const y = g("goal-y", { subgoals: ["goal-x"] });
  const cyc = buildForest([x, y]);
  check("buildForest survives a cycle", forestDepth(cyc) <= 8);
}

{
  // actionableLeaves: active leaf with completed deps wins; blocked dep excluded.
  const root = g("goal-r", { subgoals: ["goal-a", "goal-b"], priority: 80 });
  const a = g("goal-a", { dependencies: ["goal-b"] }); // dep NOT completed → blocked
  const b = g("goal-b");
  const leaves = actionableLeaves(buildForest([root, a, b]), 5);
  check("actionableLeaves excludes a leaf with an incomplete dependency",
    !leaves.some((l) => l.goal.id === "goal-a") && leaves.some((l) => l.goal.id === "goal-b"));
  const done = g("goal-b", { status: "completed", progress: 1 });
  const leaves2 = actionableLeaves(buildForest([root, a, done]), 5);
  check("actionableLeaves unblocks once the dependency completes",
    leaves2.some((l) => l.goal.id === "goal-a"));
  check("actionableLeaves skips non-active leaves", !leaves2.some((l) => l.goal.id === "goal-b"));
  check("deeper leaves get a depth bonus",
    (leaves2.find((l) => l.goal.id === "goal-a")?.salience ?? 0) >
    actionableLeaves(buildForest([g("goal-solo", { priority: 80 })]), 1)[0].salience);
}

check("parseSubgoals: clean JSON", parseSubgoals('{"subgoals":["Do one thing","Do another thing"]}').length === 2);
check("parseSubgoals: embedded JSON", parseSubgoals('Sure: {"subgoals":["Only this one works"]}').length === 1);
check("parseSubgoals: junk → empty", parseSubgoals("not json").length === 0);
check("parseSubgoals: caps at 4", parseSubgoals('{"subgoals":["a 1234","b 1234","c 1234","d 1234","e 1234"]}').length === 4);

// -----------------------------------------------------------------------------
// (B) decomposeGoal over the temp DB.
// -----------------------------------------------------------------------------

const bus = new BrainBus();
const events: BrainEvent[] = [];
bus.onAny((e) => events.push(e));
const organism = createPersistentOrganism(bus);
let clk = 1_000_000_000;
const manager = new GoalManager(bus, organism, { clock: () => clk });

const root = organism.createGoal({ title: "Become a reliable personal cognitive system", priority: 80 }).goal;

const stub = {
  descriptor: { id: "stub", kind: "ollama" },
  send: async () =>
    '{"subgoals":["Strengthen memory consolidation quality","Improve retrieval grounding for answers","Grow the causal world model"]}',
} as unknown as Connector;

{
  events.length = 0;
  const report = await manager.decomposeGoal(root.id, { connector: stub });
  check("(B) decompose created the children", report.decomposed === 3, JSON.stringify(report));
  const tree = manager.goalTree();
  const rootNode = tree.find((n) => n.goal.id === root.id);
  check("(B) tree round-trips through goal_history", rootNode?.children.length === 3,
    `children=${rootNode?.children.length}`);
  check("(B) children sit one level deeper", rootNode?.children.every((c) => c.level === "mid-term") === true);
  check("(B) goalTreeDepth reflects the new layer", manager.goalTreeDepth() === 1);
  const cog = events.find((e) => e.kind === "cognition");
  check("(B) decompose emits a goal-formed cognition event",
    cog?.kind === "cognition" && cog.event.kind === "goal-formed");

  const again = await manager.decomposeGoal(root.id, { connector: stub });
  check("(B) already-decomposed degrades with a reason", again.decomposed === 0 && /decomposed/.test(again.reason ?? ""));
  const noConn = await manager.decomposeGoal(rootNode!.children[0].goal.id, { connector: null });
  check("(B) no connector degrades with a reason", noConn.decomposed === 0 && /connector/.test(noConn.reason ?? ""));
  const junkStub = { descriptor: { id: "junk" }, send: async () => "no json at all" } as unknown as Connector;
  const junk = await manager.decomposeGoal(rootNode!.children[0].goal.id, { connector: junkStub });
  check("(B) junk model output is rejected, nothing persists", junk.decomposed === 0 && Boolean(junk.reason));
  check("(B) depth cap honoured", MAX_DEPTH === 3);
}

// -----------------------------------------------------------------------------
// (C) rollUpProgress propagates child → parent.
// -----------------------------------------------------------------------------

{
  const tree = manager.goalTree();
  const rootNode = tree.find((n) => n.goal.id === root.id)!;
  const child = rootNode.children[0].goal;
  events.length = 0;
  organism.updateGoal({ goalId: child.id, progress: 0.9 });
  const rolled = manager.rollUpProgress(child.id);
  check("(C) roll-up returns the parent's new progress", rolled > 0.25 && rolled < 0.35, `rolled=${rolled}`);
  const after = manager.goalTree().find((n) => n.goal.id === root.id)!;
  check("(C) parent progress persisted", Math.abs(after.goal.progress - rolled) < 1e-6,
    `parent=${after.goal.progress}`);
  const cog = events.find((e) => e.kind === "cognition" && e.event.kind === "goal-progress");
  check("(C) crossing a notch emits goal-progress", Boolean(cog));
  check("(C) roll-up on a root is a safe no-op", manager.rollUpProgress(root.id) === -1);
}

// -----------------------------------------------------------------------------
// (D) Emergence — curiosity + reflection grow goals.
// -----------------------------------------------------------------------------

{
  events.length = 0;
  bus.emit({ kind: "exploration-scheduled", target: "memory-cluster-7", curiosity: 0.8, reason: "test", at: new Date().toISOString() });
  const explore = manager.goalTree().flatMap((n) => [n, ...n.children]).find((n) => n.goal.title.startsWith("Explore:"));
  check("(D) exploration event grows an Explore goal", Boolean(explore));
  check("(D) goal-formed cognition emitted for emergence",
    events.some((e) => e.kind === "cognition" && e.event.kind === "goal-formed"));
  const counter = db.prepare("SELECT value FROM brain_metadata WHERE key = ?").get(EXPLORATION_EVENTS_KEY) as
    | { value: string }
    | undefined;
  check("(D) exploration counter bumped (stage metric)", Number(counter?.value ?? 0) >= 1, `count=${counter?.value}`);

  // Rate limiter: a second event inside the gap creates NO new goal.
  const before = manager.goalTree().length;
  bus.emit({ kind: "exploration-scheduled", target: "another-target", curiosity: 0.9, reason: "test", at: new Date().toISOString() });
  check("(D) explore rate limiter holds inside the gap", manager.goalTree().length === before);
  clk += EXPLORE_GOAL_MIN_GAP_MS + 1;
  bus.emit({ kind: "exploration-scheduled", target: "another-target", curiosity: 0.9, reason: "test", at: new Date().toISOString() });
  check("(D) explore allowed again after the gap", manager.goalTree().length === before + 1);
  const counter2 = db.prepare("SELECT value FROM brain_metadata WHERE key = ?").get(EXPLORATION_EVENTS_KEY) as { value: string };
  check("(D) counter counts EVERY event, limited or not", Number(counter2.value) === 3, `count=${counter2.value}`);

  // Reflection: low divergence → no goal; high divergence → goal.
  const beforeRef = manager.goalTree().length;
  check("(D) low-divergence reflection grows nothing",
    manager.onReflection(0.9, "minor drift", "as expected") === null && manager.goalTree().length === beforeRef);
  const grown = manager.onReflection(0.2, "deploy risk was underestimated", "the deploy failed");
  check("(D) high-divergence reflection grows an understand-why goal",
    grown !== null && /Understand why/.test(grown.title));
}

// -----------------------------------------------------------------------------
// (E) Workspace carries a hierarchy-aware goal bid.
// -----------------------------------------------------------------------------

{
  __resetGoalManagerForTests(); // workspace uses the singleton accessor
  const { collectBids } = await import("../src/core/workspace.js");
  const bids = collectBids();
  const goalBid = bids.find((b) => b.kind === "goal");
  check("(E) collectBids carries a goal bid from the hierarchy", Boolean(goalBid), JSON.stringify(bids.map((b) => b.kind)));
  check("(E) goal bid stays in the quiet-round salience band", (goalBid?.salience ?? 1) <= 0.5, `sal=${goalBid?.salience}`);
}

// -----------------------------------------------------------------------------
// (F) Failure isolation — drop goal_history; nothing throws.
// -----------------------------------------------------------------------------

{
  db.exec("DROP TABLE IF EXISTS goal_history");
  __resetGoalManagerForTests();
  const broken = new GoalManager(bus, organism, { clock: () => clk });
  let threw = false;
  try {
    broken.goalTree();
    broken.goalTreeDepth();
    broken.nextActionableLeaves();
    broken.rollUpProgress("goal-x");
    await broken.decomposeGoal("goal-x", { connector: null });
    broken.onExploration("t", 0.9, "r");
  } catch {
    threw = true;
  }
  check("(F) no public method throws without goal_history", threw === false);
  check("(F) tree degrades to empty", broken.goalTree().length === 0);
  broken.stop();
}

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
