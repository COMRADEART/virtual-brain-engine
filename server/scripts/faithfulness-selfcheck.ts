// Citation-faithfulness selfcheck — hermetic, PURE (no DB, no LLM, no network).
//
// Run: npm --prefix server run faithfulness:selfcheck
//
// Asserts the lexical faithfulness floor that flags [m:<id>] citations whose
// claim isn't supported by the cited memory, and the training-signal hook the
// pipeline uses (faithfulCitedIds = citedIds minus flagged):
//   (A) lexicalEntailment: full coverage ≈ 1, zero overlap ≈ 0.
//   (B) extractCitedClaims: one ClaimCitation per marker, markers stripped.
//   (C) assessFaithfulness: flags an unsupported claim, PASSES a supported one,
//       never flags a too-short (unjudgeable) claim, and an id supported by ANY
//       of its claims is not flagged.
//   (D) appendFaithfulnessNote: adds a note into Uncertain only when flagged.

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

const {
  lexicalEntailment,
  extractCitedClaims,
  assessFaithfulness,
  appendFaithfulnessNote,
  contentTokens,
  FAITHFULNESS_THRESHOLD,
} = await import("../src/reasoning/faithfulness.js");

// -----------------------------------------------------------------------------
// (A) lexicalEntailment
// -----------------------------------------------------------------------------
check(
  "lexicalEntailment: fully-supported claim ≈ 1",
  lexicalEntailment("the token expires after rotation", "the auth token expires after each rotation cycle") >= 0.99,
);
check(
  "lexicalEntailment: unrelated claim ≈ 0",
  lexicalEntailment("the sky is blue today", "database vector index uses cosine similarity") < 0.2,
);
check("lexicalEntailment: empty claim → 0", lexicalEntailment("", "anything") === 0);
check("contentTokens drops stopwords + short words", !contentTokens("the a is of token").includes("the"));

// -----------------------------------------------------------------------------
// (B) extractCitedClaims
// -----------------------------------------------------------------------------
{
  const answer = "The vector store uses sqlite-vec [m:01AAA]. Reasoning follows [m:01BBB] here.";
  const claims = extractCitedClaims(answer);
  check("extractCitedClaims finds one per marker", claims.length === 2, `n=${claims.length}`);
  check("extractCitedClaims strips the markers from the claim", claims.every((c) => !c.claim.includes("[m:")));
  check("extractCitedClaims associates the right id", claims[0]?.id === "01AAA");
}

// -----------------------------------------------------------------------------
// (C) assessFaithfulness
// -----------------------------------------------------------------------------
{
  const mem = new Map<string, string>([
    ["01AAA", "The project stores embeddings in a sqlite-vec virtual table for cosine search."],
    ["01BBB", "Bananas are a good source of potassium and grow in tropical climates."],
  ]);
  // A claim that cites a SUPPORTING memory and one that cites an UNRELATED memory.
  const answer =
    "Embeddings live in a sqlite-vec virtual table for cosine search [m:01AAA]. " +
    "The deployment runs on Kubernetes across three regions [m:01BBB].";
  const r = assessFaithfulness(answer, mem);
  check("assessFaithfulness checks both judgeable claims", r.checked === 2, `checked=${r.checked}`);
  check("assessFaithfulness flags the unsupported citation", r.unfaithfulIds.has("01BBB"));
  check("assessFaithfulness does NOT flag the supported citation", !r.unfaithfulIds.has("01AAA"));

  // Too-short claim is unjudgeable → never flagged.
  const short = assessFaithfulness("Yes [m:01BBB].", mem);
  check("assessFaithfulness skips too-short (unjudgeable) claims", short.unfaithfulIds.size === 0, `n=${short.unfaithfulIds.size}`);

  // An id supported by ANY one of its claims is not flagged.
  const twoClaims =
    "The deployment is unrelated nonsense words here [m:01AAA]. " +
    "Embeddings live in a sqlite-vec virtual table for cosine search [m:01AAA].";
  const r2 = assessFaithfulness(twoClaims, mem);
  check("assessFaithfulness keeps an id supported by ANY claim", !r2.unfaithfulIds.has("01AAA"));

  // A citation to an id NOT in the memory map is skipped (not retrieved).
  const unknown = assessFaithfulness("Some claim about things here now [m:NOTRETRIEVED].", mem);
  check("assessFaithfulness skips citations to non-retrieved ids", unknown.checked === 0);
}

// -----------------------------------------------------------------------------
// (D) appendFaithfulnessNote
// -----------------------------------------------------------------------------
{
  const flagged = { checked: 1, unfaithfulIds: new Set(["01BBB"]), unfaithful: [{ id: "01BBB", claim: "x", score: 0.0 }] };
  const withUncertain = "Known memory:\nfoo [m:01AAA]\n\nInferred reasoning:\nbar\n\nUncertain:\nnothing";
  const noted = appendFaithfulnessNote(withUncertain, flagged);
  check("appendFaithfulnessNote inserts into Uncertain", noted.includes("Faithfulness check") && noted.includes("[m:01BBB]"));
  const clean = { checked: 1, unfaithfulIds: new Set<string>(), unfaithful: [] as { id: string; claim: string; score: number }[] };
  check("appendFaithfulnessNote is a no-op when nothing flagged", appendFaithfulnessNote(withUncertain, clean) === withUncertain);
}

check("FAITHFULNESS_THRESHOLD is a sane low floor", FAITHFULNESS_THRESHOLD > 0 && FAITHFULNESS_THRESHOLD < 0.5);

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
