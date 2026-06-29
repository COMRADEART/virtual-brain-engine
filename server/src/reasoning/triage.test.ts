import { test } from "node:test";
import assert from "node:assert/strict";
import { triage } from "./triage.js";

test("plain short questions short-circuit to the pipeline", () => {
  for (const q of [
    "what is recursion?",
    "how does a hash map work?",
    "explain closures",
    "is the sky blue?",
    "define entropy",
    "tell me about TCP",
  ]) {
    assert.equal(triage(q), "pipeline", q);
  }
});

test("explicit action signals route to the loop", () => {
  for (const q of ["run the tests", "create a new file", "fix the failing test", "deploy the app"]) {
    assert.equal(triage(q), "loop", q);
  }
});

test("URLs and file paths route to the loop even when phrased as a question", () => {
  assert.equal(triage("what's at https://example.com?"), "loop");
  assert.equal(triage("summarize C:\\Users\\me\\notes.md"), "loop");
});

test("the loop bias wins: a question that also asks for an action goes to the loop", () => {
  // "run " is an action signal — it must override the question shape.
  assert.equal(triage("how do I run the build?"), "loop");
});

test("long or multi-line inputs fall through to the loop", () => {
  assert.equal(triage("what is x? ".repeat(40)), "loop", "over the 240-char single-clause cap");
  assert.equal(triage("what is this?\nand also that?"), "loop", "multi-line");
});

test("ambiguous non-question input defaults to the loop (it can still just answer)", () => {
  assert.equal(triage("the quarterly numbers"), "loop");
});
