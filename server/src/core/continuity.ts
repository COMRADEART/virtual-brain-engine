// Memory continuity briefing — "since last time". A boot-time recap of what
// the brain remembers about you and what it was working on. PURE (data in,
// briefing text out); the caller (the route) supplies the data. The full
// version is shaped for the Mind panel; the "spoken" version is a single
// greeting+briefing string the pet reads aloud on first paint.
//
// Ponytail: the briefing prose is hand-rolled from the structured facts —
// LLM-gating is a follow-up (the "lived" version that calls a connector for
// warm prose). This version is fully hermetic, runs at zero token cost, and
// degrades honestly when there are no memories ("Welcome back. The brain
// has no record of prior activity yet.").

// ---------------------------------------------------------------------------
// Input shape (caller-supplied; this module is PURE).
// ---------------------------------------------------------------------------

export interface ContinuityInput {
  /** Episodes from the last 24h (most recent first). */
  episodes24h: { title: string; summary: string; at: string }[];
  /** Active beliefs, sorted by confidence descending. */
  beliefs: { statement: string; confidence: number }[];
  /** Active goals, sorted by progress descending. */
  goals: { title: string; progress: number; paused?: boolean }[];
  /** People from the conversations table (most recent first). */
  people: { name: string; lastSeen: string }[];
  /** Open questions the brain is tracking (working memory + open-questions). */
  openQuestions: { text: string; from: string }[];
  /** Most recent conversations (most recent first). */
  recentConversations: { title: string | null; at: string }[];
  /** Hours since the last conversation ended (Infinity if none). */
  hoursSinceLastChat: number;
  /** Today's date (caller-supplied so the selfcheck is hermetic). */
  today: { hour: number; weekday: string };
}

export interface ContinuityBriefing {
  generatedAt: string;
  greeting: string;
  /** The 3-5 sentence spoken prose. */
  briefing: string;
  /** Structured facts for the Mind panel. */
  episodesLast24h: ContinuityInput["episodes24h"];
  activeBeliefs: ContinuityInput["beliefs"];
  activeGoals: ContinuityInput["goals"];
  recentPeople: ContinuityInput["people"];
  openQuestions: ContinuityInput["openQuestions"];
  recentConversations: ContinuityInput["recentConversations"];
}

// ---------------------------------------------------------------------------
// Hand-rolled greeting — time-of-day + cadence since last chat.
// ponytail: the upper bound on the day map covers every JS Date.getDay().
// ---------------------------------------------------------------------------

function greetingFor(today: ContinuityInput["today"], hoursSinceLastChat: number): string {
  const { hour, weekday } = today;
  const tod = hour < 5 ? "evening" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  if (hoursSinceLastChat === Infinity) return `Hello. ${weekday} ${tod}.`;
  if (hoursSinceLastChat < 1) return `Back again. Good ${tod}.`;
  if (hoursSinceLastChat < 24) return `Welcome back. It's ${tod} on ${weekday}.`;
  if (hoursSinceLastChat < 24 * 7) {
    const days = Math.floor(hoursSinceLastChat / 24);
    return `Welcome back. It's been about ${days} day${days === 1 ? "" : "s"} — ${tod} on ${weekday}.`;
  }
  return `Long time. Good ${tod} on ${weekday}.`;
}

// ---------------------------------------------------------------------------
// The prose briefing. Hand-rolled from the data; one sentence per fact we
// actually have. A blank brain → a single honest line.
// ---------------------------------------------------------------------------

export function buildBriefing(input: ContinuityInput): ContinuityBriefing {
  const generatedAt = new Date().toISOString();
  const greeting = greetingFor(input.today, input.hoursSinceLastChat);
  const sentences: string[] = [];

  if (input.episodes24h.length > 0) {
    const n = input.episodes24h.length;
    const sample = input.episodes24h[0];
    sentences.push(
      n === 1
        ? `Since yesterday: 1 episode — "${sample.title}".`
        : `Since yesterday: ${n} episodes, most recently "${sample.title}".`,
    );
  }

  if (input.recentConversations.length > 0) {
    const last = input.recentConversations[0];
    const title = last.title ?? "an untitled conversation";
    sentences.push(`The last thing we talked about was ${title}.`);
  }

  if (input.goals.length > 0) {
    const active = input.goals.filter((g) => !g.paused).slice(0, 3);
    if (active.length > 0) {
      const titles = active.map((g) => g.title).join(", ");
      sentences.push(`Active goals: ${titles}.`);
    }
    const paused = input.goals.filter((g) => g.paused);
    if (paused.length > 0) {
      sentences.push(`${paused.length} goal${paused.length === 1 ? " is" : "s are"} paused.`);
    }
  }

  if (input.beliefs.length > 0) {
    const top = input.beliefs[0];
    sentences.push(`A current stance I hold: "${top.statement}".`);
  }

  if (input.openQuestions.length > 0) {
    const q = input.openQuestions[0];
    sentences.push(`Still open: ${q.text}.`);
  }

  if (input.people.length > 0) {
    const p = input.people[0];
    sentences.push(`Last seen: ${p.name}.`);
  }

  if (sentences.length === 0) {
    sentences.push("Welcome back. The brain has no record of prior activity yet.");
  }

  return {
    generatedAt,
    greeting,
    briefing: sentences.join(" "),
    episodesLast24h: input.episodes24h,
    activeBeliefs: input.beliefs,
    activeGoals: input.goals,
    recentPeople: input.people,
    openQuestions: input.openQuestions,
    recentConversations: input.recentConversations,
  };
}

/** The "spoken" shape — greeting + briefing text only, for the pet's voice. */
export function buildSpokenBriefing(input: ContinuityInput): { greeting: string; text: string } {
  const full = buildBriefing(input);
  return { greeting: full.greeting, text: full.briefing };
}
