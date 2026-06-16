// Mind layer selfcheck — Cognitive DNA + derived Emotions + Skill registry +
// unified Self-representation. Hermetic (throwaway DB via BRAIN_DB_PATH, NO LLM,
// NO network).
//
// Run: npm --prefix server run mind:selfcheck
//
// Asserts:
//   (A) DNA pure math: neutral defaults, clamp, slow EMA evolution, the
//       cycle/consolidation signal mappings, and EVERY consumer bias being a
//       STRICT NO-OP at the neutral 0.5 trait (and moving the right way off it).
//   (B) DNA singleton: evolve persists + reads back, a notch crossing emits ONE
//       cognition monologue event, reset, and failure isolation (no
//       brain_metadata ⇒ neutral traits, never throws).
//   (C) Emotions pure derive: baseline calm, distinct excitement vs frustration
//       (arousal with/without reward), fear from low vitality, dominant pick,
//       eight keys.
//   (D) Skills pure compose: rates, growth trend vs a prior snapshot, summary.
//   (E) Self pure compose: the four questions, the neutral-self detector, and
//       the preamble being EMPTY for a fresh brain (so cold prompts are
//       unchanged) but present + bounded once developed.
//   (F) Live gatherers (gatherEmotions / gatherSkills / getSelfRepresentation)
//       never throw on the throwaway DB and degrade to sane defaults.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}
const approx = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;

