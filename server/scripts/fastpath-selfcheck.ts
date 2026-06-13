// fastpath-selfcheck.ts — hermetic selfcheck for server/src/reasoning/fastSalvage.ts
//
// Run: npx tsx server/scripts/fastpath-selfcheck.ts
//
// Asserts:
//   1. shallow + fastMode + 0 hits       → escalate true;  reason "thin:no-hits"
//   2. shallow + fastMode + low topScore → escalate true;  reason "thin:low-score"
//   3. shallow + fastMode + good score   → escalate false; reason ""
//   4. shallow + fastMode FALSE + 0 hits → false (no-regression)
//   5. full route + 0 hits + fastMode    → false (never deepen a full route)
//   6. custom scoreFloor respected

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

// Set up temp dir (consistent with other selfchecks; no DB used here).
const tmp = mkdtempSync(join(tmpdir(), "brain-fastpath-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const {
  shouldEscalate,
  salvageReason,
  DEFAULT_SALVAGE_SCORE_FLOOR,
} = await import("../src/reasoning/fastSalvage.js");

// ---------------------------------------------------------------------------
// 1. shallow + fastMode + hitCount 0 → escalate; reason "thin:no-hits"
// ---------------------------------------------------------------------------
{
  const input = { depth: "shallow" as const, hitCount: 0, topScore: 0, fastMode: true };
  check("1. shallow+fastMode+0 hits → shouldEscalate true", shouldEscalate(input) === true);
  check("1. shallow+fastMode+0 hits → reason thin:no-hits", salvageReason(input) === "thin:no-hits");
}

// ---------------------------------------------------------------------------
// 2. shallow + fastMode + low topScore + some hits → escalate; "thin:low-score"
// ---------------------------------------------------------------------------
{
  const input = { depth: "shallow" as const, hitCount: 3, topScore: 0.1, fastMode: true };
  check(
    "2. shallow+fastMode+topScore 0.1 → shouldEscalate true",
    shouldEscalate(input) === true,
    `floor=${DEFAULT_SALVAGE_SCORE_FLOOR}`,
  );
  check("2. shallow+fastMode+topScore 0.1 → reason thin:low-score", salvageReason(input) === "thin:low-score");
}

// ---------------------------------------------------------------------------
// 3. shallow + fastMode + good topScore + hits → no escalation
// ---------------------------------------------------------------------------
{
  const input = { depth: "shallow" as const, hitCount: 3, topScore: 0.8, fastMode: true };
  check("3. shallow+fastMode+topScore 0.8 → shouldEscalate false", shouldEscalate(input) === false);
  check("3. shallow+fastMode+topScore 0.8 → reason empty string", salvageReason(input) === "");
}

// ---------------------------------------------------------------------------
// 4. shallow + fastMode FALSE + 0 hits → false (no-regression guard)
// ---------------------------------------------------------------------------
{
  const input = { depth: "shallow" as const, hitCount: 0, topScore: 0, fastMode: false };
  check("4. fastMode=false → shouldEscalate false", shouldEscalate(input) === false);
  check("4. fastMode=false → reason empty string", salvageReason(input) === "");
}

// ---------------------------------------------------------------------------
// 5. full route + 0 hits + fastMode true → false (never deepen a full route)
// ---------------------------------------------------------------------------
{
  const input = { depth: "full" as const, hitCount: 0, topScore: 0, fastMode: true };
  check("5. full route+fastMode → shouldEscalate false", shouldEscalate(input) === false);
  check("5. full route+fastMode → reason empty string", salvageReason(input) === "");
}

// ---------------------------------------------------------------------------
// 6. Custom scoreFloor is respected
// ---------------------------------------------------------------------------
{
  // topScore 0.4 is above the DEFAULT floor (0.25) but below a custom floor of 0.5
  const input = { depth: "shallow" as const, hitCount: 2, topScore: 0.4, fastMode: true };
  check(
    "6. topScore 0.4 >= default floor → no escalation at default floor",
    shouldEscalate(input, DEFAULT_SALVAGE_SCORE_FLOOR) === false,
  );
  check(
    "6. topScore 0.4 < custom floor 0.5 → escalates with custom floor",
    shouldEscalate(input, 0.5) === true,
  );
  check(
    "6. reason with custom floor 0.5 → thin:low-score",
    salvageReason(input, 0.5) === "thin:low-score",
  );
}

// ---------------------------------------------------------------------------
// 7. NaN / non-finite topScore treated as 0 (guard clause)
// ---------------------------------------------------------------------------
{
  const nanInput = { depth: "shallow" as const, hitCount: 1, topScore: NaN, fastMode: true };
  check("7. NaN topScore treated as 0 → escalates", shouldEscalate(nanInput) === true);
  check("7. NaN topScore reason → thin:low-score", salvageReason(nanInput) === "thin:low-score");
}

// ---------------------------------------------------------------------------
// 8. Exact scoreFloor boundary: topScore === floor → NOT escalated
// ---------------------------------------------------------------------------
{
  const input = {
    depth: "shallow" as const,
    hitCount: 1,
    topScore: DEFAULT_SALVAGE_SCORE_FLOOR,
    fastMode: true,
  };
  check(
    "8. topScore === floor → NOT escalated (strict <)",
    shouldEscalate(input) === false,
  );
}

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
