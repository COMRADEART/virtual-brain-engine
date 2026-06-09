// Conversation continuity — give the otherwise-stateless 7-step pipeline a
// short-term memory of the CURRENT conversation. The pipeline relies entirely
// on semantic vector retrieval, which has no recency guarantee and faceplants
// on thin/anaphoric follow-ups ("tell me more", "why?", "fix that") whose text
// has no semantic overlap with the referent. This module assembles the last few
// turns into a compact transcript that is (a) injected into the reasoning +
// response prompts and (b) prepended to the RETRIEVAL embedding query ONLY when
// the prompt is thin — so normal, self-contained queries embed unchanged and
// retrieval never regresses.
//
// Everything here is PURE (no DB, no clock, no LLM) so the hermetic selfcheck
// exercises it directly; the pipeline does the one `listMessages` read and
// passes the rows in.

import type { ConversationMessage } from "../../../shared/memory.js";

/** Default number of prior messages (user+assistant rows) to carry. ~3 turns. */
export const DEFAULT_RECENT_MESSAGES = 6;
/** Per-message character cap so a long answer can't blow the prompt budget. */
export const PER_MESSAGE_CHAR_CAP = 320;

/**
 * Select the prior conversation turns to inject, EXCLUDING the current run's
 * messages. The pipeline inserts the current user message in the INPUT step
 * (before retrieval), so `listMessages(cid)` ordered ASC returns it as the last
 * row — filtering by the current `runId` drops it (and the assistant row, once
 * written, for any re-entrancy). Returns at most `maxMessages`, oldest-first.
 */
export function selectPriorTurns(
  messages: ReadonlyArray<ConversationMessage>,
  currentRunId: string,
  maxMessages: number = DEFAULT_RECENT_MESSAGES,
): ConversationMessage[] {
  const prior = messages.filter((m) => m.pipelineRunId !== currentRunId);
  if (prior.length <= maxMessages) return [...prior];
  return prior.slice(prior.length - maxMessages);
}

function clip(content: string): string {
  const trimmed = content.trim().replace(/\s+/g, " ");
  return trimmed.length > PER_MESSAGE_CHAR_CAP
    ? `${trimmed.slice(0, PER_MESSAGE_CHAR_CAP)}…`
    : trimmed;
}

/**
 * Format prior turns as a compact transcript block. Assistant answers carry the
 * three-section "Known memory:/Inferred reasoning:/Uncertain:" scaffolding and
 * `[m:<id>]` markers; we strip both so the injected history reads as plain prose
 * and the model never mistakes an old marker for a citable id this turn.
 * Returns "" when there is nothing to inject (so callers can cheaply skip).
 */
export function formatTranscript(turns: ReadonlyArray<ConversationMessage>): string {
  if (turns.length === 0) return "";
  const lines = turns.map((m) => {
    const speaker = m.role === "assistant" ? "Assistant" : "User";
    let body = m.content;
    if (m.role === "assistant") {
      body = body
        .replace(/\b(Known memory:|Inferred reasoning:|Uncertain:)/g, " ")
        .replace(/\[m:[A-Za-z0-9]+\]/g, "");
    }
    return `${speaker}: ${clip(body)}`;
  });
  return lines.join("\n");
}

/**
 * Heuristic: does the prompt depend on prior context to be understood? Short
 * prompts and ones that open with / consist of an anaphor ("it", "that",
 * "those", "tell me more", "why", "and?", pronoun-only) cannot be retrieved
 * against on their own. Deliberately conservative — a false negative just keeps
 * the prior (unchanged) retrieval behavior; a false positive only PREPENDS
 * recent context to the embedding, which is harmless for a self-contained query.
 */
export function isThinPrompt(prompt: string): boolean {
  const p = prompt.trim().toLowerCase();
  if (p.length === 0) return false;
  const wordCount = p.split(/\s+/).filter(Boolean).length;
  if (wordCount <= 4) return true;
  // Leading anaphor / continuation cues.
  const anaphor = /^(it|that|this|those|these|they|them|he|she|so|and|but|then|why|how about|what about|tell me more|more on|go on|continue|elaborate|expand|explain that|same|again)\b/;
  return anaphor.test(p);
}

/**
 * Build the text actually embedded for retrieval. For a self-contained prompt
 * this is the prompt verbatim (zero retrieval regression). For a thin/anaphoric
 * prompt we prepend the recent transcript so the referent ("...the auth bug")
 * is in the embedded text and the vector search can find it.
 */
export function buildRetrievalText(
  prompt: string,
  turns: ReadonlyArray<ConversationMessage>,
): string {
  if (turns.length === 0 || !isThinPrompt(prompt)) return prompt;
  const transcript = formatTranscript(turns);
  if (!transcript) return prompt;
  return `${transcript}\nUser: ${prompt.trim()}`;
}

/**
 * The transcript block injected into the reasoning + response prompts. Empty
 * string when there is no prior context (caller filters it out).
 */
export function buildPromptContextBlock(turns: ReadonlyArray<ConversationMessage>): string {
  const transcript = formatTranscript(turns);
  if (!transcript) return "";
  return `Recent conversation (most recent last — for resolving follow-ups like "tell me more"; do NOT cite these as memories):\n${transcript}`;
}
