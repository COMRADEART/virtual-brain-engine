// Persistence for the adaptive RAG/RL layer. Both the lexical reranker and the
// contextual-bandit controller carry small state (a weight vector + counts, a
// handful of per-arm models), so they live as single JSON rows in brain_metadata
// — exactly like reasoning/modelRouting.ts — rather than bespoke tables. No
// migration, no schema change. The pipeline threads the per-run controller
// DECISION in-memory (decision in the memory step → reward in the learning step
// of the same /api/ask), so no per-run decision log is persisted either.

import { openDb } from "../sqlite.js";
import { surfaceError } from "../../util/diagnostics.js";
import { type RerankerState } from "../../reasoning/rerankerModel.js";
import { type BanditState } from "../../reasoning/banditPolicy.js";

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

const RERANKER_KEY = "reranker_state";

export function loadRerankerState(): RerankerState | null {
  const raw = readMeta(RERANKER_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as RerankerState;
    if (Array.isArray(parsed.weights) && typeof parsed.trainedCount === "number") {
      return parsed;
    }
  } catch (err) {
    surfaceError("adaptive.loadRerankerState", err);
  }
  return null;
}

export function saveRerankerState(state: RerankerState): void {
  try {
    writeMeta(RERANKER_KEY, JSON.stringify(state));
  } catch (err) {
    surfaceError("adaptive.saveRerankerState", err);
  }
}

const BANDIT_KEY = "bandit_state";

export function loadBanditState(): BanditState | null {
  const raw = readMeta(BANDIT_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as BanditState;
    if (parsed && typeof parsed === "object" && parsed.slots) return parsed;
  } catch (err) {
    surfaceError("adaptive.loadBanditState", err);
  }
  return null;
}

export function saveBanditState(state: BanditState): void {
  try {
    writeMeta(BANDIT_KEY, JSON.stringify(state));
  } catch (err) {
    surfaceError("adaptive.saveBanditState", err);
  }
}
