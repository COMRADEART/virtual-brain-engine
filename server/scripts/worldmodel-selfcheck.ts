// Causal world model selfcheck — blueprint §3 #7.
//
// Gates the explicit cause→effect ledger:
//   (A) Schema + migration 0004 — fresh DB has the table; legacy DB without
//       it gets backfilled cleanly; the migration is idempotent.
//   (B) recordObservation — strength/confidence math, accumulation across
//       multiple observations, polarity of "occurred=false".
//   (C) predictEffects — ordering, expectedFailureRate semantics, empty case.
//   (D) extractEffectsFromReflection — five effect classes always emitted,
//       independent occurrence flags.
//   (E) Imagination loop integration — after enough failure observations,
//       imagine() blends the empirical prior into base risk and surfaces a
//       "causal-map" influence in the influence chain.
//
// Hermetic: BRAIN_DB_PATH points at a temp DB before any module imports.
// No worker, no network.
//
// Run: npm --prefix server run worldmodel:selfcheck

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";

const tmp = mkdtempSync(join(tmpdir(), "brain-worldcheck-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const { openDb, applyMigrations } = await import("../src/db/sqlite.js");
const {
  recordObservation,
  predictEffects,
  getEffectsForCause,
  getCausesForEffect,
  extractEffectsFromReflection,
  EFFECT_CLASSES,
  MIN_USABLE_CONFIDENCE,
} = await import("../src/core/causalMap.js");

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures += 1;
}

function near(actual: number, expected: number, eps = 0.01): boolean {
  return Math.abs(actual - expected) < eps;
}

// =============================================================================
// (A) schema + migration 0004
// =============================================================================

const db = openDb();

{
  // (A.1) Fresh DB: schema.sql alone gives the table + indices.
  const tableRow = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='causal_links'")
    .get() as { name: string } | undefined;
  check("causal_links table exists on fresh DB", !!tableRow);

  const cols = (db.prepare("PRAGMA table_info(causal_links)").all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  for (const required of [
    "id",
    "cause_class",
    "effect_class",
    "observations",
    "occurrences",
    "strength",
    "confidence",
    "last_observed_at",
    "source",
  ]) {
    check(`causal_links has column ${required}`, cols.includes(required));
  }

  const idxCause = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_causal_links_cause'")
    .get();
  const idxEffect = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_causal_links_effect'")
    .get();
  check("idx_causal_links_cause exists", !!idxCause);
  check("idx_causal_links_effect exists", !!idxEffect);

  // (A.2) Migration 0004 recorded.
  const mig = db
    .prepare("SELECT name FROM schema_migrations WHERE name = ?")
    .get("0004-causal-links");
  // Note: on a fresh DB the table already exists from schema.sql so the
  // migration body is a no-op — but it still gets recorded by runMigrations.
  check("0004 migration recorded on fresh DB", !!mig);
}

{
  // (A.3) Legacy DB: build a DB that predates causal_links and run migrations.
  const legacy = new BetterSqlite3(join(tmp, "legacy.sqlite"));
  legacy.exec(`
    CREATE TABLE memory_points (
      id TEXT PRIMARY KEY, source_type TEXT NOT NULL, content TEXT NOT NULL,
      content_hash TEXT NOT NULL, importance REAL NOT NULL DEFAULT 0.5,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE cognitive_abstractions (
      id TEXT PRIMARY KEY, concept TEXT NOT NULL UNIQUE, evidence TEXT NOT NULL,
      confidence REAL NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, applied_at TEXT NOT NULL);
  `);

  applyMigrations(legacy);

  const legacyTable = legacy
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='causal_links'")
    .get();
  check("0004 migration creates causal_links on legacy DB", !!legacyTable);

  const legacyMig = legacy
    .prepare("SELECT name FROM schema_migrations WHERE name = ?")
    .get("0004-causal-links");
  check("0004 migration recorded on legacy DB", !!legacyMig);

  // (A.4) Idempotent: re-running migrations does not duplicate the table.
  applyMigrations(legacy);
  const tableCount = (
    legacy
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='causal_links'")
      .get() as { n: number }
  ).n;
  check("re-applying migrations is idempotent (one causal_links table)", tableCount === 1);

  legacy.close();
}

// =============================================================================
// (B) recordObservation math
// =============================================================================

{
  // (B.1) First observation, occurred=true.
  const link = recordObservation({
    causeClass: "upgrade",
    effectClass: "failure",
    occurred: true,
    source: "test",
  });
  check("first observation: observations=1", link.observations === 1, `obs=${link.observations}`);
  check("first observation: occurrences=1", link.occurrences === 1, `occ=${link.occurrences}`);
  // Laplace: (1+1)/(1+1+1) = 0.667
  check(
    "first observation: strength ≈ 0.667",
    near(link.strength, 0.667, 0.005),
    `strength=${link.strength}`,
  );
  // 1 - exp(-1/5) ≈ 0.181
  check(
    "first observation: confidence ≈ 0.181",
    near(link.confidence, 0.181, 0.005),
    `confidence=${link.confidence}`,
  );
  check("source recorded", link.source === "test");
}

{
  // (B.2) Multiple observations of the same pair accumulate.
  for (let i = 0; i < 9; i += 1) {
    recordObservation({ causeClass: "upgrade", effectClass: "failure", occurred: true });
  }
  const after10 = predictEffects("upgrade");
  const failureLink = after10.effects.find((e) => e.effectClass === "failure");
  check("after 10 obs: row accumulated", !!failureLink);
  check(
    "after 10 obs: observations=10",
    !!failureLink && failureLink.observations === 10,
    `obs=${failureLink?.observations}`,
  );
  // Laplace: (10+1)/(10+1+1) = 0.917
  check(
    "after 10 obs: strength ≈ 0.917",
    !!failureLink && near(failureLink.strength, 0.917, 0.005),
    `strength=${failureLink?.strength}`,
  );
  // 1 - exp(-10/5) ≈ 0.865
  check(
    "after 10 obs: confidence ≈ 0.865",
    !!failureLink && near(failureLink.confidence, 0.865, 0.005),
    `confidence=${failureLink?.confidence}`,
  );
}

{
  // (B.3) Non-occurring observation: observations increments, occurrences does not.
  const before = predictEffects("install");
  check("install has no prior data", before.effects.length === 0);
  const link1 = recordObservation({
    causeClass: "install",
    effectClass: "failure",
    occurred: false,
  });
  check(
    "non-occurrence: observations=1 occurrences=0",
    link1.observations === 1 && link1.occurrences === 0,
  );
  // Laplace: (0+1)/(1+1+1) = 0.333
  check(
    "non-occurrence: strength ≈ 0.333",
    near(link1.strength, 0.333, 0.005),
    `strength=${link1.strength}`,
  );
}

{
  // (B.4) Empty cause/effect throws.
  let threw = false;
  try {
    recordObservation({ causeClass: "", effectClass: "failure", occurred: true });
  } catch {
    threw = true;
  }
  check("empty cause throws", threw);

  threw = false;
  try {
    recordObservation({ causeClass: "test", effectClass: "  ", occurred: true });
  } catch {
    threw = true;
  }
  check("whitespace-only effect throws", threw);
}

// =============================================================================
// (C) predictEffects + getCausesForEffect
// =============================================================================

{
  // (C.1) Never-observed cause: empty effects, null expectedFailureRate.
  const forecast = predictEffects("zzz-never-seen");
  check("never-seen cause: empty effects", forecast.effects.length === 0);
  check(
    "never-seen cause: expectedFailureRate is null",
    forecast.expectedFailureRate === null,
  );
  check("never-seen cause: failureConfidence=0", forecast.failureConfidence === 0);
}

{
  // (C.2) Mixed effects under one cause — ordered by strength*confidence desc.
  // Set up: "build" cause with a strong success signal (5 obs, mostly success)
  // and a weak deps-changed signal (1 obs, occurred).
  for (let i = 0; i < 5; i += 1) {
    recordObservation({ causeClass: "build", effectClass: "success", occurred: i < 4 });
  }
  recordObservation({ causeClass: "build", effectClass: "deps-changed", occurred: true });

  const effects = getEffectsForCause("build");
  check("build cause: two effect rows", effects.length === 2);
  // success: obs=5, occ=4 → strength = 5/7 ≈ 0.714; conf = 1-exp(-1) ≈ 0.632 → score ≈ 0.451
  // deps-changed: obs=1, occ=1 → strength = 2/3 ≈ 0.667; conf ≈ 0.181 → score ≈ 0.121
  // So success ranks first.
  check(
    "build cause: success ranks ahead of deps-changed (more evidence)",
    effects[0]?.effectClass === "success" && effects[1]?.effectClass === "deps-changed",
    `[${effects.map((e) => e.effectClass).join(", ")}]`,
  );
}

{
  // (C.3) getCausesForEffect — same data, reverse pivot.
  const causesForFailure = getCausesForEffect("failure");
  // We've recorded failure under "upgrade" (10×true) and "install" (1×false).
  check(
    "getCausesForEffect('failure') returns both causes",
    causesForFailure.length === 2,
    `causes=[${causesForFailure.map((c) => c.causeClass).join(", ")}]`,
  );
  // upgrade has much higher strength * confidence so it ranks first.
  check(
    "getCausesForEffect: upgrade ranks ahead of install",
    causesForFailure[0]?.causeClass === "upgrade",
    `top=${causesForFailure[0]?.causeClass}`,
  );
}

{
  // (C.4) predictEffects exposes the failure link directly.
  const forecast = predictEffects("upgrade");
  check(
    "predictEffects('upgrade'): expectedFailureRate ≈ 0.917",
    forecast.expectedFailureRate !== null && near(forecast.expectedFailureRate, 0.917, 0.005),
    `rate=${forecast.expectedFailureRate}`,
  );
  check(
    "predictEffects('upgrade'): failureConfidence ≈ 0.865",
    near(forecast.failureConfidence, 0.865, 0.005),
    `conf=${forecast.failureConfidence}`,
  );
}

// =============================================================================
// (D) extractEffectsFromReflection
// =============================================================================

{
  // (D.1) Always emits one entry per EFFECT_CLASS — independence of effects
  // is the whole point.
  const a = extractEffectsFromReflection({
    ok: true,
    actualRisk: 0.1,
    accuracy: 0.9,
    dependencyChanges: 0,
  });
  check(
    "extract: success scenario emits all 5 classes",
    a.length === EFFECT_CLASSES.length,
    `len=${a.length}`,
  );
  const aMap = new Map(a.map((e) => [e.effectClass, e.occurred]));
  check("extract: success scenario — success=true", aMap.get("success") === true);
  check("extract: success scenario — failure=false", aMap.get("failure") === false);
  check("extract: success scenario — high-risk=false", aMap.get("high-risk") === false);
  check("extract: success scenario — deps-changed=false", aMap.get("deps-changed") === false);
  check(
    "extract: success scenario — prediction-divergent=false",
    aMap.get("prediction-divergent") === false,
  );
}

{
  // (D.2) Risky failed reflection — multiple effects fire.
  const b = extractEffectsFromReflection({
    ok: false,
    actualRisk: 0.74,
    accuracy: 0.2,
    dependencyChanges: 3,
  });
  const bMap = new Map(b.map((e) => [e.effectClass, e.occurred]));
  check("extract: failure scenario — success=false", bMap.get("success") === false);
  check("extract: failure scenario — failure=true", bMap.get("failure") === true);
  check("extract: failure scenario — high-risk=true", bMap.get("high-risk") === true);
  check("extract: failure scenario — deps-changed=true", bMap.get("deps-changed") === true);
  check(
    "extract: failure scenario — prediction-divergent=true",
    bMap.get("prediction-divergent") === true,
  );
}

// =============================================================================
// (E) Imagination loop integration
// =============================================================================

{
  // (E.1) We've already loaded 10 failure observations for "upgrade" plus
  // some other classes. Pull in the imagination engine and confirm imagine()
  // blends the empirical failure rate into its risk and surfaces the
  // influence in the chain.
  //
  // Dynamic import AFTER causalMap has been seeded — same DB singleton.
  const { createImaginationEngine } = await import("../src/core/imagination.js");
  const { getEventBus } = await import("../src/core/eventBus.js");
  const engine = createImaginationEngine(getEventBus());

  // (E.1a) Baseline "test" action has no causal observations — fall through.
  const baseSession = engine.imagine({ goal: "run the unit suite", action: "run cargo test" });
  const baseInfluences = baseSession.futures[0]?.influenceChain ?? [];
  const baseCausal = baseInfluences.find((inf) => inf.source === "causal-map");
  check(
    "imagine: no prior data → no causal-map influence",
    !baseCausal,
    baseCausal ? `unexpected ${baseCausal.label}` : "",
  );

  // (E.1b) "upgrade" action has 10 failure observations — should fire.
  const upgradeSession = engine.imagine({
    goal: "upgrade tauri",
    action: "upgrade tauri to v2.6",
  });
  const upgradeInfluences = upgradeSession.futures[0]?.influenceChain ?? [];
  const upgradeCausal = upgradeInfluences.find((inf) => inf.source === "causal-map");
  check(
    "imagine: 10 failure obs → causal-map influence present",
    !!upgradeCausal,
    upgradeCausal ? `label=${upgradeCausal.label}` : "missing",
  );
  check(
    "imagine: causal-map influence weight ≥ MIN_USABLE_CONFIDENCE",
    !!upgradeCausal && upgradeCausal.weight >= MIN_USABLE_CONFIDENCE,
    `weight=${upgradeCausal?.weight} min=${MIN_USABLE_CONFIDENCE}`,
  );

  // (E.1c) Average risk of upgrade futures must exceed the baseRisk for upgrade
  // (0.55 per twin/simulationEngine PROFILES). With 10/10 failures the empirical
  // term is ≈ 0.917 and the blend weight is capped at 0.5, so effective base
  // risk ≈ 0.55*0.5 + 0.917*0.5 ≈ 0.73 — the futures' average risk should be
  // visibly elevated above an "upgrade" path with no prior failures. We compare
  // against a clean upgrade run by deleting the failure row first… simpler:
  // assert the influence's blended-risk detail strictly exceeds the baseline.
  const detail = upgradeCausal?.detail ?? "";
  // Detail format: "...blended risk X% → Y%."  Y must be > X.
  const match = detail.match(/blended risk (\d+)% → (\d+)%/);
  check("imagine: influence detail has 'blended risk' phrasing", !!match, detail);
  if (match) {
    const before = Number(match[1]);
    const after = Number(match[2]);
    check(
      "imagine: blended risk > heuristic risk (failure history elevates risk)",
      after > before,
      `${before}% → ${after}%`,
    );
  }
}

{
  // (E.2) reflect() records observations — verify the full closed loop.
  // Pre-state: count observations for the "install" cause's failure link.
  const before = predictEffects("install");
  const beforeFail = before.effects.find((e) => e.effectClass === "failure");
  const beforeObs = beforeFail?.observations ?? 0;

  const { createImaginationEngine } = await import("../src/core/imagination.js");
  const { getEventBus } = await import("../src/core/eventBus.js");
  const engine = createImaginationEngine(getEventBus());

  const session = engine.imagine({
    goal: "install foo",
    action: "install foo package",
  });
  const future = session.futures[0]!;
  engine.reflect({
    sessionId: session.id,
    futureId: future.id,
    actualSummary: "package install failed: registry timeout",
    ok: false,
    actualRisk: 0.8,
    sideEffects: { dependencyChanges: 2 },
  });

  const after = predictEffects("install");
  const afterFail = after.effects.find((e) => e.effectClass === "failure");
  check(
    "reflect: failure observation accumulated for install",
    !!afterFail && afterFail.observations === beforeObs + 1 && afterFail.occurrences > (beforeFail?.occurrences ?? 0),
    `before=${beforeObs} after=${afterFail?.observations}`,
  );

  const afterDeps = after.effects.find((e) => e.effectClass === "deps-changed");
  check(
    "reflect: deps-changed observation also recorded",
    !!afterDeps && (afterDeps.observations ?? 0) >= 1,
    `obs=${afterDeps?.observations}`,
  );
}

// =============================================================================

console.log(failures === 0 ? "ALL CHECKS PASSED" : `FAIL: ${failures} failure(s)`);
const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
