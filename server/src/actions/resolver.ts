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
    'Reply with STRICT JSON only: {"actionId": <id or "none">, "args": { ... }, "rationale": "<short>", "confidence": <0..1>}.',
    'Use ONLY the parameter names listed for the chosen action. If no action fits the request, set "actionId" to "none".',
    "Never invent an action id or a parameter that is not listed above.",
  ].join("\n");
}

export async function resolveAction(
  prompt: string,
  opts: { connector?: Connector | null } = {},
): Promise<ActionResolveResult> {
  const connector = opts.connector ?? getDefaultConnectorInstance();
  if (!connector) {
    return { plan: null, needsConfirm: false, reason: "no connector configured" };
  }

  let raw: string;
  try {
    raw = await connector.send(prompt, {
      system: buildSystemPrompt(),
      format: "json",
      temperature: 0.1,
    });
  } catch (err) {
    return {
      plan: null,
      needsConfirm: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const parsed = safeJson<RawPlan>(raw);
  if (!parsed || !parsed.actionId || parsed.actionId === "none") {
    return { plan: null, needsConfirm: false, reason: "no matching action" };
  }

  const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
  if (confidence < CONFIDENCE_FLOOR) {
    return {
      plan: null,
      needsConfirm: false,
      reason: `below confidence floor (${confidence.toFixed(2)} < ${CONFIDENCE_FLOOR})`,
    };
  }

  if (!isAllowlisted(parsed.actionId)) {
    return { plan: null, needsConfirm: false, reason: `not allowlisted: ${parsed.actionId}` };
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
