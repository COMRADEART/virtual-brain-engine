// Cognitive DNA — the brain's slow, persistent PERSONALITY.
//
// Three layers already shape behavior on different timescales:
//   - saliency.ts    — PER-MEMORY scores (instantaneous, per item)
//   - neuromodulators — BRAIN-WIDE transient state (minutes; dopamine/NE/ACh)
//   - Cognitive DNA   — BRAIN-WIDE *stable character* (a lifetime)  ← this file
//
// DNA is six traits in [0,1], each neutral at 0.5. Unlike a neuromodulator
// (which decays back to baseline in minutes), a trait is a slow EMA: it is
// nudged toward what experience keeps showing, with a TINY learning rate, so
// the organism has a recognisable character that nonetheless drifts over its
// whole life — a developing child, not a mood ring. One contradicting day
// barely moves it; a thousand consistent cycles reshape it.
//
//   curiosity     — how readily it explores the unknown vs. exploits the known
//   creativity    — how far it reasons beyond retrieved memory
//   logic         — how much it trusts grounded, high-confidence deduction
//   riskTolerance — how boldly it acts / explores under uncertainty
//   sociality     — how much it engages / speaks up proactively
//   memoryFocus   — how strongly it leans on its own memory vs. fresh input
//
// Design discipline (the attention/saliency.ts + neuromodulators.ts contract):
//   - The MATH is PURE + exported: clamp, evolve, signal-mapping, and every
//     consumer bias take traits as arguments so the selfcheck drives them with
//     NO DB. Same input → same output.
//   - Every consumer bias is a STRICT NO-OP at neutral (0.5) traits, exactly
//     like a baseline neuromodulator — DNA can never degrade a fresh brain.
//   - The singleton persists one JSON row in brain_metadata (the adaptive-layer
//     pattern — no migration), and is failure-isolated: any DB fault degrades
//     to NEUTRAL traits, which make every consumer a no-op.
//   - Traits NEVER touch the action trust boundary. riskTolerance biases only
//     exploration knobs (curiosity / bandit ε), never executeAction's gate.

import { openDb } from "../db/sqlite.js";
import { surfaceError } from "../util/diagnostics.js";
import { getEventBus, nowIso } from "./eventBus.js";
import { regionsFor } from "../../../shared/cognition.js";

export interface CognitiveTraits {
  curiosity: number;
  creativity: number;
  logic: number;
  riskTolerance: number;
  sociality: number;
  memoryFocus: number;
}

export interface CognitiveDnaState {
  traits: CognitiveTraits;
  /** ms epoch of the last write. */
  updatedAt: number;
  /** Total evolution steps applied, for the status surface. */
  evolutionCount: number;
}

export const TRAIT_KEYS: ReadonlyArray<keyof CognitiveTraits> = [
  "curiosity",
  "creativity",
  "logic",
  "riskTolerance",
  "sociality",
  "memoryFocus",
];

/** A fresh organism has a neutral character — every trait at 0.5. */
export const NEUTRAL_TRAITS: CognitiveTraits = {
  curiosity: 0.5,
  creativity: 0.5,
  logic: 0.5,
  riskTolerance: 0.5,
  sociality: 0.5,
  memoryFocus: 0.5,
};

// The EMA rate: a trait moves 4% of the way to a signal per evolution step.
// At this rate ~17 consistent steps shift a trait by 0.5 — slow enough to be a
// character, fast enough to be visibly developing over a session's worth of use.
export const EVOLUTION_RATE = 0.04;

// Consumer-bias spans (exported so the selfcheck pins them). Each is centred so
// a neutral trait contributes exactly 0.
export const CURIOSITY_GAIN_SPAN = 0.3; // curiosity → ±0.15 on the curiosity signal
export const RESPONSE_TEMP_SPAN = 0.5; // creativity → ±0.25 on the answer temperature
export const MEMORY_FOCUS_BROADEN_FLOOR = 0.65; // memoryFocus ≥ this → vote to broaden

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

// -----------------------------------------------------------------------------
// PURE math — the selfcheck drives these directly (no DB).
// -----------------------------------------------------------------------------

/** Clamp every trait into [0,1]; a non-finite trait collapses to neutral 0.5. */
export function clampTraits(t: Partial<CognitiveTraits> | undefined | null): CognitiveTraits {
  const src = t ?? {};
  return {
    curiosity: clamp01(src.curiosity ?? 0.5),
    creativity: clamp01(src.creativity ?? 0.5),
    logic: clamp01(src.logic ?? 0.5),
    riskTolerance: clamp01(src.riskTolerance ?? 0.5),
    sociality: clamp01(src.sociality ?? 0.5),
    memoryFocus: clamp01(src.memoryFocus ?? 0.5),
  };
}

/**
 * Nudge each trait that has a signal toward that signal by `rate` (EMA). A
 * trait with no signal is left exactly as-is. Signals are TARGET values in
 * [0,1], not deltas. Pure.
 */
