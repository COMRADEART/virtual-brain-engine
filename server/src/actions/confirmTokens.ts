// One-time, plan-bound confirm tokens for confirm-tier actions.
//
// What this buys (and what it does NOT): it enforces resolve-before-execute,
// plan integrity (a token authorises EXACTLY the actionId+args it was minted
// for), and single use. It does NOT by itself prove a human saw the plan — the
// UI confirm card owns that. So `action_log.confirmed = true` means "a valid
// plan-bound token was presented", not "a human approved". That's the right
// guarantee for a trusted, local, single-user app; don't over-read it.
//
// In-memory by design: tokens are short-lived (5 min) and need not survive a
// restart — a restart simply invalidates outstanding confirmations, which is the
// safe direction.

import { randomBytes, createHash } from "node:crypto";

const TTL_MS = 5 * 60_000;

interface Entry {
  planHash: string;
  expiresAt: number;
}

const store = new Map<string, Entry>();

// Binds a token to the EXACT actionId + args being approved, so a token minted
// for plan A cannot authorise a substituted plan B.
export function planHash(actionId: string, args: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify({ actionId, args }))
    .digest("hex");
}

function sweep(now: number): void {
  for (const [token, entry] of store) {
    if (entry.expiresAt <= now) {
      store.delete(token);
    }
  }
}

export function mintConfirmToken(actionId: string, args: Record<string, unknown>): string {
  const now = Date.now();
  sweep(now);
  const token = randomBytes(18).toString("hex");
  store.set(token, { planHash: planHash(actionId, args), expiresAt: now + TTL_MS });
  return token;
}

// Returns true ONLY if the token exists, is unexpired, and was minted for
// exactly this plan — and consumes it (single use) on a match. A mismatch does
// NOT consume the token, so a legitimate confirmation can still follow a
// mistaken attempt for a different plan.
export function consumeConfirmToken(
  token: string,
  actionId: string,
  args: Record<string, unknown>,
): boolean {
  const now = Date.now();
  sweep(now);
  const entry = store.get(token);
  if (!entry) {
    return false;
  }
  if (entry.expiresAt <= now) {
    store.delete(token);
    return false;
  }
  if (entry.planHash !== planHash(actionId, args)) {
    return false;
  }
  store.delete(token);
  return true;
}

// Test/selfcheck seam.
export function _resetConfirmTokens(): void {
  store.clear();
}
