// Theory of Mind — the brain's model of the PERSON it is talking with.
//
// Pure type contract, zero runtime deps (like the rest of shared/). The logic
// lives in server/src/core/userModel.ts; this is just the shape both the engine
// and any UI import.
//
// This is a SINGLE-USER personal brain: /api/ask carries no user id, so the
// model is one persisted singleton — the brain's evolving picture of its single
// interlocutor (their recurring interests, the domains they keep engaging,
// their preferred answer style, and what they're currently working on), learned
// passively from conversation.

export interface WeightedTag {
  /** A normalized topic/term the person keeps raising. */
  tag: string;
  /** EMA salience in [0,1] — how strongly/recently it recurs. */
  weight: number;
}

export interface UserCommunicationStyle {
  /** Preferred answer length: terse (0) ↔ detailed (1). EMA of prompt brevity. */
  verbosity: number;
  /** Register: casual (0) ↔ technical/formal (1). EMA of how technical prompts read. */
  formality: number;
}

export interface UserModel {
  /** Recurring topics, freshest/strongest first. */
  interests: WeightedTag[];
  /** The subset of interests sustained long enough to read as the person's domain. */
  expertise: WeightedTag[];
  communicationStyle: UserCommunicationStyle;
  /** Recently-stated goals ("help me build X"), most recent first. */
  goals: string[];
  /** How many conversation turns have shaped this model. */
  turns: number;
  /** ms epoch of the last update (stamped by the store, not the pure update). */
  updatedAt: number;
}

/** A blank slate — neutral style, no learned interests. */
export const EMPTY_USER_MODEL: UserModel = {
  interests: [],
  expertise: [],
  communicationStyle: { verbosity: 0.5, formality: 0.5 },
  goals: [],
  turns: 0,
  updatedAt: 0,
};
