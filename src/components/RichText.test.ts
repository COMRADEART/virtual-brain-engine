import { describe, expect, it } from "vitest";
import { splitCitations } from "./RichText";

describe("splitCitations", () => {
  it("returns a single text part when there are no markers", () => {
    expect(splitCitations("just plain text")).toEqual([{ kind: "text", value: "just plain text" }]);
  });

  it("splits a marker into leading text + cite", () => {
    const parts = splitCitations("Known memory: [m:abc123] the rest");
    expect(parts).toEqual([
      { kind: "text", value: "Known memory: " },
      { kind: "cite", value: "abc123" },
      { kind: "text", value: " the rest" },
    ]);
  });

  it("handles a leading marker (no preceding text)", () => {
    const parts = splitCitations("[m:abc123] then text");
    expect(parts[0]).toEqual({ kind: "cite", value: "abc123" });
    expect(parts[1]).toEqual({ kind: "text", value: " then text" });
  });

  it("handles a trailing marker (no following text)", () => {
    const parts = splitCitations("text [m:abc123]");
    expect(parts[parts.length - 2]).toEqual({ kind: "text", value: "text " });
    expect(parts[parts.length - 1]).toEqual({ kind: "cite", value: "abc123" });
  });

  it("emits multiple adjacent cites as separate parts", () => {
    const parts = splitCitations("[m:a][m:b][m:c]");
    expect(parts.filter((p) => p.kind === "cite").map((p) => p.value)).toEqual(["a", "b", "c"]);
  });

  it("preserves the full id so the renderer can slice(-6) the chip label", () => {
    const parts = splitCitations("[m:01ABCDEFGH]");
    expect(parts.find((p) => p.kind === "cite")?.value).toBe("01ABCDEFGH");
    // the chip renders `m:` + value.slice(-6) → matches the last 6 chars only
    const id = parts.find((p) => p.kind === "cite")!.value;
    expect(id.slice(-6)).toBe("CDEFGH"); // "01ABCDEFGH"[-6:]
  });

  it("ignores bracket-looking text that isn't a citation marker", () => {
    const parts = splitCitations("see [m: x] and [note] and [m:abc]");
    const cites = parts.filter((p) => p.kind === "cite").map((p) => p.value);
    expect(cites).toEqual(["abc"]); // [m: x] (space) and [note] are NOT markers
  });
});