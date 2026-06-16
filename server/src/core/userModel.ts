// Theory of Mind — a persistent model of the PERSON the brain talks with.
//
// The master vision names "model people / the user" as a gap, and it is real:
// civilization/socialCognition.ts models PEER BRAINS, but nothing models the
// human interlocutor. This module is that layer — learned passively from every
// /api/ask turn, never from an explicit form:
//
//   interests   — recurring topics, EMA-weighted (each turn decays the old,
//                 bumps what was just asked). The person's working surface.
//   expertise   — interests sustained past a higher floor: the domains they
//                 keep returning to, which read as their own ground.
//   style       — preferred verbosity (prompt brevity) + formality (how
//                 technical their wording is), each a slow EMA.
//   goals       — short "I'm trying to / help me build …" phrases, deduped.
//
// Design discipline (the neuromodulators.ts / cognitiveDna.ts contract):
//   - The MATH is PURE + exported: extraction, the EMA update, and the preamble
//     take a model as input so the selfcheck drives them with NO DB.
//   - userPreamble() returns "" until the model has actually formed (below
//     MIN_TURNS, or no interest clears the floor) — so a cold brain's prompts
//     are byte-for-byte unchanged, exactly like selfPreamble(). The injection is
//     ALSO behind CONFIG.theoryOfMind (default OFF).
//   - The singleton persists ONE JSON row in brain_metadata (the adaptive-layer
//     pattern — no migration), and is failure-isolated: any DB fault degrades to
//     the empty model, which makes the preamble "".

import { openDb } from "../db/sqlite.js";
import { surfaceError } from "../util/diagnostics.js";
import { tokens } from "../attention/saliency.js";
import { getNeuromodulators, socialTrustScale } from "./neuromodulators.js";
import {
  EMPTY_USER_MODEL,
  type UserModel,
  type WeightedTag,
  type UserCommunicationStyle,
} from "../../../shared/userModel.js";

// Cold no-op floor: the preamble stays empty until this many turns have shaped
// the model. Below it the picture is too thin to ground an answer on.
export const MIN_TURNS = 4;
// A tag must reach this EMA weight to surface as an interest.
export const TAG_WEIGHT_FLOOR = 0.25;
// …and this (higher) weight to read as sustained expertise.
export const EXPERTISE_FLOOR = 0.55;
// EMA knobs.
export const INTEREST_DECAY = 0.92; // unseen tags relax toward 0 each turn
export const INTEREST_BUMP = 0.18; // seen tags move this far toward 1 (headroom)
export const STYLE_EMA = 0.1; // style traits move 10% toward each turn's signal
// Bounds.
export const MAX_INTERESTS = 24; // persisted cap (top-weighted kept)
export const MAX_TAGS_PER_TURN = 6; // candidate tags read from one prompt
export const MAX_GOALS = 3;
export const PREAMBLE_MAX_LEN = 220;
// Prompt length (in tokens) that reads as "fully detailed" for the verbosity EMA.
const VERBOSITY_SCALE = 40;

// Function/question words that are never a person's "interest". tokens() already
// drops <3-char and non-alphanum; this removes the common 3+ letter filler.
const STOPWORDS = new Set([
  "the", "and", "for", "you", "your", "are", "was", "were", "this", "that",
  "with", "what", "how", "why", "when", "where", "who", "whom", "can", "could",
  "would", "should", "does", "did", "done", "has", "have", "had", "will", "want",
  "wants", "need", "needs", "please", "help", "make", "makes", "show", "tell",
  "give", "get", "let", "about", "from", "into", "than", "then", "them", "they",
  "there", "here", "but", "not", "our", "out", "use", "uses", "using", "used",
  "like", "just", "some", "any", "all", "one", "two", "more", "most", "very",
  "much", "also", "such", "its", "his", "her", "she", "him", "their", "these",
  "those", "been", "being", "which", "while", "into", "over", "under", "again",
  "now", "new", "old", "good", "best", "way", "ways", "thing", "things", "able",
  "via", "per", "etc", "ask", "asked", "know", "knows", "think", "see", "look",
  "find", "want", "going", "got", "may", "might", "must", "shall", "yes", "yet",
  // Intent/imperative verbs — the goal text captures these; as interest tags
  // they're noise (the topic is the noun they act on).
  "learn", "learned", "learns", "build", "built", "create", "created", "creates",
  "fix", "fixes", "fixed", "add", "added", "write", "wrote", "written", "run",
  "ran", "made", "set", "put", "try", "trying", "tried", "explain",
]);

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// -----------------------------------------------------------------------------
// PURE extraction + update — the selfcheck drives these directly (no DB).
// -----------------------------------------------------------------------------

/** Candidate interest tags from one prompt: content tokens minus stopwords, deduped, capped. */
export function extractTags(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens(text)) {
    if (STOPWORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_TAGS_PER_TURN) break;
  }
  return out;
}

