import { describe, expect, it } from "vitest";
import { DEFAULT_HOTWORDS, isLoudEnough, matchHotword } from "./listenerMatch";

describe("listenerMatch / matchHotword", () => {
  it("matches a bare 'brain' followed by a question", () => {
    const m = matchHotword("brain what time is it", DEFAULT_HOTWORDS);
    expect(m).not.toBeNull();
    expect(m!.prompt).toBe("what time is it");
    expect(m!.hotword).toBe("brain");
  });

  it("matches 'hey brain' as a single phrase", () => {
    const m = matchHotword("hey brain, can you open chrome", DEFAULT_HOTWORDS);
    expect(m).not.toBeNull();
    expect(m!.prompt).toBe("can you open chrome");
    expect(m!.hotword).toBe("hey brain");
  });

  it("matches 'friday' as the alternate persona", () => {
    const m = matchHotword("friday run my tests", DEFAULT_HOTWORDS);
    expect(m).not.toBeNull();
    expect(m!.prompt).toBe("run my tests");
    expect(m!.hotword).toBe("friday");
  });

  it("preserves a preceding filler ('ok brain')", () => {
    const m = matchHotword("uh, ok brain, summarize that file", DEFAULT_HOTWORDS);
    expect(m).not.toBeNull();
    expect(m!.prompt).toBe("uh summarize that file");
  });

  it("is case-insensitive", () => {
    const m = matchHotword("BRAIN, what's the weather", DEFAULT_HOTWORDS);
    expect(m).not.toBeNull();
    expect(m!.prompt).toBe("what's the weather");
    expect(m!.hotword).toBe("brain");
  });

  it("returns null when no hotword is present", () => {
    expect(matchHotword("what time is it", DEFAULT_HOTWORDS)).toBeNull();
    expect(matchHotword("I love pizza and sunshine", DEFAULT_HOTWORDS)).toBeNull();
  });

  it("DOES match 'brain' when it appears in natural English", () => {
    // Word-boundary rule: 'brain' inside 'brainstorming' is NOT a match,
    // but 'brain' as a standalone word IS (a user saying "brain, what's
    // the weather" is the canonical case).
    const m = matchHotword("brain what time is it", DEFAULT_HOTWORDS);
    expect(m).not.toBeNull();
    expect(m!.hotword).toBe("brain");
  });

  it("returns null when the transcript is just a hotword with no follow-on", () => {
    expect(matchHotword("brain", DEFAULT_HOTWORDS)).toBeNull();
    expect(matchHotword("hey brain", DEFAULT_HOTWORDS)).toBeNull();
  });

  it("returns null on empty / whitespace-only input", () => {
    expect(matchHotword("", DEFAULT_HOTWORDS)).toBeNull();
    expect(matchHotword("   ", DEFAULT_HOTWORDS)).toBeNull();
  });

  it("matches the longest hotword first ('hey brain' beats 'brain')", () => {
    const m = matchHotword("hey brain what time is it", ["brain", "hey brain"]);
    expect(m!.hotword).toBe("hey brain");
  });

  it("accepts a custom hotword list", () => {
    const m = matchHotword("computer, run my tests", ["computer"]);
    expect(m).not.toBeNull();
    expect(m!.prompt).toBe("run my tests");
    // And ignores the default list when a custom one is given
    expect(matchHotword("brain run my tests", ["computer"])).toBeNull();
  });

  it("does NOT match 'brain' inside a longer word (word-boundary works)", () => {
    expect(matchHotword("brainstorming time", DEFAULT_HOTWORDS)).toBeNull();
  });

  it("trims trailing punctuation after the hotword", () => {
    const m = matchHotword("brain: open the file", DEFAULT_HOTWORDS);
    expect(m).not.toBeNull();
    expect(m!.prompt).toBe("open the file");
  });
});

describe("listenerMatch / isLoudEnough", () => {
  it("rejects empty / whitespace-only transcripts", () => {
    expect(isLoudEnough("")).toBe(false);
    expect(isLoudEnough("   ")).toBe(false);
    expect(isLoudEnough("\n\t  \n")).toBe(false);
  });

  it("accepts transcripts with content (any length, even single char)", () => {
    expect(isLoudEnough("a")).toBe(true);
    expect(isLoudEnough("ok")).toBe(true);
    expect(isLoudEnough("brain, what time")).toBe(true);
  });
});
