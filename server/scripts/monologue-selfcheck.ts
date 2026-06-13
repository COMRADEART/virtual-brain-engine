// Hermetic selfcheck for server/src/core/monologue.ts
//
// Run: npx tsx server/scripts/monologue-selfcheck.ts
//   (or: npm --prefix server run monologue:selfcheck)
//
// Zero network, zero LLM, throwaway temp DB.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Must be set BEFORE any project import that opens SQLite.
const tmp = mkdtempSync(join(tmpdir(), "brain-monologue-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

// ── Tiny harness ─────────────────────────────────────────────────────────────

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

// ── Dynamic imports (after env is set) ───────────────────────────────────────

const {
  composeMonologue,
  emitMonologue,
  MONOLOGUE_MIN_GAP_MS,
  __resetMonologueGate,
} = await import("../src/core/monologue.js");

const { getEventBus } = await import("../src/core/eventBus.js");

// ── 1. composeMonologue — priority ordering ───────────────────────────────────

// 1a. contestedBelief beats activeGoal
{
  const line = composeMonologue({
    stage: 2,
    contestedBelief: "free will exists",
    activeGoal: "finish the project",
  });
  check(
    "priority: contestedBelief beats activeGoal",
    line !== null && line.includes("free will exists"),
    `line="${line}"`,
  );
}

// 1b. curiosity branch
{
  const line = composeMonologue({ stage: 0, curiosity: "why the sky is blue" });
  check(
    "priority: curiosity → 'I wonder …'",
    line !== null && line.startsWith("I wonder"),
    `line="${line}"`,
  );
}

// 1c. if curiosity already starts with "I wonder", don't double-prefix
{
  const line = composeMonologue({
    stage: 0,
    curiosity: "I wonder if consciousness is computable",
  });
  check(
    "curiosity already starts with 'I wonder' — not doubled",
    line !== null &&
      !line.toLowerCase().includes("i wonder i wonder") &&
      line.startsWith("I wonder"),
    `line="${line}"`,
  );
}

// 1d. only activeGoal
{
  const line = composeMonologue({ stage: 0, activeGoal: "learn Rust" });
  check(
    "priority: only activeGoal → 'I'm working toward …'",
    line !== null && line.startsWith("I'm working toward"),
    `line="${line}"`,
  );
}

// 1e. only stage ≥ 1
{
  const line = composeMonologue({ stage: 3 });
  check(
    "priority: only stage ≥ 1 → stage line",
    line !== null && line.includes("stage 3"),
    `line="${line}"`,
  );
}

// 1f. empty context (stage 0, nothing else) → null
{
  const line = composeMonologue({ stage: 0 });
  check("empty ctx (stage 0) → null", line === null, `line="${line}"`);
}

// 1g. narrativeIdentity without leading "I" gets prefixed
{
  const line = composeMonologue({ stage: 0, narrativeIdentity: "a curious mind" });
  check(
    "narrativeIdentity without 'I' → 'I am …'",
    line !== null && line.startsWith("I am"),
    `line="${line}"`,
  );
}

// 1h. narrativeIdentity already starting with "I" is returned as-is
{
  const line = composeMonologue({
    stage: 0,
    narrativeIdentity: "I exist to understand the universe",
  });
  check(
    "narrativeIdentity starting with 'I' returned as-is",
    line !== null && line.startsWith("I exist"),
    `line="${line}"`,
  );
}

// ── 2. All produced lines are first-person (start with "I") ───────────────────

const cases: Array<Parameters<typeof composeMonologue>[0]> = [
  { stage: 0, contestedBelief: "time is linear" },
  { stage: 0, curiosity: "what lies beyond the observable universe" },
  { stage: 0, activeGoal: "ship the feature" },
  { stage: 0, narrativeIdentity: "an evolving intelligence" },
  { stage: 4 },
  { stage: 0, narrativeIdentity: "I am the brain" },
];

for (const ctx of cases) {
  const line = composeMonologue(ctx);
  if (line !== null) {
    check(
      `first-person for ctx=${JSON.stringify(ctx)}`,
      line.startsWith("I"),
      `line="${line}"`,
    );
  }
}

// ── 3. emitMonologue rate-limiting ───────────────────────────────────────────

const goodCtx = { stage: 2, activeGoal: "pass the selfcheck" };

// First call at t=1_000_000 → should emit
__resetMonologueGate();
const r1 = emitMonologue(goodCtx, { now: 1_000_000 });
check("first emit → emitted:true", r1.emitted === true, `reason="${r1.reason}"`);

// Immediate follow-up at t+500ms → rate-limited
const r2 = emitMonologue(goodCtx, { now: 1_000_500 });
check("within-gap emit → emitted:false", r2.emitted === false, `reason="${r2.reason}"`);
check("within-gap reason is 'rate-limited'", r2.reason === "rate-limited");

// After the full gap → allowed again
const r3 = emitMonologue(goodCtx, { now: 1_000_000 + MONOLOGUE_MIN_GAP_MS + 1 });
check("post-gap emit → emitted:true", r3.emitted === true, `reason="${r3.reason}"`);

// ── 4. force bypasses the rate-limit ─────────────────────────────────────────

__resetMonologueGate();
emitMonologue(goodCtx, { now: 2_000_000 });
const rForce = emitMonologue(goodCtx, { now: 2_000_001, force: true });
check("force:true bypasses rate-limit → emitted:true", rForce.emitted === true);

// ── 5. nothing-to-say ctx → emitted:false, reason:"nothing to say" ──────────

__resetMonologueGate();
const rNothing = emitMonologue({ stage: 0 }, { now: 3_000_000 });
check("nothing-to-say → emitted:false", rNothing.emitted === false);
check("nothing-to-say reason", rNothing.reason === "nothing to say");

// ── 6. Bus event is actually received with a first-person label ───────────────

__resetMonologueGate();

let receivedEvent: { kind: string; label: string } | null = null;

const unsub = getEventBus().on("cognition", (busEvent) => {
  receivedEvent = { kind: busEvent.event.kind, label: busEvent.event.label };
});

const rBus = emitMonologue(
  { stage: 0, contestedBelief: "the map is not the territory" },
  { now: 4_000_000 },
);

unsub(); // clean up

check("bus emit → emitted:true", rBus.emitted === true);
check("bus event was received", receivedEvent !== null);
check(
  "bus event kind is 'monologue'",
  receivedEvent !== null && receivedEvent.kind === "monologue",
);
check(
  "bus event label is first-person",
  receivedEvent !== null && (receivedEvent as { label: string }).label.startsWith("I"),
  `label="${receivedEvent?.label}"`,
);

// ── 7. emitMonologue never throws (even if emitter is sabotaged) ─────────────

__resetMonologueGate();

// Temporarily break the bus by removing all listeners and confirming it still
// returns a structured result rather than throwing.
let threw = false;
try {
  const bus = getEventBus();
  const origEmit = bus.emit.bind(bus);
  // Replace emit with one that throws, then restore
  (bus as unknown as { emit: (e: unknown) => void }).emit = () => {
    throw new Error("sabotaged");
  };
  const rSab = emitMonologue({ stage: 1 }, { now: 5_000_000 });
  // Restore
  (bus as unknown as { emit: (e: unknown) => void }).emit = origEmit;
  // The bus catches throws internally; if the outer wrapper throws we catch below
  // Either way we shouldn't see an exception escape emitMonologue
  check(
    "sabotaged emitter returns structured result",
    typeof rSab === "object" && rSab !== null,
  );
} catch {
  threw = true;
}
check("emitMonologue never throws externally", threw === false);

// ── Result ────────────────────────────────────────────────────────────────────

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
