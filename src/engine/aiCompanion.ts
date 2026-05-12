// AI roles built on top of the Ollama client. Three entry points:
//   - pickAction      → free text → BrainActionId
//   - generateTour    → produce a short scripted sequence of actions
//   - streamChatTurn  → free-form chat with the visualization context
//
// All three feed off the same source-of-truth list of BRAIN_ACTIONS so the
// prompts can't drift when the action set changes.

import { BRAIN_ACTIONS } from "../data/regionDefinitions";
import type { BrainActionId } from "./types";
import { chatJson, chatStream, type OllamaMessage } from "./ollamaClient";

const ACTION_LINES = BRAIN_ACTIONS.map(
  (action) => `- ${action.id}: ${action.label} — ${action.description}`,
).join("\n");

const VALID_ACTION_IDS = new Set(BRAIN_ACTIONS.map((action) => action.id));

function coerceActionId(candidate: unknown, fallback: BrainActionId): BrainActionId {
  if (typeof candidate === "string" && VALID_ACTION_IDS.has(candidate as BrainActionId)) {
    return candidate as BrainActionId;
  }
  // Surface a console warning so a model that consistently returns wrong-shape
  // JSON doesn't silently look like "lift-hand always fires".
  console.warn("aiCompanion: model returned invalid action id, falling back", { candidate, fallback });
  return fallback;
}

export interface ActionPick {
  action: BrainActionId;
  why: string;
}

// Map a free-form user message to one of the BRAIN_ACTIONS using format:"json".
export async function pickAction(
  input: string,
  model: string,
  signal?: AbortSignal,
): Promise<ActionPick> {
  const system: OllamaMessage = {
    role: "system",
    content: [
      "You classify a user message into exactly one brain action from this list:",
      ACTION_LINES,
      "",
      'Respond with valid JSON only, no prose: {"action": "<exact-action-id>", "why": "<1 short sentence>"}',
      "Pick the single best fit. Use the exact action id, lowercased, with hyphens.",
    ].join("\n"),
  };

  const messages: OllamaMessage[] = [system, { role: "user", content: input }];
  const raw = await chatJson<{ action?: string; why?: string }>({
    model,
    messages,
    signal,
    options: { temperature: 0.2 },
  });

  return {
    action: coerceActionId(raw.action, BRAIN_ACTIONS[0].id),
    why: typeof raw.why === "string" && raw.why.trim().length > 0 ? raw.why.trim() : "Best match for that prompt.",
  };
}

export interface TourStep {
  action: BrainActionId;
  narration: string;
}