const tmp = mkdtempSync(join(tmpdir(), "brain-mind-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const dna = await import("../src/core/cognitiveDna.js");
const emo = await import("../src/core/emotions.js");
const skills = await import("../src/core/skills.js");
const self = await import("../src/core/selfRepresentation.js");
const { BASELINE } = await import("../src/core/neuromodulators.js");
const { getEventBus } = await import("../src/core/eventBus.js");
const { openDb } = await import("../src/db/sqlite.js");
import type { BrainEvent } from "../src/core/eventBus.js";
import type { ProcedureRecord } from "../src/memory/procedural.js";
import type { SelfParts } from "../src/core/selfRepresentation.js";

const db = openDb();

// -----------------------------------------------------------------------------
// (A) DNA pure math.
// -----------------------------------------------------------------------------

const N = dna.NEUTRAL_TRAITS;
check("(A) neutral traits are all 0.5", dna.TRAIT_KEYS.every((k) => N[k] === 0.5));
check("(A) clampTraits bounds + NaN→0.5",
  (() => {
    const c = dna.clampTraits({ curiosity: 2, creativity: -1, logic: Number.NaN });
    return c.curiosity === 1 && c.creativity === 0 && c.logic === 0.5 && c.sociality === 0.5;
  })());

{
  // EMA: one step at 4% moves a neutral trait 4% of the way to 1.0 → 0.52.
  const once = dna.evolveTraits(N, { logic: 1 }, dna.EVOLUTION_RATE);
  check("(A) evolveTraits EMAs slowly toward the signal", approx(once.logic, 0.52, 1e-9), `logic=${once.logic}`);
  check("(A) evolveTraits leaves un-signalled traits untouched", once.curiosity === 0.5);
  // Many consistent steps converge upward but never overshoot 1.
  let t = { ...N };
  for (let i = 0; i < 200; i += 1) t = dna.evolveTraits(t, { curiosity: 1 }, dna.EVOLUTION_RATE);
  check("(A) repeated evolution converges toward the signal, bounded", t.curiosity > 0.95 && t.curiosity <= 1);
}

{
  const grounded = dna.signalsFromCycle({ confidence: 0.9, citedCount: 3, openQuestionCount: 2 });
  check("(A) grounded cycle → memory-driven + curious", grounded.memoryFocus === 0.8 && grounded.curiosity === 0.75);
  const ungrounded = dna.signalsFromCycle({ confidence: 0.8, citedCount: 0, openQuestionCount: 0 });
  check("(A) confident ungrounded cycle feeds creativity", ungrounded.creativity === 0.8 && ungrounded.memoryFocus === 0.2);
}

{
  const noRisk = dna.signalsFromConsolidation({ actionCount: 1, actionSuccessRate: 1, recentMessages: 0 });
  check("(A) one action does not move riskTolerance", noRisk.riskTolerance === undefined);
  const risk = dna.signalsFromConsolidation({ actionCount: dna.MIN_ACTIONS_FOR_RISK, actionSuccessRate: 0.8, recentMessages: 15 });
  check("(A) enough actions move riskTolerance toward the success rate", risk.riskTolerance === 0.8);
  check("(A) sociality saturates with conversation volume",
    approx(risk.sociality ?? -1, 15 / dna.SOCIAL_SATURATION_MESSAGES));
}

// Consumer biases — STRICT no-op at neutral, correct direction off it.
check("(A) curiosityGain is 0 at neutral", dna.curiosityGain(N) === 0);
check("(A) curiosityGain positive when curious", dna.curiosityGain({ ...N, curiosity: 1 }) > 0);
check("(A) wantsBroaderRetrieval false at neutral", dna.wantsBroaderRetrieval(N) === false);
check("(A) wantsBroaderRetrieval true when memory-focused", dna.wantsBroaderRetrieval({ ...N, memoryFocus: 0.7 }) === true);
check("(A) responseTemperature is exactly 0.3 at neutral", dna.responseTemperature(N) === 0.3);
check("(A) responseTemperature rises with creativity", dna.responseTemperature({ ...N, creativity: 1 }) > 0.3);
check("(A) responseTemperature stays bounded ≤0.7", dna.responseTemperature({ ...N, creativity: 1 }) <= 0.7);
check("(A) explorationEpsilonScale is exactly 1.0 at neutral", dna.explorationEpsilonScale(N) === 1);
check("(A) explorationEpsilonScale >1 when bold, <1 when cautious",
  dna.explorationEpsilonScale({ ...N, riskTolerance: 1 }) > 1 && dna.explorationEpsilonScale({ ...N, riskTolerance: 0 }) < 1);
check("(A) describeTraits is descriptive off-neutral, generic at neutral",
  dna.describeTraits(N) === "still forming a character" && dna.describeTraits({ ...N, curiosity: 0.9 }).includes("curious"));

// -----------------------------------------------------------------------------
// (B) DNA singleton — persistence, emit, reset, failure isolation.
// -----------------------------------------------------------------------------

{
  const clockMs = 1_000_000;
  const engine = dna.__createCognitiveDnaForTests(() => clockMs);
  check("(B) fresh singleton reads neutral traits", dna.TRAIT_KEYS.every((k) => engine.traits()[k] === 0.5));

  const events: BrainEvent[] = [];
  const off = getEventBus().onAny((e) => events.push(e));
  // A full-rate jump from 0.5 → 1.0 crosses several 0.1 notches → one event.
  engine.evolve({ curiosity: 1 }, 1);
  off();
  check("(B) evolve persists the new trait", engine.traits().curiosity === 1, `curiosity=${engine.traits().curiosity}`);
  check("(B) a notch crossing emits exactly one cognition monologue",
    events.filter((e) => e.kind === "cognition" && e.event.kind === "monologue" && e.event.reason === "cognitive-dna").length === 1);
  check("(B) evolutionCount increments", engine.status().evolutionCount === 1);

  engine.reset();
  check("(B) reset restores a neutral character", engine.traits().curiosity === 0.5 && engine.status().evolutionCount === 0);
}

{
  // Failure isolation: drop brain_metadata; reads degrade to neutral, no throw.
  db.exec("DROP TABLE IF EXISTS brain_metadata");
  let threw = false;
  let neutral = false;
  try {
    const engine = dna.__createCognitiveDnaForTests();
    neutral = engine.traits().curiosity === 0.5;
    engine.evolve({ curiosity: 1 }); // write also degrades silently
  } catch {
    threw = true;
  }
  check("(B) DNA degrades to neutral + never throws without brain_metadata", !threw && neutral);
  // Restore the table for the remaining sections.
  db.exec(
    "CREATE TABLE IF NOT EXISTS brain_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
  );
}

// -----------------------------------------------------------------------------
// (C) Emotions — pure derive.
// -----------------------------------------------------------------------------

{
  const baseline = emo.deriveEmotions({ modulators: BASELINE, traits: N, health: 1, activeGoals: 0 });
  check("(C) baseline confidence is mid (0.5)", approx(baseline.confidence, 0.5));
  check("(C) baseline fear is 0 when healthy + calm", baseline.fear === 0);
  check("(C) EMOTION_KEYS has eight entries", emo.EMOTION_KEYS.length === 8);

  const aroused = { dopamine: 0.9, norepinephrine: 0.9, acetylcholine: 0.2 };
  const thwarted = { dopamine: 0.1, norepinephrine: 0.9, acetylcholine: 0.2 };
  const eExcited = emo.deriveEmotions({ modulators: aroused, traits: N, health: 1, activeGoals: 2 });
  const eFrustrated = emo.deriveEmotions({ modulators: thwarted, traits: N, health: 1, activeGoals: 0 });
  check("(C) arousal WITH reward → excitement high, frustration low",
    eExcited.excitement > 0.7 && eExcited.frustration < 0.2);
  check("(C) arousal WITHOUT reward → frustration high, excitement low",
    eFrustrated.frustration > 0.7 && eFrustrated.excitement < 0.3);

  const sick = emo.deriveEmotions({ modulators: BASELINE, traits: N, health: 0.1, activeGoals: 0 });
  check("(C) low vitality drives fear up", sick.fear > 0.5);

  const dom = emo.dominantEmotion(eExcited);
  check("(C) dominantEmotion returns the strongest", emo.EMOTION_KEYS.includes(dom.name) && dom.value >= 0);
  check("(C) baselineEmotions matches a baseline derive",
    approx(emo.baselineEmotions().confidence, baseline.confidence));
}

// -----------------------------------------------------------------------------
// (D) Skills — pure compose.
// -----------------------------------------------------------------------------

{
  const proc = (over: Partial<ProcedureRecord>): ProcedureRecord => ({
    id: "p1",
    title: "run tests then commit",
    triggerClass: "test",
    steps: ["run-tests", "git-commit"],
    source: "action-sequence",
    successCount: 8,
    failureCount: 2,
    score: 0.8,
    lastUsedAt: "2026-06-01T00:00:00.000Z",
    createdAt: "2026-05-01T00:00:00.000Z",
    ...over,
  });

  const noPrior = skills.composeSkills([proc({})], {});
  check("(D) rates + mastery from a procedure",
    noPrior[0].mastery === 0.8 && noPrior[0].usageFrequency === 10 && approx(noPrior[0].successRate, 0.8) && approx(noPrior[0].failureRate, 0.2));
  check("(D) no prior snapshot ⇒ steady trend", noPrior[0].growthTrend === 0 && noPrior[0].growthDirection === "steady");

  const rising = skills.composeSkills([proc({ score: 0.8 })], { p1: 0.5 });
  const falling = skills.composeSkills([proc({ score: 0.5 })], { p1: 0.8 });
  check("(D) growth trend vs prior snapshot rises / falls",
    rising[0].growthDirection === "rising" && falling[0].growthDirection === "falling");

  const summary = skills.skillSummary([
    proc({ id: "a", title: "alpha", score: 0.9 }),
    proc({ id: "b", title: "beta", score: 0.2 }),
  ].flatMap((p) => skills.composeSkills([p], {})));
  check("(D) skillSummary picks strongest + weakest", summary.strongest === "alpha" && summary.weakest === "beta");
  check("(D) empty skills ⇒ null summary", skills.skillSummary([]).strongest === null);
}

// -----------------------------------------------------------------------------
// (E) Self — pure compose + the neutral-self / preamble discipline.
// -----------------------------------------------------------------------------

{
  const neutral = self.neutralParts();
  check("(E) a fresh self is neutral", self.isNeutralSelf(neutral) === true);
  const cold = self.composeSelf(neutral, "2026-06-15T00:00:00.000Z");
  check("(E) cold preamble is EMPTY (cold prompts unchanged)", self.selfPreamble(cold, neutral) === "");

  const developed: SelfParts = {
    name: "STAR",
    traits: { ...N, curiosity: 0.9, logic: 0.8 },
    character: "curious, rigorous",
    emotion: { name: "curious", value: 0.8 },
    stage: { stage: 4, name: "Reflection + Goals" },
    goals: ["Understand the retrieval pipeline", "Improve calibration"],
    beliefs: ["grounding answers in memory improves trust"],
    values: ["truth", "clarity"],
    strongestSkill: "run tests",
    weakestSkill: "deploy",
    weakDomains: ["rust"],
    fallingSkills: ["deploy"],
  };
  const grown = self.composeSelf(developed, "2026-06-15T00:00:00.000Z");
  check("(E) identity names the character + stage", grown.identity.includes("curious, rigorous") && grown.identity.includes("stage 4"));
  check("(E) doing reflects active goals", grown.doing.includes("Understand the retrieval pipeline"));
  check("(E) why reflects values + belief + emotion",
    grown.why.includes("truth") && grown.why.includes("grounding") && grown.why.includes("curious"));
  check("(E) becoming reflects weak domains + next stage", grown.becoming.includes("rust") && grown.becoming.includes("stage 5"));
  check("(E) a developed self is NOT neutral", self.isNeutralSelf(developed) === false);
  const pre = self.selfPreamble(grown, developed);
  check("(E) developed preamble is present + bounded", pre.length > 0 && pre.length <= self.SELF_PREAMBLE_MAX_LEN);
}

// -----------------------------------------------------------------------------
// (F) Live gatherers never throw on the throwaway DB.
// -----------------------------------------------------------------------------

{
  const LABEL = "(F) live gatherers degrade gracefully + never throw";
  try {
    const e = emo.gatherEmotions();
    const sk = skills.gatherSkills(10);
    const rep = self.getSelfRepresentation("2026-06-15T00:00:00.000Z");
    const ok =
      emo.EMOTION_KEYS.every((k) => typeof e[k] === "number") && Array.isArray(sk) && rep.self.stage.stage >= 1;
    check(LABEL, ok, `stage=${rep.self.stage.stage} skills=${sk.length}`);
  } catch (err) {
    check(LABEL, false, err instanceof Error ? err.message : String(err));
  }
}

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