export function evolveTraits(
  current: CognitiveTraits,
  signals: Partial<CognitiveTraits>,
  rate: number = EVOLUTION_RATE,
): CognitiveTraits {
  const r = clamp(rate, 0, 1);
  const next: CognitiveTraits = { ...current };
  for (const key of TRAIT_KEYS) {
    const target = signals[key];
    if (typeof target === "number" && Number.isFinite(target)) {
      next[key] = clamp01(current[key] + r * (clamp01(target) - current[key]));
    }
  }
  return next;
}

export interface CycleOutcome {
  /** Calibrated confidence of the reasoning cycle, [0,1]. */
  confidence: number;
  /** How many memories the answer actually cited. */
  citedCount: number;
  /** How many open questions the cycle surfaced. */
  openQuestionCount: number;
}

/**
 * Map ONE completed reasoning cycle onto TARGET trait values — only the traits
 * a single cycle genuinely informs (logic, creativity, curiosity, memoryFocus).
 * Pure. The caller EMAs these in via evolveTraits, so one cycle barely moves
 * the character. riskTolerance / sociality are NOT informed by a single cycle —
 * they evolve at consolidation time (signalsFromConsolidation).
 */
export function signalsFromCycle(o: CycleOutcome): Partial<CognitiveTraits> {
  const conf = clamp01(o.confidence);
  const cited = Math.max(0, Math.floor(o.citedCount));
  const grounded = cited > 0;
  const openQ = Math.max(0, Math.floor(o.openQuestionCount));
  return {
    // Used its own memory → leans on memory; ignored it → leans on fresh input.
    memoryFocus: grounded ? 0.8 : 0.2,
    // Grounded + confident deduction nurtures logic; ungrounded guessing erodes it.
    logic: grounded ? (conf + 1) / 2 : conf * 0.4,
    // Confident WITHOUT citing memory = it reasoned beyond what it had stored.
    creativity: !grounded && conf >= 0.5 ? 0.8 : 0.4,
    // Surfacing open questions is the signature of a curious mind.
    curiosity: openQ > 0 ? 0.75 : 0.45,
  };
}

export interface ConsolidationStats {
  /** Success rate of recent permissioned actions in [0,1], if any ran. */
  actionSuccessRate?: number;
  /** How many actions backed that rate (gate: don't move risk on 1 sample). */
  actionCount: number;
  /** Conversation messages observed since the last consolidation. */
  recentMessages: number;
}

export const MIN_ACTIONS_FOR_RISK = 5;
export const SOCIAL_SATURATION_MESSAGES = 30;

/**
 * Map a consolidation window (sleep) onto TARGET trait values for the slow
 * traits a cycle can't see: riskTolerance (did bold action pay off?) and
 * sociality (how much was it engaged with?). Pure.
 */
export function signalsFromConsolidation(s: ConsolidationStats): Partial<CognitiveTraits> {
  const out: Partial<CognitiveTraits> = {};
  if (s.actionCount >= MIN_ACTIONS_FOR_RISK && typeof s.actionSuccessRate === "number") {
    // Bold action that succeeds raises tolerance; failure makes it cautious.
    out.riskTolerance = clamp01(s.actionSuccessRate);
  }
  // Engagement saturates: a busy window pulls sociality up, a silent one down.
  out.sociality = clamp01(Math.max(0, s.recentMessages) / SOCIAL_SATURATION_MESSAGES);
  return out;
}

// -----------------------------------------------------------------------------
// PURE consumer biases — each a STRICT NO-OP at neutral (0.5).
//
// FOUR traits have a dedicated hard gate below: curiosity (explore signal),
// memoryFocus (retrieval broaden), creativity (answer temperature), and
// riskTolerance (bandit ε). The other two are EXPRESSIVE traits with no
// dedicated numeric gate — they are consumed softly but really: `logic` feeds
// the derived `confidence` emotion (emotions.ts) and the self-voice character;
// `sociality` feeds the self-voice character (describeTraits → selfPreamble),
// which reaches the answer when narrative grounding is on. So every trait is
// consumed; none is dead — two just act through voice rather than a gate.
// -----------------------------------------------------------------------------

/** curiosity → additive gain on the curiosity signal, [-span/2, +span/2]; 0 at neutral. */
export function curiosityGain(t: CognitiveTraits): number {
  return (clamp01(t.curiosity) - 0.5) * CURIOSITY_GAIN_SPAN;
}

/** memoryFocus → a high-water vote to broaden retrieval; false at neutral. */
export function wantsBroaderRetrieval(t: CognitiveTraits): boolean {
  return clamp01(t.memoryFocus) >= MEMORY_FOCUS_BROADEN_FLOOR;
}

/** creativity → the answer-generation temperature; equals `base` at neutral, bounded. */
export function responseTemperature(t: CognitiveTraits, base = 0.3): number {
  return clamp(base + (clamp01(t.creativity) - 0.5) * RESPONSE_TEMP_SPAN, 0.1, 0.7);
}