// Stream a scripted tour as NDJSON. Fires onStep for each step the moment its
// JSON line is parsed, so the UI can light up the brain mid-generation instead
// of waiting for the full script. Returns the final list (may be empty if the
// model produces no valid lines — caller should fall back to generateTour).
export async function streamTour(
  model: string,
  onStep: (step: TourStep) => void,
  signal?: AbortSignal,
  stepCount = 4,
): Promise<TourStep[]> {
  const steps: TourStep[] = [];

  const emit = (entry: { action?: unknown; narration?: unknown }): void => {
    if (typeof entry.action !== "string") {
      return;
    }
    const step: TourStep = {
      action: coerceActionId(entry.action, BRAIN_ACTIONS[0].id),
      narration:
        typeof entry.narration === "string" && entry.narration.trim().length > 0
          ? entry.narration.trim()
          : "Watch the active pathway light up.",
    };
    steps.push(step);
    onStep(step);
  };

  const flushLine = (line: string): void => {
    const cleaned = line.trim().replace(/^,\s*/, "").replace(/,\s*$/, "");
    if (!cleaned || !cleaned.startsWith("{")) {
      return;
    }
    try {
      emit(JSON.parse(cleaned) as { action?: unknown; narration?: unknown });
    } catch {
      // Malformed line — skip silently. The end-of-stream fallback path
      // handles cases where the model emits an array instead of NDJSON.
    }
  };

  const system: OllamaMessage = {
    role: "system",
    content: [
      `You are a narrator scripting a ${stepCount}-step guided tour of brain activations.`,
      "Pick distinct actions from this list, ordered for narrative flow (e.g. perception → cognition → motor output):",
      ACTION_LINES,
      "",
      `Output ${stepCount} lines total. Each line is one standalone JSON object with no surrounding array or markdown:`,
      `{"action":"<exact-action-id>","narration":"<1 sentence, second person, under 30 words>"}`,
      "Put each JSON object on its OWN LINE separated by a newline. Do not output anything else.",
    ].join("\n"),
  };

  let buffer = "";
  let allText = "";
  await chatStream({
    model,
    messages: [system, { role: "user", content: "Generate the tour." }],
    signal,
    onToken: (token) => {
      allText += token;
      buffer += token;
      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx >= 0) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        flushLine(line);
        newlineIdx = buffer.indexOf("\n");
      }
    },
    options: { temperature: 0.6 },
  });
  if (buffer.trim()) {
    flushLine(buffer);
  }

  // Forgiveness path: small models often ignore the NDJSON directive and emit
  // a single-line JSON array, or wrap the output in markdown fences, or in a
  // `{"steps":[...]}` envelope. If NDJSON yielded nothing, try those shapes.
  if (steps.length === 0 && allText.trim().length > 0) {
    const stripped = allText
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```$/i, "")
      .trim();
    try {
      const parsed: unknown = JSON.parse(stripped);
      const candidates: unknown[] = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { steps?: unknown[] })?.steps)
          ? (parsed as { steps: unknown[] }).steps
          : [];
      for (const entry of candidates) {
        if (entry && typeof entry === "object") {
          emit(entry as { action?: unknown; narration?: unknown });
        }
      }
    } catch {
      // Fully malformed — return empty; caller falls back to generateTour.
    }
  }

  return steps;
}

// Produce a short scripted tour. The caller sequences the steps with timing.
export async function generateTour(
  model: string,
  signal?: AbortSignal,
  stepCount = 4,
): Promise<TourStep[]> {
  const system: OllamaMessage = {
    role: "system",
    content: [
      `You are a narrator scripting a ${stepCount}-step guided tour of brain activations.`,
      "Pick distinct actions from this list, ordered for narrative flow (e.g. perception → cognition → motor output):",
      ACTION_LINES,
      "",
      `Respond with valid JSON only: {"steps": [{"action": "<action-id>", "narration": "<1-2 sentences in second person>"}, ...]}`,
      `Exactly ${stepCount} steps. Use exact action ids. Keep each narration under 30 words.`,
    ].join("\n"),
  };

  const raw = await chatJson<{ steps?: Array<{ action?: string; narration?: string }> }>({
    model,
    messages: [system, { role: "user", content: "Generate the tour." }],
    signal,
    options: { temperature: 0.6 },
  });

  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  return steps.slice(0, stepCount).map((step) => ({
    action: coerceActionId(step.action, BRAIN_ACTIONS[0].id),
    narration:
      typeof step.narration === "string" && step.narration.trim().length > 0
        ? step.narration.trim()
        : "Watch the active pathway light up.",
  }));
}

const CHAT_SYSTEM = [
  "You are an assistant embedded in a 3D anatomical brain visualization.",
  "The user can trigger any of these brain actions and watch the relevant regions and pathways light up:",
  ACTION_LINES,
  "",
  "Be concise (2-3 sentences). When a user's question relates to function, suggest a specific action they could try.",
  "Do not invent action ids that aren't in the list above.",
].join("\n");

// Stream a chat turn. The caller passes the conversation so we don't keep
// history state here — the panel owns it.
export async function streamChatTurn(
  history: OllamaMessage[],
  model: string,
  onToken: (token: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const messages: OllamaMessage[] = [{ role: "system", content: CHAT_SYSTEM }, ...history];
  return chatStream({
    model,
    messages,
    signal,
    onToken,
    options: { temperature: 0.7 },
  });
}
