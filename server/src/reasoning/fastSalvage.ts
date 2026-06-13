// fastSalvage.ts — decide whether a shallow-routed query should escalate to
// the full pipeline path because retrieval came back empty or weak.
//
// Pure module: NO imports of CONFIG, DB, or LLM. All tunables are passed as
// parameters with exported defaults.

export interface SalvageInput {
  depth: "shallow" | "full";
  hitCount: number;   // number of memory hits retrieved
  topScore: number;   // best retrieval score [0,1]
  fastMode: boolean;  // CONFIG.fastMode, passed in by caller
}

export const DEFAULT_SALVAGE_SCORE_FLOOR = 0.25;

/**
 * Returns true ONLY when:
 *   - depth is "shallow"   (never deepen a full route — it's already deep)
 *   - fastMode is true     (no-regression: when fastMode is off, don't escalate)
 *   - retrieval is thin    (hitCount === 0 OR topScore < scoreFloor)
 *
 * Non-finite topScore values (NaN, ±Infinity) are normalised to 0.
 */
export function shouldEscalate(
  input: SalvageInput,
  scoreFloor: number = DEFAULT_SALVAGE_SCORE_FLOOR,
): boolean {
  if (input.depth !== "shallow") return false;
  if (!input.fastMode) return false;

  const score = Number.isFinite(input.topScore) ? input.topScore : 0;
  return input.hitCount === 0 || score < scoreFloor;
}

/**
 * Returns a short reason token used for pipeline detail strings:
 *   "thin:no-hits"   — escalating because hitCount === 0
 *   "thin:low-score" — escalating because topScore < scoreFloor
 *   ""               — not escalating
 *
 * When both conditions hold simultaneously, no-hits takes priority.
 */
export function salvageReason(
  input: SalvageInput,
  scoreFloor: number = DEFAULT_SALVAGE_SCORE_FLOOR,
): string {
  if (!shouldEscalate(input, scoreFloor)) return "";
  if (input.hitCount === 0) return "thin:no-hits";
  return "thin:low-score";
}
