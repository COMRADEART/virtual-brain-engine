import { describe, expect, it } from "vitest";
import { KIND_BADGE, KIND_CLASS, pushCognitionEvent, STREAM_CAP, type StreamEntry } from "./cognitionStream";
import { COGNITION_KINDS, type CognitionEvent } from "../../../shared/cognition";

function ev(over: Partial<CognitionEvent> = {}): CognitionEvent {
  return {
    kind: "thought",
    label: "an idle recollection",
    magnitude: 0.4,
    logicalRegions: ["reasoning-cortex"],
    reason: "idle",
    at: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

describe("pushCognitionEvent", () => {
  it("prepends newest first", () => {
    const a = pushCognitionEvent([], ev({ label: "first" }), 1);
    const b = pushCognitionEvent(a, ev({ label: "second", at: "2026-06-01T00:00:01.000Z" }), 2);
    expect(b[0].label).toBe("second");
    expect(b[1].label).toBe("first");
  });

  it("caps the list", () => {
    let list: StreamEntry[] = [];
    for (let i = 0; i < STREAM_CAP + 10; i += 1) {
      list = pushCognitionEvent(list, ev({ label: `t${i}`, at: `2026-06-01T00:00:${String(i % 60).padStart(2, "0")}.${i}Z` }), i);
    }
    expect(list.length).toBe(STREAM_CAP);
    expect(list[0].label).toBe(`t${STREAM_CAP + 9}`);
  });

  it("drops an exact duplicate of the head", () => {
    const a = pushCognitionEvent([], ev(), 1);
    const b = pushCognitionEvent(a, ev(), 2);
    expect(b.length).toBe(1);
  });

  it("keeps a same-label event with a different timestamp", () => {
    const a = pushCognitionEvent([], ev(), 1);
    const b = pushCognitionEvent(a, ev({ at: "2026-06-01T00:00:05.000Z" }), 2);
    expect(b.length).toBe(2);
  });
});

describe("badge maps", () => {
  it("covers every cognition kind", () => {
    for (const kind of COGNITION_KINDS) {
      expect(KIND_BADGE[kind]).toBeTruthy();
      expect(KIND_CLASS[kind]).toBeTruthy();
    }
  });
});
