import { describe, expect, it } from "vitest";
import { summarizeConfirm, confirmScope } from "./confirmSummary";

describe("confirmSummary", () => {
  it("surfaces the write target so approval isn't blind", () => {
    expect(summarizeConfirm("write-file", { path: "C:\\Users\\me\\notes.txt", content: "x" })).toContain("WRITE");
    expect(summarizeConfirm("write-file", { path: "C:\\Users\\me\\notes.txt" })).toContain("notes.txt");
  });

  it("flags web egress for learn-url / web-search / research / github", () => {
    expect(summarizeConfirm("learn-url", { url: "https://example.com/a" })).toContain("example.com");
    expect(summarizeConfirm("learn-url", { url: "https://example.com/a" })).toContain("web egress");
    expect(summarizeConfirm("web-search", { query: "rust async" })).toContain("web egress");
    expect(summarizeConfirm("research-web", { query: "vector dbs" })).toContain("web egress");
    expect(summarizeConfirm("github-learn", { query: "llm agents" })).toContain("web egress");
  });

  it("summarizes git-commit including push + message", () => {
    const s = summarizeConfirm("git-commit", { path: "/repo", message: "fix bug", push: true });
    expect(s).toContain("COMMIT");
    expect(s).toContain("PUSH");
    expect(s).toContain("fix bug");
  });

  it("describes open-path / open-url / scan", () => {
    expect(summarizeConfirm("open-url", { url: "https://x.dev" })).toContain("OPEN");
    expect(summarizeConfirm("trigger-scan", {})).toContain("SCAN");
  });

  it("clips very long values", () => {
    const longPath = "C:\\" + "a".repeat(200);
    expect(summarizeConfirm("write-file", { path: longPath })).toContain("…");
  });

  it("falls back gracefully for an unknown action", () => {
    expect(summarizeConfirm("some-future-action", { path: "/x" })).toContain("/x");
    expect(summarizeConfirm("some-future-action", {})).toContain("some-future-action");
  });

  it("maps risk tiers to human labels", () => {
    expect(confirmScope("write-file", { path: "/x" }, "confirm").riskLabel).toBe("needs approval");
    expect(confirmScope("search-memory", { query: "x" }, "safe").riskLabel).toBe("safe");
  });
});
