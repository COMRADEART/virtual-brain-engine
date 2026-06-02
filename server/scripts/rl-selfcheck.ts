// RL selfcheck — the contextual-bandit policy (pure) + the adaptive controller
// (DB-backed). HERMETIC: throwaway DB via BRAIN_DB_PATH; warm threshold pinned low
// via env so the warm/convergence branches are reachable in a short loop.
//
// NOTE (the trap the advisor flagged): "converges on synthetic reward" proves the
// MATH, not the value — on a real single-user brain reward is scarce, so the
// controller is gated OFF by default and warm-starts at the heuristic. These
// assertions verify (a) the no-regression warm-start floor, (b) that the learning
// mechanism works when fed reward, (c) egress safety (augment forced off when the
// web is unavailable), and (d) that nothing throws.
// Run: npm --prefix server run rl:selfcheck

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "brain-rlcheck-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");
process.env.BANDIT_WARM_AT = "5"; // low threshold so warm branches are reachable
process.env.ADAPTIVE_CONTROLLER = "true";

const { openDb } = await import("../src/db/sqlite.js");
const { contextFeatures, selectArm, updateArm, predictReward, emptyBanditState } = await import("../src/reasoning/banditPolicy.js");
const { decide, reward, buildRetrievalContext, computeControllerOutcome, augmentSlotReward } = await import("../src/reasoning/adaptiveController.js");
const { loadBanditState } = await import("../src/db/repositories/adaptive.js");

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

openDb();

const ctx = { localHitCount: 2, topLocalScore: 0.3, queryLength: 5, timeSensitive: false, hybridAvailable: true };

// ============================================================================
// 1. banditPolicy (pure)
// ============================================================================
{
  const x = contextFeatures(ctx);
  check("contextFeatures: bias + 5 features (dim 6)", x.length === 6 && x[0] === 1);
}
{
  const fresh = emptyBanditState();
  const r = selectArm(fresh, "augment", ["false", "true"], ctx, "false", { warmAt: 5 });
  check("bandit COLD → heuristic arm, no exploration (no-regression floor)", r.arm === "false" && r.source === "heuristic");
}
{
  // Synthetic reward: "true" → 1, "false" → 0. After enough pulls the linear
  // model must predict higher for "true", and greedy (ε=0) must exploit it.
  let st = emptyBanditState();
  for (let i = 0; i < 12; i += 1) {
    st = updateArm(st, "augment", "true", ctx, 1);
    st = updateArm(st, "augment", "false", ctx, 0);
  }
  check("bandit learns: predicts higher reward for the rewarded arm", predictReward(st, "augment", "true", ctx) > predictReward(st, "augment", "false", ctx));
  const r = selectArm(st, "augment", ["false", "true"], ctx, "false", { warmAt: 5, epsilon: 0 });
  check("bandit WARM (ε=0) → exploits the learned-best arm", r.arm === "true" && r.source === "policy");
  check("bandit tracks pulls + totalPulls", st.slots.augment.totalPulls === 24 && st.slots.augment.arms.true.pulls === 12);
}
{
  let threw = false;
  try {
    selectArm(emptyBanditState(), "retrievalK", [], ctx, "8", { warmAt: 0 });
    updateArm(emptyBanditState(), "retrievalK", "8", ctx, 0.5);
    predictReward(emptyBanditState(), "augment", "nope", ctx);
  } catch {
    threw = true;
  }
  check("bandit never throws on empty arms / unseen arm / empty state", !threw);
}

// ============================================================================
// 2. adaptiveController (DB-backed)
// ============================================================================
{
  const d = decide(ctx, { augment: true, retrievalK: 8, multiQuery: false, modelProfile: "default" });
  check("controller COLD → augmentWeb == heuristic", d.augmentWeb === true);
  check("controller COLD → retrievalK == heuristic", d.retrievalK === 8);
  check("controller COLD → every slot source is 'heuristic'", Object.values(d.source).every((s) => s === "heuristic"));
}
{
  const noWeb = { ...ctx, hybridAvailable: false };
  const d = decide(noWeb, { augment: true, retrievalK: 8, multiQuery: false, modelProfile: "default" });
  check("controller: augment FORCED false when web unavailable (egress safety)", d.augmentWeb === false);
}
{
  const d = decide(ctx, { augment: false, retrievalK: 8, multiQuery: false, modelProfile: "default" });
  reward(d, ctx, { citationCoverage: 0.7, webCitationUsed: false, citedCount: 2 });
  const after = loadBanditState();
  check("controller.reward persists bandit state", !!after && (after.slots.retrievalK?.totalPulls ?? 0) >= 1);
  check(
    "controller.reward advances every slot's pulled arm",
    !!after && !!after.slots.augment && !!after.slots.retrievalK && !!after.slots.multiQuery && !!after.slots.modelProfile,
  );
}
{
  let threw = false;
  try {
    const d = decide(ctx, { augment: false, retrievalK: 8, multiQuery: false, modelProfile: "default" });
    reward(d, ctx, { citationCoverage: 1, webCitationUsed: true, citedCount: 3 });
  } catch {
    threw = true;
  }
  check("controller decide/reward never throw", !threw);
}
{
  const c = buildRetrievalContext("what is the latest price today", [{ score: 0.9 }, { score: 0.5 }], true);
  check(
    "buildRetrievalContext: counts hits, top score, time-sensitive flag",
    c.localHitCount === 2 && c.topLocalScore === 0.9 && c.timeSensitive === true && c.hybridAvailable === true,
  );
}

// ============================================================================
// 3. Reward derivation (pure) — the ACTUAL dense-signal formula the pipeline
// uses (coverage + webCitationUsed) and the augment sharpening branch, which the
// synthetic-outcome tests above never exercise.
// ============================================================================
{
  const webIds = new Set(["w1", "w2"]);
  const o1 = computeControllerOutcome(new Set(["a", "w1"]), 4, webIds);
  check("outcome: coverage = cited/promptHits", Math.abs(o1.citationCoverage - 0.5) < 1e-9 && o1.citedCount === 2);
  check("outcome: webCitationUsed TRUE when a fused web hit is cited", o1.webCitationUsed === true);
  const o2 = computeControllerOutcome(new Set(["a", "b"]), 4, webIds);
  check("outcome: webCitationUsed FALSE when no web hit cited", o2.webCitationUsed === false);
  const o3 = computeControllerOutcome(new Set(), 0, webIds);
  check("outcome: zero prompt hits → coverage 0 (no div-by-zero)", o3.citationCoverage === 0);
}
{
  check("augment reward: augmenting + web CITED → sharpened up to 0.8", augmentSlotReward(true, 0.4, true) === 0.8);
  check("augment reward: augmenting + web NOT cited → sharpened down to 0.3", augmentSlotReward(true, 0.4, false) === 0.3);
  check("augment reward: NOT augmenting → base coverage", augmentSlotReward(false, 0.4, true) === 0.4);
  check("augment reward: strong base + web cited stays high (max)", augmentSlotReward(true, 0.9, true) === 0.9);
}

try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(JSON.stringify({ failures, result: failures === 0 ? "PASS" : "FAIL" }, null, 2));
process.exit(failures === 0 ? 0 : 1);
