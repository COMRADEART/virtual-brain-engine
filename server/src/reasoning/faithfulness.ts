// Citation faithfulness — does each [m:<id>] citation's CLAIM actually appear in
// the memory it cites? The pipeline already validates that cited ids EXIST
// (validateMarkers strips unknown ids) and persists a `cites` graph, but it
// never checks that the claim is SUPPORTED by the cited text — so a confidently
// wrong answer can cite a real-but-irrelevant memory and nothing flags it.
//
// This is the cold-start FLOOR: a cheap, PURE lexical-entailment check (content-
// word coverage of the claim by the cited memory). It is deliberately
// HIGH-PRECISION / low-recall — a low threshold so it only flags claims that are
// clearly unsupported, because a false flag on the hot path is worse than a
// missed one. An LLM-judge upgrade can layer on later; the lexical floor needs
// no DB, no LLM, and no network, so it is fully hermetic and costs nothing extra
// on the answer path. Off by default (CONFIG.citationFaithfulness).

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with", "as", "by",
  "is", "are", "was", "were", "be", "been", "being", "it", "its", "this", "that", "these",
  "those", "at", "from", "into", "than", "then", "so", "such", "can", "could", "will",
  "would", "should", "may", "might", "do", "does", "did", "has", "have", "had", "not",
  "no", "yes", "if", "you", "your", "we", "our", "they", "their", "i", "me", "my",
  "he", "she", "his", "her", "which", "who", "what", "when", "where", "why", "how",
  "there", "here", "about", "also", "more", "most", "some", "any", "all", "one",
]);

/** Min content-word coverage [0,1] for a claim to count as SUPPORTED by its memory. */
export const FAITHFULNESS_THRESHOLD = 0.18;
/** A claim with fewer than this many content tokens is unjudgeable → not flagged. */
export const MIN_CLAIM_TOKENS = 3;

/** Lowercase content words (len>2, non-stopword), order-preserving with dupes. */
export function contentTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []).filter(
    (w) => w.length > 2 && !STOPWORDS.has(w),
  );
}

/**
 * Fraction of the claim's content tokens that also appear in the memory text.
 * 0 when the claim has no content tokens (caller treats too-short claims as
 * unjudgeable rather than unfaithful).
 */
export function lexicalEntailment(claim: string, memoryText: string): number {
  const claimToks = contentTokens(claim);
  if (claimToks.length === 0) return 0;
  const memToks = new Set(contentTokens(memoryText));
  const covered = claimToks.filter((t) => memToks.has(t)).length;
  return covered / claimToks.length;
}

export interface ClaimCitation {
  id: string;
  /** The sentence the marker sits in (the claim it purports to support). */
  claim: string;
}

/**
 * For every [m:<id>] marker, the sentence it appears in (markers stripped).
 * A sentence with two markers yields two ClaimCitations (one per id) sharing the
 * same claim text. Sentences split on . ! ? and newlines.
 */
export function extractCitedClaims(answer: string): ClaimCitation[] {
  const out: ClaimCitation[] = [];
  const sentences = answer.split(/(?<=[.!?])\s+|\n+/);
  for (const sentence of sentences) {
    const ids = Array.from(sentence.matchAll(/\[m:([A-Za-z0-9]+)\]/g)).map((m) => m[1]);
    if (ids.length === 0) continue;
    const claim = sentence.replace(/\[m:[A-Za-z0-9]+\]/g, "").trim();
    for (const id of ids) out.push({ id, claim });
  }
  return out;
}

export interface FaithfulnessResult {
  /** Number of (claim, citation) pairs actually judged. */
  checked: number;
  /** Cited ids whose every judgeable claim fell below the threshold. */
  unfaithfulIds: Set<string>;
  /** Detail for the note / logging. */
  unfaithful: { id: string; claim: string; score: number }[];
}

/**
 * Assess citation faithfulness. PURE: takes the answer and a map of cited memory
 * text. An id is flagged unfaithful only when it has >=1 judgeable claim and ALL
 * of its judgeable claims score below the threshold (so a memory supported by
 * any one of its claims is never flagged).
 */
export function assessFaithfulness(
  answer: string,
  memoryTextById: ReadonlyMap<string, string>,
  threshold: number = FAITHFULNESS_THRESHOLD,
): FaithfulnessResult {
  const claims = extractCitedClaims(answer);
  // Best (max) entailment per id, plus whether the id had any judgeable claim.
  const bestById = new Map<string, { score: number; claim: string }>();
  const judgeable = new Set<string>();
  let checked = 0;
  for (const { id, claim } of claims) {
    const memText = memoryTextById.get(id);
    if (memText === undefined) continue; // not a retrieved memory — skip
    if (contentTokens(claim).length < MIN_CLAIM_TOKENS) continue; // too short to judge
    judgeable.add(id);
    checked += 1;
    const score = lexicalEntailment(claim, memText);
    const prev = bestById.get(id);
    if (!prev || score > prev.score) bestById.set(id, { score, claim });
  }
  const unfaithfulIds = new Set<string>();
  const unfaithful: { id: string; claim: string; score: number }[] = [];
  for (const id of judgeable) {
    const best = bestById.get(id);
    if (best && best.score < threshold) {
      unfaithfulIds.add(id);
      unfaithful.push({ id, claim: best.claim, score: best.score });
    }
  }
  return { checked, unfaithfulIds, unfaithful };
}

/**
 * Append a faithfulness note to the Uncertain section (mirrors validateMarkers'
 * note style). No-op when nothing was flagged.
 */
export function appendFaithfulnessNote(answer: string, result: FaithfulnessResult): string {
  if (result.unfaithful.length === 0) return answer;
  const ids = result.unfaithful.map((u) => `[m:${u.id}]`).join(", ");
  const note = `Faithfulness check: ${result.unfaithful.length} citation(s) (${ids}) may not be supported by the cited memory.`;
  if (/Uncertain:\s*/.test(answer)) {
    return answer.replace(/(Uncertain:\s*)/, `$1${note} `);
  }
  return `${answer}\n\nUncertain:\n${note}`;
}