/** riskTolerance → multiplier on a bandit ε; exactly 1.0 at neutral. */
export function explorationEpsilonScale(t: CognitiveTraits): number {
  return 0.5 + clamp01(t.riskTolerance);
}

/** A one-line creed describing this character — feeds the self-narrative voice. */
export function describeTraits(t: CognitiveTraits): string {
  const pick = (v: number, hi: string, lo: string): string | null =>
    v >= 0.62 ? hi : v <= 0.38 ? lo : null;
  const phrases = [
    pick(t.curiosity, "curious", "incurious"),
    pick(t.creativity, "imaginative", "literal"),
    pick(t.logic, "rigorous", "intuitive"),
    pick(t.riskTolerance, "bold", "cautious"),
    pick(t.sociality, "engaging", "reserved"),
    pick(t.memoryFocus, "memory-driven", "present-focused"),
  ].filter((p): p is string => p !== null);
  return phrases.length ? phrases.join(", ") : "still forming a character";
}

// -----------------------------------------------------------------------------
// Persisted singleton (brain_metadata KV).
// -----------------------------------------------------------------------------

const META_KEY = "cognitive-dna-v1";
// Trait crosses a 0.1 band → emit one inner-monologue cognition event so the
// stream shows the personality genuinely drifting.
const NOTCH = 0.1;

class CognitiveDna {
  constructor(private readonly clock: () => number = () => Date.now()) {}

  private readState(): CognitiveDnaState {
    try {
      const row = openDb()
        .prepare("SELECT value FROM brain_metadata WHERE key = ?")
        .get(META_KEY) as { value: string } | undefined;
      if (row) {
        const parsed = JSON.parse(row.value) as Partial<CognitiveDnaState>;
        return {
          traits: clampTraits(parsed.traits),
          updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : this.clock(),
          evolutionCount: typeof parsed.evolutionCount === "number" ? parsed.evolutionCount : 0,
        };
      }
    } catch (err) {
      surfaceError("cognitiveDna.read", err);
    }
    return { traits: { ...NEUTRAL_TRAITS }, updatedAt: this.clock(), evolutionCount: 0 };
  }

  private writeState(state: CognitiveDnaState): void {
    try {
      openDb()
        .prepare(
          "INSERT INTO brain_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(META_KEY, JSON.stringify(state));
    } catch (err) {
      surfaceError("cognitiveDna.write", err);
    }
  }

  /** Current traits. Never throws — degrades to NEUTRAL (every consumer no-ops). */
  traits(): CognitiveTraits {
    return this.readState().traits;
  }

  status(): { traits: CognitiveTraits; neutral: CognitiveTraits; evolutionCount: number; character: string } {
    const state = this.readState();
    return {
      traits: state.traits,
      neutral: NEUTRAL_TRAITS,
      evolutionCount: state.evolutionCount,
      character: describeTraits(state.traits),
    };
  }

  /** EMA the traits toward `signals` and persist. Emits on a 0.1 notch crossing. */
  evolve(signals: Partial<CognitiveTraits>, rate: number = EVOLUTION_RATE): CognitiveTraits {
    const prev = this.readState();
    const next = evolveTraits(prev.traits, signals, rate);
    this.writeState({ traits: next, updatedAt: this.clock(), evolutionCount: prev.evolutionCount + 1 });
    this.maybeEmit(prev.traits, next);
    return next;
  }

  private maybeEmit(prev: CognitiveTraits, next: CognitiveTraits): void {
    try {
      for (const key of TRAIT_KEYS) {
        const before = Math.floor(prev[key] / NOTCH);
        const after = Math.floor(next[key] / NOTCH);
        if (after !== before) {
          const rising = next[key] > prev[key];
          getEventBus().emit({
            kind: "cognition",
            event: {
              kind: "monologue",
              label: `My ${key} is ${rising ? "growing" : "fading"} (${next[key].toFixed(2)})`,
              detail: describeTraits(next),
              magnitude: 0.3,
              logicalRegions: regionsFor("monologue"),
              reason: "cognitive-dna",
              at: nowIso(),
            },
            at: nowIso(),
          });
          break; // one event per evolution step is enough
        }
      }
    } catch (err) {
      surfaceError("cognitiveDna.emit", err);
    }
  }

  /** Reset to a neutral character (status-surface action). */
  reset(): void {
    this.writeState({ traits: { ...NEUTRAL_TRAITS }, updatedAt: this.clock(), evolutionCount: 0 });
  }
}

export type { CognitiveDna };

let singleton: CognitiveDna | null = null;

export function getCognitiveDna(): CognitiveDna {
  if (!singleton) singleton = new CognitiveDna();
  return singleton;
}

/** Test-only: a fresh instance with an injectable clock (shares the DB). */
export function __createCognitiveDnaForTests(clock?: () => number): CognitiveDna {
  return new CognitiveDna(clock);
}

/** Test-only: drop the singleton. */
export function __resetCognitiveDnaForTests(): void {
  singleton = null;
}
