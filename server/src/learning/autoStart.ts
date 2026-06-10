import { openDb } from "../db/sqlite.js";
import { getOwnModelStatus, startOwnModelTraining } from "./ownModelClient.js";
import { CONFIG } from "../config.js";

const LAST_TRAINED_KEY = "own_model_last_trained_at";

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

export async function checkAndStartOwnModelTraining(): Promise<void> {
  if (!CONFIG.autoStartOwnModel) return;

  const status = await getOwnModelStatus();

  if (status.state !== "idle") {
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

  const corpusChars = status.corpusChars ?? 0;
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