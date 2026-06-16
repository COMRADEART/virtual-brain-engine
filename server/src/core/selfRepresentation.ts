// Unified self-representation — the ONE place the brain's scattered sense of
// self is composed into a single answer to four questions:
//
//   Who am I?            → name + cognitive-DNA character + developmental stage
//   What am I doing?     → the active goals
//   Why am I doing it?   → values + the strongest belief + the current emotion
//   What should I become?→ weak domains + decaying skills + the next stage
//
// All of these already EXIST as separate subsystems (cognitiveDna, emotions,
// stages, goalManager/organism, beliefs, skills, selfModel competence,
// narrative). The gap the master vision names is that nothing UNIFIES them.
// This module is that unifier — a pure composer plus a thin, failure-isolated
// gatherer, mirroring narrative.ts.
//
// Behavioral coupling: selfPreamble() is a compact first-person creed that the
// pipeline injects (alongside the M1 narrative) into the reasoning + response
// prompts, so the answer stays consistent with who the brain has become — the
// channel through which the soft traits (logic, sociality) and the live emotion
// reach behavior. CRUCIALLY it returns "" for a fresh, neutral, goal-less brain
// (character "still forming", no goals), so a cold brain's prompts are byte-for-
// byte unchanged — the strict no-op-until-developed discipline.

import { surfaceError } from "../util/diagnostics.js";
import {
  getCognitiveDna,
  NEUTRAL_TRAITS,
  describeTraits,
  type CognitiveTraits,
} from "./cognitiveDna.js";
import { gatherEmotions, dominantEmotion } from "./emotions.js";
import { gatherSkills, skillSummary, type SkillRecord } from "./skills.js";
import { loadPersistedStage, STAGE_NAMES } from "./stages.js";
import { loadSelfModelState, WEAK_COMPETENCE_FLOOR, MIN_COMPETENCE_CYCLES } from "./selfModel.js";
import { getPersistentOrganism } from "./organism.js";
import { getBeliefEngine } from "./beliefs.js";
import { getNarrative } from "./narrative.js";

export interface SelfParts {
  name: string;
  traits: CognitiveTraits;
  character: string;
  emotion: { name: string; value: number };
  stage: { stage: number; name: string };
  goals: string[];
  beliefs: string[];
  values: string[];
  strongestSkill: string | null;
  weakestSkill: string | null;
  weakDomains: string[];
  fallingSkills: string[];
}

export interface SelfRepresentation {
  name: string;
  /** Who am I. */
  identity: string;
  /** What am I doing. */
  doing: string;
  /** Why am I doing it. */
  why: string;
  /** What should I become. */
  becoming: string;
  traits: CognitiveTraits;
  character: string;
  emotion: { name: string; value: number };
  stage: { stage: number; name: string };
  goals: string[];
  beliefs: string[];
  strongestSkill: string | null;
  weakestSkill: string | null;
  weakDomains: string[];
  updatedAt: string;
}

export const SELF_PREAMBLE_MAX_LEN = 220;
export const DEFAULT_SELF_NAME = "STAR";
const TOP_STAGE = 9;

export function neutralParts(name = DEFAULT_SELF_NAME): SelfParts {
  return {
    name,
    traits: { ...NEUTRAL_TRAITS },
    character: describeTraits(NEUTRAL_TRAITS),
    emotion: { name: "calm", value: 0 },
    stage: { stage: 1, name: "Memory" },
    goals: [],
    beliefs: [],
    values: [],
    strongestSkill: null,
    weakestSkill: null,
    weakDomains: [],
    fallingSkills: [],
  };
}

// -----------------------------------------------------------------------------
// PURE composition — the selfcheck drives these directly (no DB).
// -----------------------------------------------------------------------------

/** Compose the four-question self-representation from already-extracted parts. Pure. */
export function composeSelf(parts: SelfParts, now: string): SelfRepresentation {
  const identity = `I am ${parts.name}, a ${parts.character} mind at developmental stage ${parts.stage.stage} (${parts.stage.name}).`;

  const doing =
    parts.goals.length > 0
      ? `I am pursuing: ${parts.goals.slice(0, 3).join("; ")}.`
      : `I have no active goal right now; I am observing and consolidating what I know.`;

  const whyBits: string[] = [];
  if (parts.values.length > 0) whyBits.push(`I value ${parts.values.slice(0, 3).join(", ")}.`);
  if (parts.beliefs.length > 0) whyBits.push(`I hold that ${parts.beliefs[0]}.`);
  if (parts.emotion.value >= 0.4) whyBits.push(`Right now I feel ${parts.emotion.name}.`);
  const why = whyBits.length > 0 ? whyBits.join(" ") : `I act to understand my world and be useful within it.`;

  const becomingBits: string[] = [];
  if (parts.weakDomains.length > 0) becomingBits.push(`I am still weak in ${parts.weakDomains.slice(0, 3).join(", ")}`);
  if (parts.fallingSkills.length > 0) becomingBits.push(`${parts.fallingSkills.slice(0, 2).join(", ")} need practice`);
  becomingBits.push(
    parts.stage.stage < TOP_STAGE ? `I am growing toward stage ${parts.stage.stage + 1}` : `I am refining mastery`,
  );
  const becoming = becomingBits.join("; ") + ".";

  return {
    name: parts.name,
    identity,
    doing,
    why,
    becoming,
    traits: parts.traits,
    character: parts.character,
    emotion: parts.emotion,
    stage: parts.stage,
    goals: parts.goals,
    beliefs: parts.beliefs,
    strongestSkill: parts.strongestSkill,
    weakestSkill: parts.weakestSkill,
    weakDomains: parts.weakDomains,
    updatedAt: now,
  };
}

