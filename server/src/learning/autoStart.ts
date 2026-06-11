// Boot-time auto-training. Two independent paths, each behind its own flag:
//
//   - the from-scratch brain LLM (worker/train — char-level GPT on the memory
//     corpus; CONFIG.autoStartScratchLlm, DEFAULT ON). "The brain grows its own
//     model when the app starts." Progress streams to the UI's TrainingBar via
//     the llm-training bus message (ensureLlmTrainingWatcher).
//   - the LoRA own-model pass (worker/finetune; CONFIG.autoStartOwnModel,
//     opt-in — compute-heavy).
//
// Both are fire-and-forget, failure-isolated, and degrade silently when the
// Python worker is down (CI / the bundled desktop app, which doesn't ship the
// worker). Rate-limited via brain_metadata timestamps so tsx-watch restarts
// don't retrain in a loop.

import { openDb } from "../db/sqlite.js";
import { getOwnModelStatus, startOwnModelTraining } from "./ownModelClient.js";
import {
  getLlmTrainerStatus,
  startLlmTraining,
  ensureLlmTrainingWatcher,
} from "./llmTrainerClient.js";
import { CONFIG } from "../config.js";

const LAST_TRAINED_KEY = "own_model_last_trained_at";
const SCRATCH_LAST_TRAINED_KEY = "scratch_llm_last_trained_at";

function readMeta(key: string): string | null {
  const row = openDb().prepare("SELECT value FROM brain_metadata WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function writeMeta(key: string, value: string): void {
  openDb()
    .prepare(
      "INSERT INTO brain_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

// The trainable corpus size, measured DB-side. (The worker's status.corpusChars
// is null until a run has happened, so reading it pre-train always saw 0 and
// auto-train never fired — the original bug.)
function corpusCharsInDb(): number {
  const row = openDb()
    .prepare("SELECT COALESCE(SUM(LENGTH(content)), 0) AS chars FROM memory_points")
    .get() as { chars: number };
  return row.chars;
}

/** Pure skip-decision for the boot auto-train — exported for the selfcheck. */
export function autoTrainSkipReason(input: {
  enabled: boolean;
  workerState: string;
  lastTrainedAtMs: number | null;
  nowMs: number;
  minIntervalMs: number;
  corpusChars: number;
  minCorpusChars: number;
}): string | null {
  if (!input.enabled) return "disabled";
  if (input.workerState === "unavailable") return "worker down";
  if (input.workerState === "running" || input.workerState === "merging") return "already running";
  if (input.lastTrainedAtMs !== null && input.nowMs - input.lastTrainedAtMs < input.minIntervalMs) {
    return "trained recently";
  }
  if (input.corpusChars < input.minCorpusChars) return "corpus too small";
  return null;
}

/** Boot auto-train for the from-scratch brain LLM (default on). */
export async function checkAndStartScratchLlmTraining(): Promise<void> {
  const status = await getLlmTrainerStatus();
  const last = readMeta(SCRATCH_LAST_TRAINED_KEY);
  const skip = autoTrainSkipReason({
    enabled: CONFIG.autoStartScratchLlm,
    workerState: status.state,
    lastTrainedAtMs: last ? Number(last) : null,
    nowMs: Date.now(),
    minIntervalMs: CONFIG.autoStartMinIntervalMs,
    corpusChars: corpusCharsInDb(),
    minCorpusChars: CONFIG.autoStartMinCorpusChars,
  });
  if (skip) {
    if (skip === "already running") ensureLlmTrainingWatcher();
    console.log(`[auto-train:scratch] skipped — ${skip}`);
    return;
  }

  console.log(`[auto-train:scratch] training the brain's own model (corpus: ${corpusCharsInDb()} chars)…`);
  // force only clears a STALE "running" left by a dead thread — the worker
  // never preempts a live run.
  const result = await startLlmTraining({ force: true });
  if (result.state === "running") {
    writeMeta(SCRATCH_LAST_TRAINED_KEY, String(Date.now()));
    ensureLlmTrainingWatcher();
    console.log("[auto-train:scratch] training started — progress on the llm-training bus event");
  } else {
    console.warn(`[auto-train:scratch] did not start: state=${result.state} (${result.message ?? "no message"})`);
  }
}

/** Boot auto-train for the LoRA own-model pass (opt-in). */
export async function checkAndStartOwnModelTraining(): Promise<void> {
  if (!CONFIG.autoStartOwnModel) return;

  const status = await getOwnModelStatus();

  if (status.state !== "idle" && status.state !== "done" && status.state !== "error") {
    console.log(
      `[auto-train] skipped — trainer is "${status.state}" (message: ${status.message ?? "none"})`,
    );
    return;
  }

  const lastTrained = readMeta(LAST_TRAINED_KEY);
  if (lastTrained) {
    const elapsed = Date.now() - Number(lastTrained);
    if (elapsed < CONFIG.autoStartMinIntervalMs) {
      const remaining = CONFIG.autoStartMinIntervalMs - elapsed;
      const hrs = Math.ceil(remaining / 3_600_000);
      console.log(`[auto-train] skipped — last run ${Math.floor(elapsed / 3_600_000)}h ago, wait ~${hrs}h (min interval ${CONFIG.autoStartMinIntervalMs}ms)`);
      return;
    }
  }

  const corpusChars = corpusCharsInDb();
  if (corpusChars < CONFIG.autoStartMinCorpusChars) {
    console.log(
      `[auto-train] skipped — corpus ${corpusChars} chars < minimum ${CONFIG.autoStartMinCorpusChars} chars. Use the brain more, then reboot.`,
    );
    return;
  }

  console.log(`[auto-train] starting own-model training (corpus: ${corpusChars} chars)…`);
  const result = await startOwnModelTraining({});

  if (result.state === "running" || result.state === "merging") {
    writeMeta(LAST_TRAINED_KEY, String(Date.now()));
    console.log(
      `[auto-train] training started — poll status at GET /api/learning/ownmodel/status`,
    );
  } else if (result.state === "error") {
    console.warn(`[auto-train] training error: ${result.message}`);
  } else {
    console.log(`[auto-train] unexpected state after start: "${result.state}"`);
  }
}
