// Hermetic selfcheck for server/src/reasoning/parallelReasoning.ts
//
// Run: npx tsx server/scripts/parallelreason-selfcheck.ts
//
// No DB, no LLM, no network. Sets a throwaway BRAIN_DATA_DIR/BRAIN_DB_PATH
// so that any transitive import that reads env at module-eval time gets a
// valid-looking (but isolated) path.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

// Throwaway temp dir (mirrors selfmodel-selfcheck.ts pattern).
const tmp = mkdtempSync(join(tmpdir(), "brain-parallelreason-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const { scoreDrafts, bestOfParallel, DEFAULT_DRAFTS } = await import(
  "../src/reasoning/parallelReasoning.js"
);

// ---------------------------------------------------------------------------
// (1) scoreDrafts: two similar drafts vs one unrelated — winner is 0 or 1,
//     not 2; agreement > 0.
// ---------------------------------------------------------------------------

{
  const drafts = [
    { text: "the cat sat on the mat" },
    { text: "the cat sat on a mat" },
    { text: "quantum chromodynamics of gluons" },
  ];
  const { bestIndex, agreement } = scoreDrafts(drafts);
  check(
    "winner is one of the two similar drafts (not index 2)",
    bestIndex === 0 || bestIndex === 1,
    `bestIndex=${bestIndex}`,
  );
  check("agreement > 0", agreement > 0, `agreement=${agreement.toFixed(4)}`);
}

// ---------------------------------------------------------------------------
// (2) Edge cases: single draft, empty array.
// ---------------------------------------------------------------------------

{
  const single = scoreDrafts([{ text: "hello world" }]);
  check("single draft → bestIndex 0", single.bestIndex === 0);
  check("single draft → agreement 1", single.agreement === 1);

  const empty = scoreDrafts([]);
  check("empty → bestIndex -1", empty.bestIndex === -1);
  check("empty → agreement 0", empty.agreement === 0);
}

// ---------------------------------------------------------------------------
// (3) bestOfParallel: 3 runners, 2 strongly agree.
// ---------------------------------------------------------------------------

{
  const texts = [
    "the cat sat on the mat",        // 0 — similar pair
    "the cat sat on a mat",           // 1 — similar pair
    "supernova collapsars jets",      // 2 — outlier
  ];
  const { best, ran, errored } = await bestOfParallel(
    3,
    async (i: number) => texts[i],
    (d: string) => d,
  );
  check(
    "best is one of the two agreeing texts",
    best === texts[0] || best === texts[1],
    `best="${best}"`,
  );
  check("ran === 3", ran === 3, `ran=${ran}`);
  check("errored === 0", errored === 0, `errored=${errored}`);
}

// ---------------------------------------------------------------------------
// (4) One runner throws → still returns a non-null best; errored === 1.
// ---------------------------------------------------------------------------

{
  const goods = ["apple banana cherry", "apple banana mango"];
  const result = await bestOfParallel(
    3,
    async (i: number): Promise<string> => {
      if (i === 1) throw new Error("boom");
      return goods[i === 0 ? 0 : 1];
    },
    (d: string) => d,
  );
  check("one-error: best is non-null", result.best !== null, `best="${result.best}"`);
  check("one-error: errored === 1", result.errored === 1, `errored=${result.errored}`);
  check("one-error: does not throw (reached this line)", true);
}

// ---------------------------------------------------------------------------
// (5) All runners throw → best === null; errored === n; does not throw.
// ---------------------------------------------------------------------------

{
  const n = 3;
  const result = await bestOfParallel(
    n,
    async (_i: number): Promise<string> => {
      throw new Error("all fail");
    },
    (d: string) => d,
  );
  check("all-fail: best === null", result.best === null);
  check("all-fail: errored === n", result.errored === n, `errored=${result.errored}`);
  check("all-fail: does not throw (reached this line)", true);
}

// ---------------------------------------------------------------------------
// (6) bestOfParallel(1, ...) → single result, agreement === 1.
// ---------------------------------------------------------------------------

{
  const result = await bestOfParallel(
    1,
    async (_i: number) => "single text result",
    (d: string) => d,
  );
  check("n=1: best is the single text", result.best === "single text result");
  check("n=1: agreement === 1", result.agreement === 1, `agreement=${result.agreement}`);
}

// ---------------------------------------------------------------------------
// (7) DEFAULT_DRAFTS is exported with the expected value.
// ---------------------------------------------------------------------------

check("DEFAULT_DRAFTS === 2", DEFAULT_DRAFTS === 2, `DEFAULT_DRAFTS=${DEFAULT_DRAFTS}`);

// ---------------------------------------------------------------------------
// Result.
// ---------------------------------------------------------------------------

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
