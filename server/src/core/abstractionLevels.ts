// Phase 3 — explicit 6-level abstraction ladder for cognitive_abstractions.
//
// The blueprint gap (docs/VIRTUAL_BRAIN_ENGINE_BLUEPRINT.md §17 / §18.10): the
// existing imagination.dream() loop produces user-pattern abstractions like
// "User works on resilient Rust/runtime workflows" but stores them as a flat
// bag with no level — making it impossible for retrieval, evolution, or the
// emerging hierarchy ranker to distinguish a raw pattern from a normative
// principle. This module is the deterministic classifier that fills that gap.
//
// Design constraints:
//   - PURE. No DB, no bus, no model calls. Self-check imports this directly.
//   - DETERMINISTIC. Same input -> same level. Lets the selfcheck assert.
//   - LIBERAL on evidence, CONSERVATIVE on level. When in doubt, demote. The
//     migration default is 0 ("sensory") so a re-classified abstraction can
//     only move up, never silently down past a level the user has seen.
//
// The ladder (and what a typical concept at each level looks like):
//
//   0 sensory       — raw observation, single-modality. "saw 'rust' string in
//                     14 file headers"
//   1 pattern       — recurring feature across observations, no name yet.
//                     "filenames ending .rs co-occur with 'cargo'"
//   2 concept       — named entity or recognizable category. "Rust project",
//                     "Tauri build"
//   3 schema        — relationship between concepts. "User edits a Rust file
//                     after a failed Tauri build"
//   4 principle     — causal or normative rule. "User favors predictive safety
//                     before execution"
//   5 philosophical — meta-framework. "Self-modifying systems must remain
//                     auditable" — typically requires human authorship.
//
// Returns 0 if it can't justify any other bucket. That's a feature: a default
// of "sensory" is honest about uncertainty without dropping the abstraction.

import type { AbstractionLevel } from "../../../shared/imagination.js";

/** Tokens that, by themselves, push the concept up the ladder. */
const LEVEL_TOKENS: Array<{ level: AbstractionLevel; terms: RegExp[] }> = [
  // 5 — meta-framework. Hard to hit from inferConcepts; left for future
  // hand-curated abstractions or LLM-driven summarisation. Stems are written
  // with optional suffixes so "ethical"/"philosophy"/"ontological" all match.
  {
    level: 5,
    terms: [
      /\b(philosoph(?:y|ical|er)|epistemolog\w*|ontolog\w*|metaphysic\w*|ethic(?:s|al)?|meta-?framework|world ?view)\b/i,
      /\bsystem of systems\b/i,
    ],
  },
  // 4 — causal/normative rule. "favors", "values", "should", "must", "leads to".
  {
    level: 4,
    terms: [
      /\b(favors?|values?|prefers?|should|must|ought|prioritis(?:es|ed)|leads to|causes?|results? in)\b/i,
      /\b(principle|rule|law|norm)\b/i,
    ],
  },
  // 3 — schema (relationship between concepts).
  {
    level: 3,
    terms: [
      /\b(works on|develops?|builds?|maintains?|drives?|orchestrates?)\b/i,
      /\b(workflow|architecture|pipeline|graph|relation|coupling)\b/i,
      /\b(when .* then|after .* then|before .*\b(it|they)\b)\b/i,
    ],
  },
  // 2 — concept (named entity / category).
  {
    level: 2,
    terms: [
      /\b(project|module|crate|workspace|engine|server|client|database|cortex|brain)\b/i,
      /\b(rust|typescript|python|sqlite|tauri|ollama|whisper|vision)\b/i,
    ],
  },
  // 1 — pattern (a recurring something, but no name yet).
  {
    level: 1,
    terms: [
      /\b(recurring|repeated|frequent|often|tends to|pattern|co-?occur)\b/i,
    ],
  },
];

/** Concept-shape features pushed alongside the token signal. */
function inferStructureLevel(concept: string, evidenceCount: number): AbstractionLevel {
  const trimmed = concept.trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  // Single bare word with no qualifiers -> at best a concept (2). Anything
  // longer needs token signal to climb past schema (3).
  if (wordCount <= 2) return 2;
  if (wordCount <= 5) return 3;
  if (evidenceCount >= 4) return 3;
  return 2;
}

