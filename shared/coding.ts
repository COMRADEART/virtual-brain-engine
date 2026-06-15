// Shared contract for the CODING MASTERY layer — the brain's "verify-until-correct"
// coding capability. ZERO runtime deps: pure types + pure helper functions only,
// so both the Vite client and the Node server import it without a build step.
//
// THE HONEST CONTRACT. "100% success" is not achievable and is never promised. The
// real, enforceable property is: the brain NEVER returns code it has not PROVEN
// works. Every coding answer either ends with a build/test command that exited 0
// AFTER the last edit (verification passed), or it honestly reports "I could not
// make verification pass" with the last failing output attached. The agent loop's
// existing stall/loop-breaker + round cap already guarantee termination; the
// verify gate below guarantees termination is never silently equated with success.

import type { ActionRiskTier } from "./actions.js";

// ── Patch primitive ─────────────────────────────────────────────────────────
// A single literal find/replace edit (Edit-tool semantics). `find` must occur
// exactly once unless `all` is set. This is what the model emits for apply-patch;
// the actual fs read/guard/write happens server-side in the executor handler.
export interface PatchEdit {
  find: string;
  replace: string;
  /** Replace every occurrence instead of requiring `find` to be unique. */
  all?: boolean;
}

export interface ApplyEditsResult {
  ok: boolean;
  /** The new file content (only when ok). */
  content?: string;
  /** How many replacements were made. */
  applied: number;
  error?: string;
}

// Apply an ordered list of literal find/replace edits to a source string. PURE:
// no fs, no throw. Mirrors the Edit tool — a `find` that is absent, or ambiguous
// without `all`, is a hard error so the model must add context rather than edit
// the wrong place.
export function applyEdits(original: string, edits: PatchEdit[]): ApplyEditsResult {
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, applied: 0, error: "no edits provided" };
  }
  let content = original;
  let applied = 0;
  for (let i = 0; i < edits.length; i += 1) {
    const edit = edits[i];
    const find = typeof edit?.find === "string" ? edit.find : "";
    const replace = typeof edit?.replace === "string" ? edit.replace : "";
    if (find.length === 0) {
      return { ok: false, applied, error: `edit ${i + 1}: "find" is empty` };
    }
    if (find === replace) {
      return { ok: false, applied, error: `edit ${i + 1}: "find" and "replace" are identical` };
    }
    const count = countOccurrences(content, find);
    if (count === 0) {
      return { ok: false, applied, error: `edit ${i + 1}: "find" text not present in the file` };
    }
    if (count > 1 && edit.all !== true) {
      return {
        ok: false,
        applied,
        error: `edit ${i + 1}: "find" matches ${count} places — add surrounding context to make it unique, or set "all": true`,
      };
    }
    content = edit.all === true ? content.split(find).join(replace) : content.replace(find, replace);
    applied += edit.all === true ? count : 1;
  }
  return { ok: true, content, applied };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

// ── Verify gate ─────────────────────────────────────────────────────────────
// Did a real build/test pass AFTER the last code edit? "passed" only if a verify
// action exited 0 after the last successful mutating action; "failed" if a verify
// ran after the last edit but did not pass; "unverified" if files were changed
// but no verify ran afterward (or no verify at all).
export type VerifyOutcome = "passed" | "failed" | "unverified";

export interface CodingTrailEntry {
  action: string;
  ok: boolean;
  /** A successful code-mutating action (apply-patch / write-file / git-write-file). */
  mutating: boolean;
  /** A verification action (run-tests / run-build). */
  verify: boolean;
  /** verify && the command exited 0. */
  verifyPassed: boolean;
}

export const MUTATING_ACTION_IDS = ["apply-patch", "write-file", "git-write-file"] as const;
export const VERIFY_ACTION_IDS = ["run-tests", "run-build"] as const;

export function isMutatingActionId(id: string): boolean {
  return (MUTATING_ACTION_IDS as readonly string[]).includes(id);
}

export function isVerifyActionId(id: string): boolean {
  return (VERIFY_ACTION_IDS as readonly string[]).includes(id);
}

// Interpret a run-tests/run-build handler's `data` payload as pass/fail. Tolerant
// of either an explicit `passed` boolean or an `exitCode` of 0.
export function verifyResultPassed(data: unknown): boolean {
  if (data && typeof data === "object") {
    const d = data as { passed?: unknown; exitCode?: unknown };
    if (typeof d.passed === "boolean") return d.passed;
    if (typeof d.exitCode === "number") return d.exitCode === 0;
  }
  return false;
}

export function sessionMutatedCode(trail: CodingTrailEntry[]): boolean {
  return trail.some((e) => e.mutating && e.ok);
}

export function assertVerified(trail: CodingTrailEntry[]): VerifyOutcome {
  let lastMutationIdx = -1;
  for (let i = 0; i < trail.length; i += 1) {
    if (trail[i].mutating && trail[i].ok) lastMutationIdx = i;
  }
  const verifyAfter = trail
    .slice(lastMutationIdx + 1)
    .filter((e) => e.verify && e.ok);
  if (verifyAfter.length === 0) return "unverified";
  return verifyAfter[verifyAfter.length - 1].verifyPassed ? "passed" : "failed";
}

// ── Build/test result shape (run-tests / run-build handler data) ─────────────
export interface BuildTestResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  passed: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

// A short, model-facing summary of a failing build/test run.
export function summarizeFailure(r: BuildTestResult): string {
  const tail = (s: string, n: number): string => (s.length > n ? `…${s.slice(s.length - n)}` : s);
  const body = [r.stdout, r.stderr].map((s) => s.trim()).filter((s) => s.length > 0).join("\n");
  return `\`${r.command}\` exited ${r.exitCode ?? "?"}\n${tail(body, 1500) || "(no output)"}`;
}

// ── Structured diagnostic hint (best-effort parse of tool output) ────────────
export interface DiagnosticHint {
  tool: "tsc" | "eslint" | "vitest" | "node-test" | "generic";
  file?: string;
  line?: number;
  message: string;
}

// What a verified-or-not coding turn reports back on the final agent frame.
export interface CodingVerifyReport {
  outcome: VerifyOutcome;
  mutated: boolean;
  /** The risk tier the coding/verify actions carried (always "confirm"). */
  tier?: ActionRiskTier;
}
