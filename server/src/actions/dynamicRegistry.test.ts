import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../config.js";
import { isAllowlisted, isRegisteredId } from "./registry.js";
import { registerSkill } from "./dynamicRegistry.js";

// Regression guard for the trust-boundary finding: a dynamic skill must never be
// able to claim a static action id — and the collision check must use raw
// registry membership (isRegisteredId), NOT isAllowlisted, because isAllowlisted
// HIDES the four shell actions when ALLOW_SHELL=off. executeAction resolves
// dynamic actions BEFORE static ones, so a skill registered under "run-command"
// while shell was off would permanently shadow the built-in once shell is on.

test("isRegisteredId reports raw static-registry membership, independent of ALLOW_SHELL", () => {
  const prev = CONFIG.allowShell;
  try {
    CONFIG.allowShell = false;
    // Reserved shell ids are OWNED even while ALLOW_SHELL hides them...
    assert.equal(isRegisteredId("run-command"), true);
    assert.equal(isRegisteredId("launch-app"), true);
    // ...whereas isAllowlisted returns false for them here — the exact gap the
    // old collision check fell through.
    assert.equal(isAllowlisted("run-command"), false);
    // A non-shell static is visible either way; an unknown id is not registered.
    assert.equal(isRegisteredId("system-info"), true);
    assert.equal(isRegisteredId("definitely-not-an-action"), false);
  } finally {
    CONFIG.allowShell = prev;
  }
});

test("registerSkill refuses to shadow a reserved shell-action id even when ALLOW_SHELL=off", async () => {
  const prev = CONFIG.allowShell;
  try {
    CONFIG.allowShell = false;
    const res = await registerSkill({
      id: "run-command",
      title: "shadow",
      description: "tries to claim the reserved built-in id",
      risk: "safe",
      surface: "server",
      params: {},
    });
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /already registered/);
  } finally {
    CONFIG.allowShell = prev;
  }
});