const GOAL_CUE =
  /\b(?:i(?:'m| am)? (?:trying to|working on|building|learning)|help me (?:to )?|i want to|i need to|let'?s (?:build|make|create))\b/i;

/** A short goal phrase if the prompt states an intent; else null. Pure. */
export function extractGoal(prompt: string): string | null {
  const m = GOAL_CUE.exec(prompt);
  if (!m) return null;
  // Take from the cue to the end of its clause (first sentence-ish boundary).
  const tail = prompt.slice(m.index).split(/[.!?\n]/)[0]?.trim() ?? "";
  if (tail.length < 8) return null;
  return tail.length <= 90 ? tail : tail.slice(0, 89) + "…";
}

/** Verbosity (prompt brevity) + formality (technical wording) signal for one prompt. Pure. */
export function styleSignals(prompt: string): UserCommunicationStyle {
  const tks = tokens(prompt);
  const verbosity = clamp01(tks.length / VERBOSITY_SCALE);
  // Technical signal: code-ish punctuation in the raw prompt + long/identifier-ish
  // tokens. Ratio in [0,1].
  const technicalPunct = /[(){}[\]/_<>=;]|::|->/.test(prompt) ? 1 : 0;
  const longish = tks.filter((t) => t.length >= 8 || /\d/.test(t)).length;
  const longRatio = tks.length > 0 ? longish / tks.length : 0;
  const formality = clamp01(0.5 * technicalPunct + 0.5 * Math.min(1, longRatio * 2));
  return { verbosity, formality };
}

export interface TurnObservation {
  prompt: string;
  answer: string;
  citedCount: number;
  confidence: number;
}

/**
 * Fold one conversation turn into the model. Pure: returns a NEW model; the
 * store stamps updatedAt. Decays every interest, bumps the prompt's tags, EMAs
 * the style, and records a stated goal. `expertise` is derived (not a second
 * store) as the sustained-weight subset.
 */
export function observeTurn(prev: UserModel, obs: TurnObservation, bumpScale = 1): UserModel {
  const tagWeights = new Map<string, number>();
  for (const t of prev.interests) tagWeights.set(t.tag, clamp01(t.weight) * INTEREST_DECAY);

  const fresh = extractTags(obs.prompt);
  // A well-cited, confident answer means the topic landed — let it bump a touch
  // harder (the person is on familiar ground), but stay bounded.
  const grounded = obs.citedCount > 0 && clamp01(obs.confidence) >= 0.5;
  // bumpScale is the oxytocin (social-trust) consumer: a high-bond state lets the
  // person's interests accrue faster. EXACTLY 1.0 at baseline → no-op; bounded.
  const scale = Number.isFinite(bumpScale) ? Math.min(2, Math.max(0.5, bumpScale)) : 1;
  const bump = (grounded ? INTEREST_BUMP * 1.25 : INTEREST_BUMP) * scale;
  for (const tag of fresh) {
    const w = tagWeights.get(tag) ?? 0;
    tagWeights.set(tag, clamp01(w + bump * (1 - w)));
  }

  const interests: WeightedTag[] = [...tagWeights.entries()]
    .map(([tag, weight]) => ({ tag, weight }))
    .filter((t) => t.weight >= 0.02) // prune fully-decayed dust
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_INTERESTS);

  const expertise = interests.filter((t) => t.weight >= EXPERTISE_FLOOR);

  const sig = styleSignals(obs.prompt);
  const communicationStyle: UserCommunicationStyle = {
    verbosity: clamp01(prev.communicationStyle.verbosity + STYLE_EMA * (sig.verbosity - prev.communicationStyle.verbosity)),
    formality: clamp01(prev.communicationStyle.formality + STYLE_EMA * (sig.formality - prev.communicationStyle.formality)),
  };

  let goals = prev.goals;
  const goal = extractGoal(obs.prompt);
  if (goal) {
    goals = [goal, ...prev.goals.filter((g) => g.toLowerCase() !== goal.toLowerCase())].slice(0, MAX_GOALS);
  }

  return {
    interests,
    expertise,
    communicationStyle,
    goals,
    turns: prev.turns + 1,
    updatedAt: prev.updatedAt,
  };
}

/** Interests at/above the surface floor, strongest first. Pure. */
export function surfaceInterests(model: UserModel, n = 4): string[] {
  return model.interests
    .filter((t) => t.weight >= TAG_WEIGHT_FLOOR)
    .slice(0, n)
    .map((t) => t.tag);
}

function verbosityWord(v: number): string {
  return v <= 0.38 ? "concise" : v >= 0.62 ? "thorough" : "balanced";
}
function formalityWord(f: number): string {
  return f >= 0.6 ? "technical" : f <= 0.38 ? "plain-language" : "clear";
}

