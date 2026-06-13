// Pure helpers for the CognitionStreamPanel — kept out of the component so
// the Vitest unit suite can exercise the list reducer and badge mapping
// without mounting React.

import type { CognitionEvent, CognitionKind } from "../../../shared/cognition";

export interface StreamEntry extends CognitionEvent {
  /** Client-side arrival key (events have no id on the wire). */
  seq: number;
}

export const STREAM_CAP = 60;

/**
 * Prepend a new event (newest first), cap the list, and drop an exact
 * duplicate of the current head (same kind+label+at — the bus can deliver a
 * synthesized and a direct frame for the same mental act back-to-back).
 */
export function pushCognitionEvent(
  list: ReadonlyArray<StreamEntry>,
  event: CognitionEvent,
  seq: number,
  cap = STREAM_CAP,
): StreamEntry[] {
  const head = list[0];
  if (head && head.kind === event.kind && head.label === event.label && head.at === event.at) {
    return [...list];
  }
  return [{ ...event, seq }, ...list].slice(0, Math.max(1, cap));
}

/** Short badge text per kind. */
export const KIND_BADGE: Record<CognitionKind, string> = {
  "belief-formed": "belief+",
  "belief-update": "belief~",
  "goal-formed": "goal+",
  "goal-progress": "goal%",
  "curiosity-spike": "curious",
  reflection: "reflect",
  dream: "dream",
  thought: "thought",
  monologue: "inner",
  "procedure-learned": "skill",
  "stage-advance": "stage",
};

/** CSS modifier per kind (cogstream-row k-<this>). */
export const KIND_CLASS: Record<CognitionKind, string> = {
  "belief-formed": "belief",
  "belief-update": "belief",
  "goal-formed": "goal",
  "goal-progress": "goal",
  "curiosity-spike": "curiosity",
  reflection: "reflect",
  dream: "dream",
  thought: "thought",
  monologue: "thought",
  "procedure-learned": "skill",
  "stage-advance": "stage",
};
