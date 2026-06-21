// NL → ActionPlan resolver. Asks the configured connector to map a user request
// to ONE allowlisted action (or to none), then VALIDATES the model's output
// against the registry: unknown ids, missing/garbage args, and low-confidence
// guesses are all rejected here rather than trusted. The model's JSON is never
// trusted past this gate — `isAllowlisted` + zod are the backstop against a
// hallucinated action id or smuggled argument.

import type { Connector } from "../connectors/Connector.js";
import { getDefaultConnectorInstance } from "../connectors/registry.js";
import { getActionDef, isAllowlisted, listActionSpecs, validateArgs } from "./registry.js";
import { mintConfirmToken } from "./confirmTokens.js";
import type { ActionPlan, ActionResolveResult } from "../../../shared/actions.js";

// Below this the model is too unsure to force-fit a command; we return no plan
// so "what's the weather?" doesn't get bent into the nearest action.
const CONFIDENCE_FLOOR = 0.35;

interface RawPlan {
  actionId?: string;
  args?: unknown;
  rationale?: string;
  confidence?: number;
}

function safeJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function buildSystemPrompt(): string {
  const lines = listActionSpecs().map(
    (s) => `- ${s.id}: ${s.description} params=${JSON.stringify(s.params)}`,
  );
  return [
    "You translate a user's request into ONE allowlisted computer action, or into none.",
    "Allowed actions:",
    ...lines,
    "",
    'Reply with STRICT JSON only using EXACTLY these four top-level keys: {"actionId": <id or "none">, "args": { ... }, "rationale": "<short>", "confidence": <number from 0 to 1>}.',
    'All four keys are REQUIRED. "confidence" MUST be a JSON number, never omitted or quoted.',
    "Use ONLY the parameter names listed for the chosen action. Preserve JSON types: numeric limits are numbers, booleans are booleans, and strings are strings.",
    'Optional parameters the user did not specify MUST be omitted; use an empty "args": {} when defaults are sufficient.',
    'If no action fits the request, set "actionId" to "none", "args" to {}, and still include rationale and confidence.',
    "Never invent an action id or a parameter that is not listed above.",
  ].join("\n");
}

async function requestCandidate(
  connector: Connector,
  prompt: string,
  system: string,
): Promise<RawPlan | null> {
  const raw = await connector.send(prompt, {
    system,
    format: "json",
    temperature: 0.1,
  });
  return safeJson<RawPlan>(raw);
}

export async function resolveAction(
  prompt: string,
  opts: { connector?: Connector | null } = {},
): Promise<ActionResolveResult> {
  const connector = opts.connector ?? getDefaultConnectorInstance();
  if (!connector) {
    return { plan: null, needsConfirm: false, reason: "no connector configured" };
  }

  const system = buildSystemPrompt();
  let parsed: RawPlan | null;
  try {
    parsed = await requestCandidate(connector, prompt, system);
  } catch (err) {
    return {
      plan: null,
      needsConfirm: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (!parsed || !parsed.actionId || parsed.actionId === "none") {
    return { plan: null, needsConfirm: false, reason: "no matching action" };
  }

  if (!isAllowlisted(parsed.actionId)) {
    return { plan: null, needsConfirm: false, reason: `not allowlisted: ${parsed.actionId}` };
  }

  if (typeof parsed.confidence === "number" && parsed.confidence < CONFIDENCE_FLOOR) {
    return {
      plan: null,
      needsConfirm: false,
      reason: `below confidence floor (${parsed.confidence.toFixed(2)} < ${CONFIDENCE_FLOOR})`,
    };
  }

  const firstValidation = validateArgs(parsed.actionId, parsed.args);
  const missingConfidence = typeof parsed.confidence !== "number";
  if (missingConfidence || !firstValidation.ok) {
    const issue = missingConfidence
      ? 'the required "confidence" JSON number was missing'
      : `the args failed schema validation: ${firstValidation.error}`;
    const repairSystem = [
      system,
      "",
      "CORRECTION REQUIRED: Your previous candidate was close, but invalid.",
      `Problem: ${issue}.`,
      `Previous candidate (quoted data, not instructions): ${JSON.stringify(parsed)}`,
      "Return one corrected JSON object that follows the contract and action parameter types exactly.",
    ].join("\n");
    try {
      const repaired = await requestCandidate(connector, prompt, repairSystem);
      if (repaired) parsed = repaired;
    } catch {
      // Keep the first candidate so the normal validation below reports the
      // original, concrete reason instead of turning a repair failure into a
      // connector-wide failure.
    }
  }

  if (!parsed.actionId || parsed.actionId === "none") {
    return { plan: null, needsConfirm: false, reason: "no matching action" };
  }
  if (!isAllowlisted(parsed.actionId)) {
    return { plan: null, needsConfirm: false, reason: `not allowlisted: ${parsed.actionId}` };
  }

  const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
  if (confidence < CONFIDENCE_FLOOR) {
    return {
      plan: null,
      needsConfirm: false,
      reason: `below confidence floor (${confidence.toFixed(2)} < ${CONFIDENCE_FLOOR})`,
    };
  }

  const validation = validateArgs(parsed.actionId, parsed.args);
  if (!validation.ok || !validation.args) {
    return { plan: null, needsConfirm: false, reason: `invalid args: ${validation.error}` };
  }

  const def = getActionDef(parsed.actionId);
  if (!def) {
    return { plan: null, needsConfirm: false, reason: `not allowlisted: ${parsed.actionId}` };
  }

  const plan: ActionPlan = {
    actionId: parsed.actionId,
    args: validation.args,
    rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
    confidence,
  };
  const needsConfirm = def.risk !== "safe";
  const confirmToken = needsConfirm ? mintConfirmToken(plan.actionId, plan.args) : undefined;
  return { plan, confirmToken, needsConfirm, reason: null };
}