/**
 * Compact third-person note for prompt grounding. Empty until the model has
 * actually formed (below MIN_TURNS, or no interest clears the floor) — so a cold
 * brain's prompts are unchanged. Carries ONLY the brain's observations of the
 * person; never any belief/ingested text. Length-bounded.
 */
export function userPreamble(model: UserModel, maxLen = PREAMBLE_MAX_LEN): string {
  const interests = surfaceInterests(model, 4);
  if (model.turns < MIN_TURNS || interests.length === 0) return "";

  const bits: string[] = [];
  bits.push(`The person you're assisting keeps coming back to ${interests.slice(0, 3).join(", ")}.`);
  const exp = model.expertise.slice(0, 2).map((t) => t.tag);
  if (exp.length > 0) bits.push(`They appear experienced with ${exp.join(", ")}.`);
  bits.push(
    `They prefer ${verbosityWord(model.communicationStyle.verbosity)}, ${formalityWord(model.communicationStyle.formality)} answers.`,
  );
  if (model.goals.length > 0) bits.push(`Right now they're working on: ${model.goals[0]}.`);

  const joined = bits.join(" ").trim();
  return joined.length <= maxLen ? joined : joined.slice(0, maxLen - 1) + "…";
}

// -----------------------------------------------------------------------------
// Persisted singleton (brain_metadata KV).
// -----------------------------------------------------------------------------

const META_KEY = "user-model-v1";

function sanitizeTags(v: unknown): WeightedTag[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is { tag: unknown; weight: unknown } => !!x && typeof x === "object")
    .map((x) => ({ tag: String((x as { tag: unknown }).tag ?? ""), weight: clamp01(Number((x as { weight: unknown }).weight)) }))
    .filter((t) => t.tag.length > 0);
}

class UserModelStore {
  constructor(private readonly clock: () => number = () => Date.now()) {}

  private readModel(): UserModel {
    try {
      const row = openDb()
        .prepare("SELECT value FROM brain_metadata WHERE key = ?")
        .get(META_KEY) as { value: string } | undefined;
      if (row) {
        const parsed = JSON.parse(row.value) as Partial<UserModel>;
        const interests = sanitizeTags(parsed.interests);
        const style = parsed.communicationStyle;
        return {
          interests,
          expertise: interests.filter((t) => t.weight >= EXPERTISE_FLOOR),
          communicationStyle: {
            verbosity: clamp01(style?.verbosity ?? 0.5),
            formality: clamp01(style?.formality ?? 0.5),
          },
          goals: Array.isArray(parsed.goals) ? parsed.goals.filter((g): g is string => typeof g === "string").slice(0, MAX_GOALS) : [],
          turns: typeof parsed.turns === "number" && parsed.turns >= 0 ? Math.floor(parsed.turns) : 0,
          updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
        };
      }
    } catch (err) {
      surfaceError("userModel.read", err);
    }
    return { ...EMPTY_USER_MODEL, communicationStyle: { ...EMPTY_USER_MODEL.communicationStyle }, interests: [], expertise: [], goals: [] };
  }

  private writeModel(model: UserModel): void {
    try {
      openDb()
        .prepare(
          "INSERT INTO brain_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(META_KEY, JSON.stringify(model));
    } catch (err) {
      surfaceError("userModel.write", err);
    }
  }

  /** Current model. Never throws — degrades to the empty model (preamble ""). */
  model(): UserModel {
    return this.readModel();
  }

  /** Fold one conversation turn in and persist. Failure-isolated. */
  observe(obs: TurnObservation): void {
    try {
      // Oxytocin (social trust) scales how fast the person's interests accrue —
      // 1.0 at baseline (no-op). Failure-isolated → neutral 1.
      let bumpScale = 1;
      try {
        bumpScale = socialTrustScale(getNeuromodulators().levels());
      } catch {
        /* keep bumpScale = 1 (neutral) */
      }
      const next = observeTurn(this.readModel(), obs, bumpScale);
      this.writeModel({ ...next, updatedAt: this.clock() });
    } catch (err) {
      surfaceError("userModel.observe", err);
    }
  }

  /** Status surface for the route: the model + the (possibly empty) preamble. */
  status(): { model: UserModel; preamble: string; surfaceInterests: string[] } {
    const model = this.readModel();
    return { model, preamble: userPreamble(model), surfaceInterests: surfaceInterests(model) };
  }
}

export type { UserModelStore };

let singleton: UserModelStore | null = null;

export function getUserModel(): UserModelStore {
  if (!singleton) singleton = new UserModelStore();
  return singleton;
}

/** Test-only: a fresh instance with an injectable clock (shares the DB). */
export function __createUserModelForTests(clock?: () => number): UserModelStore {
  return new UserModelStore(clock);
}

/** Test-only: drop the singleton. */
export function __resetUserModelForTests(): void {
  singleton = null;
}