/** Is this self still a blank slate? (Neutral character, no goals.) */
export function isNeutralSelf(parts: SelfParts): boolean {
  const traitsNeutral = (Object.keys(NEUTRAL_TRAITS) as Array<keyof CognitiveTraits>).every(
    (k) => Math.abs(parts.traits[k] - 0.5) < 1e-6,
  );
  return traitsNeutral && parts.goals.length === 0;
}

/**
 * Compact first-person creed for prompt grounding. Empty for a fresh, neutral,
 * goal-less brain (so a cold brain's prompts are unchanged); length-bounded
 * otherwise.
 *
 * Deliberately carries ONLY the brain's own derived voice — identity (DNA
 * character + stage), current goals, and the dominant emotion. It NEVER
 * includes `why` (which echoes belief statements): beliefs can be distilled
 * from ingested web/GitHub text, and this string is injected into the LLM
 * prompt, so keeping belief text out of it removes any path for ingested
 * content to reach the prompt through the self layer.
 */
export function selfPreamble(self: SelfRepresentation, parts: SelfParts, maxLen = SELF_PREAMBLE_MAX_LEN): string {
  if (isNeutralSelf(parts)) return "";
  const bits = [self.identity];
  if (parts.goals.length > 0) bits.push(self.doing);
  if (self.emotion.value >= 0.5) bits.push(`Right now I feel ${self.emotion.name}.`);
  const joined = bits.join(" ").trim();
  return joined.length <= maxLen ? joined : joined.slice(0, maxLen - 1) + "…";
}

// -----------------------------------------------------------------------------
// Gather from engines (best-effort; each source in its own try/catch). Never
// throws — degrades source-by-source to the neutral default.
// -----------------------------------------------------------------------------

export function getSelfRepresentation(now: string = new Date().toISOString()): {
  self: SelfRepresentation;
  parts: SelfParts;
} {
  const parts = neutralParts();

  try {
    const status = getCognitiveDna().status();
    parts.traits = status.traits;
    parts.character = status.character;
  } catch (err) {
    surfaceError("self.gather.dna", err);
  }

  try {
    parts.emotion = dominantEmotion(gatherEmotions());
  } catch (err) {
    surfaceError("self.gather.emotion", err);
  }

  try {
    const persisted = loadPersistedStage();
    parts.stage = { stage: persisted.stage, name: STAGE_NAMES[persisted.stage - 1] ?? "Memory" };
  } catch (err) {
    surfaceError("self.gather.stage", err);
  }

  try {
    parts.goals = getPersistentOrganism().getActiveGoalTitles(5);
  } catch (err) {
    surfaceError("self.gather.goals", err);
  }

  try {
    parts.beliefs = getBeliefEngine()
      .listBeliefs({ limit: 5 })
      .map((b) => b.statement);
  } catch (err) {
    surfaceError("self.gather.beliefs", err);
  }

  try {
    parts.values = getNarrative()?.values ?? [];
  } catch (err) {
    surfaceError("self.gather.narrative", err);
  }

  try {
    const skills: SkillRecord[] = gatherSkills(50);
    const summary = skillSummary(skills);
    parts.strongestSkill = summary.strongest;
    parts.weakestSkill = summary.weakest;
    parts.fallingSkills = skills
      .filter((s) => s.growthDirection === "falling")
      .slice(0, 3)
      .map((s) => s.name);
  } catch (err) {
    surfaceError("self.gather.skills", err);
  }

  try {
    const state = loadSelfModelState();
    parts.weakDomains = Object.entries(state.competence)
      .filter(([, c]) => c.cycles >= MIN_COMPETENCE_CYCLES && c.confidence < WEAK_COMPETENCE_FLOOR)
      .map(([domain]) => domain)
      .slice(0, 3);
  } catch (err) {
    surfaceError("self.gather.competence", err);
  }

  return { self: composeSelf(parts, now), parts };
}
