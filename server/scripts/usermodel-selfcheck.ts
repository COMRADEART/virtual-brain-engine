// Theory-of-Mind user model selfcheck — hermetic (throwaway DB via
// BRAIN_DB_PATH, no LLM, no network). Mirrors neuromod-selfcheck.ts.
//
// Run: npm --prefix server run usermodel:selfcheck
//
// Asserts:
//   (A) PURE: tag extraction drops stopwords/dedups/caps; goal-cue extraction;
//       style signals (brevity → verbosity, technical wording → formality);
//       observeTurn EMAs a repeated tag UP and lets an unseen tag decay, counts
//       turns, derives expertise at the sustained floor, and bumps a grounded
//       turn harder; userPreamble is the strict cold no-op ("" below MIN_TURNS
//       or with no interest over the floor) and is bounded + non-empty once formed.
//   (B) The persisted singleton over a temp DB with an injected clock: observe
//       accumulates turns + interests, stamps updatedAt, survives a fresh
//       instance, status() is JSON-serializable.
//   (C) Failure isolation: with brain_metadata dropped, no method throws and the
//       model degrades to empty (preamble "").

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

const tmp = mkdtempSync(join(tmpdir(), "brain-usermodel-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const {
  MIN_TURNS,
  TAG_WEIGHT_FLOOR,
  EXPERTISE_FLOOR,
  MAX_TAGS_PER_TURN,
  PREAMBLE_MAX_LEN,
  extractTags,
  extractGoal,
  styleSignals,
  observeTurn,
  surfaceInterests,
  userPreamble,
  __createUserModelForTests,
} = await import("../src/core/userModel.js");
const { EMPTY_USER_MODEL } = await import("../../shared/userModel.js");
const { openDb } = await import("../src/db/sqlite.js");

openDb();

const empty = () => ({
  ...EMPTY_USER_MODEL,
  interests: [],
  expertise: [],
  goals: [],
  communicationStyle: { ...EMPTY_USER_MODEL.communicationStyle },
});

// -----------------------------------------------------------------------------
// (A) PURE.
// -----------------------------------------------------------------------------

// Tag extraction.
{
  const tags = extractTags("I want to learn the Rust borrow checker and lifetimes");
  check("extractTags drops stopwords (no 'want'/'learn'/'the')", !tags.includes("want") && !tags.includes("learn") && !tags.includes("the"));
  check("extractTags keeps content tags", tags.includes("rust") && tags.includes("borrow") && tags.includes("lifetimes"));
  check("extractTags caps per turn", extractTags("alpha beta gamma delta epsilon zeta eta theta iota").length <= MAX_TAGS_PER_TURN);
  const dup = extractTags("rust rust rust borrow");
  check("extractTags dedups", new Set(dup).size === dup.length);
}

// Goal cue.
check("extractGoal captures a stated intent", (extractGoal("Help me build a vector search service") ?? "").toLowerCase().includes("build a vector search"));
check("extractGoal null on a plain question", extractGoal("What is a borrow checker?") === null);

// Style signals.
{
  const terse = styleSignals("rust lifetimes?");
  const verbose = styleSignals("could you walk me through how the rust borrow checker reasons about lifetimes across nested closures and why the compiler rejects this particular pattern in detail");
  check("styleSignals: longer prompt → higher verbosity", verbose.verbosity > terse.verbosity, `${terse.verbosity.toFixed(2)}→${verbose.verbosity.toFixed(2)}`);
  const tech = styleSignals("fix fn main() -> Result<(), Error> { let x = foo_bar(); }");
  const casual = styleSignals("how do i say hello to my computer");
  check("styleSignals: technical wording → higher formality", tech.formality > casual.formality, `${casual.formality.toFixed(2)}→${tech.formality.toFixed(2)}`);
}

// observeTurn EMA + counts + expertise + grounded bump.
{
  const prompt = "How does the Rust borrow checker enforce lifetimes?";
  let m = empty();
  const weights: number[] = [];
  for (let i = 0; i < 6; i++) {
    m = observeTurn(m, { prompt, answer: "…", citedCount: 0, confidence: 0.3 });
    weights.push(m.interests.find((t) => t.tag === "rust")?.weight ?? 0);
  }
  check("observeTurn counts turns", m.turns === 6, `turns=${m.turns}`);
  check("observeTurn EMAs a repeated tag upward", weights[5] > weights[0], `${weights[0].toFixed(3)}→${weights[5].toFixed(3)}`);
  check("repeated tag clears the surface floor", (m.interests.find((t) => t.tag === "rust")?.weight ?? 0) >= TAG_WEIGHT_FLOOR);
  check("sustained tag becomes expertise", m.expertise.some((t) => t.tag === "rust"), `expFloor=${EXPERTISE_FLOOR}`);

  // Unseen tag decays once it stops appearing.
  let m2 = observeTurn(empty(), { prompt: "tell me about kubernetes operators", answer: "…", citedCount: 0, confidence: 0.3 });
  const w0 = m2.interests.find((t) => t.tag === "kubernetes")?.weight ?? 0;
  m2 = observeTurn(m2, { prompt: "and what about rust", answer: "…", citedCount: 0, confidence: 0.3 });
  const w1 = m2.interests.find((t) => t.tag === "kubernetes")?.weight ?? 0;
  check("observeTurn decays an unseen tag", w1 < w0, `${w0.toFixed(3)}→${w1.toFixed(3)}`);

  // Grounded turn bumps harder than ungrounded.
  const g = observeTurn(empty(), { prompt, answer: "…", citedCount: 3, confidence: 0.9 });
  const u = observeTurn(empty(), { prompt, answer: "…", citedCount: 0, confidence: 0.2 });
  const gw = g.interests.find((t) => t.tag === "rust")?.weight ?? 0;
  const uw = u.interests.find((t) => t.tag === "rust")?.weight ?? 0;
  check("grounded turn bumps interest harder", gw > uw, `${uw.toFixed(3)} vs ${gw.toFixed(3)}`);

  // Goal recorded.
  const wg = observeTurn(empty(), { prompt: "Help me build a personal search engine", answer: "…", citedCount: 0, confidence: 0.5 });
  check("observeTurn records a stated goal", wg.goals.length === 1 && wg.goals[0].toLowerCase().includes("build a personal search"));
}

// userPreamble — the cold no-op + the formed case.
{
  check("preamble empty on a blank model", userPreamble(empty()) === "");
  // Below MIN_TURNS even with a strong tag → still empty.
  let m = empty();
  for (let i = 0; i < MIN_TURNS - 1; i++) m = observeTurn(m, { prompt: "rust borrow checker lifetimes traits", answer: "…", citedCount: 0, confidence: 0.3 });
  check("preamble empty below MIN_TURNS", userPreamble(m) === "", `turns=${m.turns}`);
  // Past MIN_TURNS with sustained interest → forms.
  for (let i = 0; i < 4; i++) m = observeTurn(m, { prompt: "rust borrow checker lifetimes traits", answer: "…", citedCount: 2, confidence: 0.8 });
  const pre = userPreamble(m);
  check("preamble forms once developed", pre.length > 0 && pre.toLowerCase().includes("rust"), `len=${pre.length}`);
  check("preamble respects max length", userPreamble(m).length <= PREAMBLE_MAX_LEN);
  check("surfaceInterests honors the floor", surfaceInterests(m).every((t) => typeof t === "string"));
}

// -----------------------------------------------------------------------------
// (B) Persisted singleton with injected clock.
// -----------------------------------------------------------------------------

let clk = 5_000_000;
const store = __createUserModelForTests(() => clk);

check("cold store reads the empty model", store.model().turns === 0);

for (let i = 0; i < 5; i++) {
  clk += 1000;
  store.observe({ prompt: "rust async tokio runtime scheduling", answer: "…", citedCount: 2, confidence: 0.8 });
}
const m = store.model();
check("observe accumulates turns", m.turns === 5, `turns=${m.turns}`);
check("observe learns interests", m.interests.some((t) => t.tag === "rust" || t.tag === "tokio"));
check("observe stamps updatedAt from the clock", m.updatedAt === clk, `updatedAt=${m.updatedAt}`);

{
  const reborn = __createUserModelForTests(() => clk);
  check("model persists across instances", reborn.model().turns === 5);
}

{
  const status = store.status();
  check("status carries model + preamble + interests",
    typeof status.preamble === "string" && Array.isArray(status.surfaceInterests) && status.model.turns === 5);
  check("status is JSON-serializable", JSON.parse(JSON.stringify(status)).model.turns === 5);
}

// -----------------------------------------------------------------------------
// (C) Failure isolation.
// -----------------------------------------------------------------------------

openDb().exec("DROP TABLE IF EXISTS brain_metadata");
let threw = false;
try {
  store.observe({ prompt: "anything at all here", answer: "…", citedCount: 0, confidence: 0.5 });
  store.model();
  store.status();
} catch {
  threw = true;
}
check("no method throws with brain_metadata gone", threw === false);
check("broken store degrades to empty (preamble empty)", store.model().turns === 0 && store.status().preamble === "");

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