/**
 * Classify a concept into the 6-level ladder. The classifier is deliberately
 * shallow: it's not learned, it's a lookup that lets the dream() loop store a
 * level instead of always 0. The dream loop runs every ~3 minutes, so we want
 * this O(short-regex) per call.
 *
 * @param concept    the abstraction concept string
 * @param evidence   the supporting evidence list (used as a fan-out signal)
 * @returns          AbstractionLevel in [0, 5]
 */
export function classifyAbstractionLevel(
  concept: string,
  evidence: ReadonlyArray<string> = [],
): AbstractionLevel {
  if (!concept || concept.trim().length === 0) return 0;
  const haystack = [concept, ...evidence].join(" \n ");
  // Token signal: scan ladder top-down, first match wins.
  for (const rung of LEVEL_TOKENS) {
    for (const term of rung.terms) {
      if (term.test(haystack)) {
        return rung.level;
      }
    }
  }
  // No token hit: fall back to structural inference.
  return inferStructureLevel(concept, evidence.length);
}

/** Selfcheck helper — returns the ladder so tests can iterate. */
export function abstractionLevelLadder(): ReadonlyArray<AbstractionLevel> {
  return [0, 1, 2, 3, 4, 5];
}

// =============================================================================
// Phase 3 (improvement plan §18.7) — temporal cognition / future-self.
//
// Each abstraction is also anchored on a past/now/future axis so the projection
// engine (and the UI) can distinguish "this is what the user has been doing"
// from "this is who the user is right now" from "this is where their behaviour
// is heading." Like the level classifier, this is a deterministic regex lookup
// with a conservative default — when nothing matches, the role is "now".

export type TimelineRole = "past" | "now" | "future";

const TIMELINE_TOKENS: Array<{ role: TimelineRole; terms: RegExp[] }> = [
  {
    // Past — verb forms in the perfect / preterite, retrospective adverbs.
    role: "past",
    terms: [
      /\b(was|were|has been|had|previously|formerly|earlier|yesterday|last (?:week|month|year)|ago)\b/i,
      /\b(used to|once|originally|historically|legacy|deprecated)\b/i,
      /\b\w+ed\b/i, // generic preterite — broad but rare in pristine concept strings, mostly hits "shipped", "built", "fixed"
    ],
  },
  {
    // Future — modal will/going-to/should + planning vocabulary.
    role: "future",
    terms: [
      /\b(will|shall|going to|gonna|plans? to|intends? to|aims? to|expects? to|likely to|tend(?:s)? to)\b/i,
      /\b(soon|next (?:week|month|quarter|year)|upcoming|forecast(?:ed)?|projected|anticipated|predicted)\b/i,
      /\b(roadmap|backlog|todo|planned|scheduled|target(?:ed)?)\b/i,
    ],
  },
];

/**
 * Classify a concept's temporal role on the past/now/future axis.
 *
 * The classifier prefers "future" over "past" when both signals fire (forward
 * projection is the more actionable bucket for the projection engine). When
 * neither fires, the role is "now" — at-the-moment captures are the most
 * common shape coming out of dream() / imagination upserts.
 *
 * @param concept   the abstraction concept string
 * @param evidence  supporting evidence joined into the haystack
 * @returns         TimelineRole — past | now | future
 */
export function classifyTimelineRole(
  concept: string,
  evidence: ReadonlyArray<string> = [],
): TimelineRole {
  if (!concept || concept.trim().length === 0) return "now";
  const haystack = [concept, ...evidence].join(" \n ");
  // Future first — a "will fix the bug we shipped last week" is forward-leaning.
  for (const rung of TIMELINE_TOKENS) {
    for (const term of rung.terms) {
      if (term.test(haystack)) {
        return rung.role;
      }
    }
  }
  return "now";
}

/** Selfcheck helper — every timeline role, for iteration. */
export function timelineRoleSet(): ReadonlyArray<TimelineRole> {
  return ["past", "now", "future"];
}
