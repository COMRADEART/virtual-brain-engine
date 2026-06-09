import { describe, expect, it } from "vitest";
import { appendExchange, updateLastAnswer, MAX_EXCHANGES, type Exchange } from "./chatHistory";

function ex(q: string, a = ""): Exchange {
  return { question: q, answer: a };
}

describe("chatHistory", () => {
  it("appends a new exchange immutably", () => {
    const a = [ex("q1", "a1")];
    const b = appendExchange(a, ex("q2"));
    expect(b).toHaveLength(2);
    expect(b[1]).toEqual(ex("q2"));
    expect(a).toHaveLength(1); // original untouched
  });

  it("caps at MAX_EXCHANGES, dropping the oldest", () => {
    let list: Exchange[] = [];
    for (let i = 0; i < MAX_EXCHANGES + 5; i++) list = appendExchange(list, ex(`q${i}`));
    expect(list).toHaveLength(MAX_EXCHANGES);
    // Oldest (q0..q4) trimmed; the most-recent is kept.
    expect(list[0].question).toBe(`q5`);
    expect(list[list.length - 1].question).toBe(`q${MAX_EXCHANGES + 4}`);
  });

  it("respects a custom cap", () => {
    let list: Exchange[] = [];
    for (let i = 0; i < 10; i++) list = appendExchange(list, ex(`q${i}`), 3);
    expect(list).toHaveLength(3);
    expect(list.map((e) => e.question)).toEqual(["q7", "q8", "q9"]);
  });

  it("updates only the last answer (streaming) immutably", () => {
    const a = [ex("q1", "a1"), ex("q2", "")];
    const b = updateLastAnswer(a, "streaming…");
    expect(b[1].answer).toBe("streaming…");
    expect(b[0]).toBe(a[0]); // earlier turns shared by reference (no needless copies)
    expect(a[1].answer).toBe(""); // original untouched
  });

  it("updateLastAnswer is a safe no-op on an empty list", () => {
    expect(updateLastAnswer([], "x")).toEqual([]);
  });
});
