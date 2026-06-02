// Phase 1 selfcheck — pure desktop-pet mood mapping.
//
// Pure module: petMood has no DOM/DB/network deps, so the colour/label
// totality and the agent-state-over-personality override are testable as
// plain functions. Picked up by `npm run test:unit`, which the gate runs.

import { describe, expect, it } from "vitest";
import { MOODS, MOOD_COLOR, MOOD_LABEL, moodFor } from "./petMood";
import type { PersonalityState } from "../../../shared/phase2";

const focused = { mood: "focused" } as PersonalityState;

describe("petMood maps (totality)", () => {
  it("has a hex colour and a non-empty label for every mood", () => {
    for (const mood of MOODS) {
      expect(MOOD_COLOR[mood]).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(MOOD_LABEL[mood].length).toBeGreaterThan(0);
    }
  });

  it("has no keys beyond the declared union", () => {
    const known = new Set<string>(MOODS);
    expect(Object.keys(MOOD_COLOR).every((k) => known.has(k))).toBe(true);
    expect(Object.keys(MOOD_LABEL).every((k) => known.has(k))).toBe(true);
  });
});

describe("moodFor (agent state overrides personality)", () => {
  it("lets live agent states win over the personality mood", () => {
    expect(moodFor("thinking", focused)).toBe("thinking");
    expect(moodFor("acting", focused)).toBe("acting");
    expect(moodFor("error", focused)).toBe("error");
  });

  it("falls back to personality mood, then idle", () => {
    expect(moodFor("idle", focused)).toBe("focused");
    expect(moodFor(null, focused)).toBe("focused");
    expect(moodFor(null, null)).toBe("idle");
  });

  it("only ever returns a known mood", () => {
    for (const state of ["thinking", "acting", "error", "idle", "init", "stopped", null] as const) {
      expect(MOODS).toContain(moodFor(state, null));
    }
  });
});
