// Conversation-continuity selfcheck — hermetic, PURE (no DB, no LLM, no network).
//
// Run: npm --prefix server run conversationcontext:selfcheck
//
// Asserts the pure helpers that give the 7-step pipeline a short-term memory of
// the current conversation:
//   (A) selectPriorTurns EXCLUDES the current run's messages (the critical
//       gotcha — the current user turn is inserted before retrieval) and caps
//       to the last N, oldest-first.
//   (B) formatTranscript strips assistant section headers + [m:<id>] markers,
//       labels speakers, clips long content, and "" on empty.
//   (C) isThinPrompt flags short/anaphoric follow-ups and passes self-contained
//       questions through.
//   (D) buildRetrievalText embeds a self-contained prompt VERBATIM (zero
//       retrieval regression) and only prepends context for a thin prompt.
//   (E) buildPromptContextBlock contains the prior turns and NOT the current one.

import type { ConversationMessage } from "../../shared/memory.js";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

const {
  selectPriorTurns,
  formatTranscript,
  isThinPrompt,
  buildRetrievalText,
  buildPromptContextBlock,
  DEFAULT_RECENT_MESSAGES,
  PER_MESSAGE_CHAR_CAP,
} = await import("../src/reasoning/conversationContext.js");

function msg(
  content: string,
  role: "user" | "assistant",
  runId: string | null,
  i: number,
): ConversationMessage {
  return {
    id: `m${i}`,
    conversationId: "c1",
    role,
    content,
    createdAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
    pipelineRunId: runId,
  };
}

// -----------------------------------------------------------------------------
// (A) selectPriorTurns
// -----------------------------------------------------------------------------
{
  const history: ConversationMessage[] = [
    msg("first question", "user", "run-1", 0),
    msg("first answer about the auth refactor", "assistant", "run-1", 1),
    msg("tell me more", "user", "run-2", 2), // CURRENT run's just-inserted user turn
  ];
  const prior = selectPriorTurns(history, "run-2");
  check("selectPriorTurns excludes the current run's messages", prior.every((m) => m.pipelineRunId !== "run-2"), `len=${prior.length}`);
  check("selectPriorTurns keeps the prior turns", prior.length === 2);
  check("selectPriorTurns is oldest-first", prior[0]?.content === "first question");

  // Cap: more than DEFAULT_RECENT_MESSAGES prior rows → keep the last N.
  const many: ConversationMessage[] = Array.from({ length: DEFAULT_RECENT_MESSAGES + 4 }, (_, i) =>
    msg(`turn ${i}`, i % 2 === 0 ? "user" : "assistant", "run-old", i),
  );
  const capped = selectPriorTurns(many, "run-current");
  check("selectPriorTurns caps to DEFAULT_RECENT_MESSAGES", capped.length === DEFAULT_RECENT_MESSAGES, `len=${capped.length}`);
  check("selectPriorTurns cap keeps the MOST RECENT", capped.at(-1)?.content === `turn ${DEFAULT_RECENT_MESSAGES + 3}`);
  check("selectPriorTurns empty → empty", selectPriorTurns([], "run-x").length === 0);
}

// -----------------------------------------------------------------------------
// (B) formatTranscript
// -----------------------------------------------------------------------------
{
  const turns: ConversationMessage[] = [
    msg("what is the auth bug", "user", "r0", 0),
    msg("Known memory:\nthe token expires [m:01ABC] Inferred reasoning: rotate it Uncertain: maybe", "assistant", "r0", 1),
  ];
  const t = formatTranscript(turns);
  check("formatTranscript labels speakers", t.includes("User:") && t.includes("Assistant:"));
  check("formatTranscript strips section headers", !t.includes("Known memory:") && !t.includes("Inferred reasoning:") && !t.includes("Uncertain:"));
  check("formatTranscript strips [m:<id>] markers", !/\[m:[A-Za-z0-9]+\]/.test(t), t);
  check("formatTranscript empty → ''", formatTranscript([]) === "");

  const long = "x".repeat(PER_MESSAGE_CHAR_CAP + 50);
  const clipped = formatTranscript([msg(long, "user", "r1", 0)]);
  check("formatTranscript clips long content", clipped.length < long.length + 20 && clipped.includes("…"));
}

// -----------------------------------------------------------------------------
// (C) isThinPrompt
// -----------------------------------------------------------------------------
check("isThinPrompt: 'tell me more about it' → true", isThinPrompt("tell me more about it") === true);
check("isThinPrompt: 'why?' → true", isThinPrompt("why?") === true);
check("isThinPrompt: 'it' → true (<=4 words)", isThinPrompt("it") === true);
check("isThinPrompt: 'continue' → true", isThinPrompt("continue") === true);
check(
  "isThinPrompt: self-contained question → false",
  isThinPrompt("What is the capital of France and its population") === false,
);
check("isThinPrompt: empty → false", isThinPrompt("   ") === false);

// -----------------------------------------------------------------------------
// (D) buildRetrievalText
// -----------------------------------------------------------------------------
{
  const turns: ConversationMessage[] = [
    msg("explain the auth refactor", "user", "r0", 0),
    msg("we moved to JWT rotation", "assistant", "r0", 1),
  ];
  const selfContained = "What database does the project use for vectors";
  check("buildRetrievalText: self-contained prompt embeds VERBATIM", buildRetrievalText(selfContained, turns) === selfContained);

  const thin = "tell me more";
  const augmented = buildRetrievalText(thin, turns);
  check("buildRetrievalText: thin prompt prepends transcript", augmented.includes("auth refactor") && augmented.includes(thin) && augmented !== thin);
  check("buildRetrievalText: thin prompt with NO turns embeds verbatim", buildRetrievalText(thin, []) === thin);
}

// -----------------------------------------------------------------------------
// (E) buildPromptContextBlock — integration: contains prior, excludes current.
// -----------------------------------------------------------------------------
{
  const history: ConversationMessage[] = [
    msg("the auth refactor question", "user", "run-1", 0),
    msg("answer: rotate the JWT", "assistant", "run-1", 1),
    msg("THE-CURRENT-TURN-SECRET", "user", "run-2", 2),
  ];
  const block = buildPromptContextBlock(selectPriorTurns(history, "run-2"));
  check("buildPromptContextBlock contains prior content", block.includes("auth refactor") && block.includes("rotate the JWT"));
  check("buildPromptContextBlock EXCLUDES the current turn", !block.includes("THE-CURRENT-TURN-SECRET"), block);
  check("buildPromptContextBlock empty when no prior turns", buildPromptContextBlock([]) === "");
}

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
