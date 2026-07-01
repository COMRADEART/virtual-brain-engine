// Voice subsystem selfcheck — hermetic (worker pointed at an unreachable port,
// no synthesis, no network egress, throwaway DB). The voice subsystem was the
// only one in the repo without a selfcheck.
//
// Run: npm --prefix server run voice:selfcheck
//
// Asserts:
//   (A) validateSpeakText (PURE): empty / whitespace / over-length reject;
//       a valid string passes and is trimmed; MAX_SPEAK_CHARS is the boundary.
//   (B) Worker-down DEGRADE: speak() returns a structured { ok:false } instead
//       of throwing when the worker is unreachable.
//   (C) Cheap status: voiceStatus() reports "unavailable" WITHOUT synthesizing
//       (the old path triggered a full Bark load and could falsely time out).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

// Point the worker at an unreachable port BEFORE importing the client (it reads
// the env at module load). Throwaway DB dir for any diagnostics side-effects.
const tmp = mkdtempSync(join(tmpdir(), "brain-voice-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");
process.env.PERCEPTION_WORKER_URL = "http://127.0.0.1:1"; // refused fast

const { validateSpeakText, voiceStatus, speak, MAX_SPEAK_CHARS } = await import(
  "../src/voice/voiceClient.js"
);
const { computeLocality } = await import("../src/util/locality.js");

// -----------------------------------------------------------------------------
// (A) validateSpeakText — pure.
// -----------------------------------------------------------------------------
check("validateSpeakText rejects empty", validateSpeakText("").ok === false);
check("validateSpeakText rejects whitespace", validateSpeakText("   ").ok === false);
check("validateSpeakText rejects non-string", validateSpeakText(undefined).ok === false);
check("validateSpeakText rejects over-length", validateSpeakText("x".repeat(MAX_SPEAK_CHARS + 1)).ok === false);
{
  const v = validateSpeakText("  hello world  ");
  check("validateSpeakText accepts + trims a valid string", v.ok === true && v.ok && v.text === "hello world");
}
check("validateSpeakText accepts exactly MAX_SPEAK_CHARS", validateSpeakText("x".repeat(MAX_SPEAK_CHARS)).ok === true);

// -----------------------------------------------------------------------------
// (B) Worker-down degrade — speak() must not throw.
// -----------------------------------------------------------------------------
{
  let threw = false;
  let result: Awaited<ReturnType<typeof speak>> | null = null;
  try {
    result = await speak({ text: "hello" });
  } catch {
    threw = true;
  }
  check("speak() does not throw when the worker is down", threw === false);
  check("speak() degrades to { ok:false } with a reason", result !== null && result.ok === false && typeof (result as { error: string }).error === "string");
}

// -----------------------------------------------------------------------------
// (C) Cheap status — reports unavailable, no synthesis.
// -----------------------------------------------------------------------------
{
  const before = Date.now();
  const status = await voiceStatus();
  const elapsed = Date.now() - before;
  check("voiceStatus() reports 'unavailable' when the worker is down", status.voice === "unavailable", JSON.stringify(status));
  check("voiceStatus() returns fast (cheap probe, no synthesis)", elapsed < 2000, `elapsed=${elapsed}ms`);
  check("voiceStatus() carries an error reason", typeof status.error === "string");
}

// -----------------------------------------------------------------------------
// (D) computeLocality — /api/health's locality accounts for connector egress.
//     Voice STT now runs locally (faster-whisper), so it never flips this remote;
//     a cloud connector does.
// -----------------------------------------------------------------------------
check("computeLocality: no connectors → local", computeLocality([]) === "local");
check(
  "computeLocality: all-local enabled → local",
  computeLocality([{ enabled: true, isLocal: true }, { enabled: true, isLocal: true }]) === "local",
);
check(
  "computeLocality: an enabled remote connector → remote",
  computeLocality([{ enabled: true, isLocal: true }, { enabled: true, isLocal: false }]) === "remote",
);
check(
  "computeLocality: a DISABLED remote connector does not flip locality",
  computeLocality([{ enabled: false, isLocal: false }]) === "local",
);

// -----------------------------------------------------------------------------
// (E) speechPolicy — the governed "with rules" layer (PURE: no DB, no network).
//     Decides WHEN/WHAT the brain speaks; the route applies it at the single
//     /api/voice/speak choke point.
// -----------------------------------------------------------------------------
const { sanitizeForSpeech, capAtSentence, presetForPersona, decideSpeech } = await import(
  "../src/voice/speechPolicy.js"
);

{
  const dirty = "Known memory:\n- **bold** see [m:ab12] and `code` and [link](http://x.test/p)";
  const clean = sanitizeForSpeech(dirty);
  check("sanitizeForSpeech strips [m:id] citation markers", !clean.includes("[m:"));
  check("sanitizeForSpeech strips the section headers", !clean.includes("Known memory:"));
  check("sanitizeForSpeech strips markdown emphasis + backticks", !clean.includes("**") && !clean.includes("`"));
  check("sanitizeForSpeech keeps a link label, drops the URL", clean.includes("link") && !clean.includes("http"));
}

{
  // A planted secret must never reach spoken text (safety backstop, always on).
  const d = decideSpeech({
    text: "the key is sk-proj-ABCDEFGHIJKLMNOP12345 ok",
    kind: "manual",
    enabled: true,
    mode: "manual",
    maxChars: 600,
    defaultPreset: "v2/en_speaker_6",
  });
  check(
    "decideSpeech redacts secrets before speaking",
    d.speak === true && !d.text.includes("sk-proj-") && d.redactions >= 1,
    JSON.stringify({ text: d.text, redactions: d.redactions }),
  );
}

{
  const long = "One sentence here. Two sentence here. Three sentence here. " + "x".repeat(50);
  const capped = capAtSentence(long, 40);
  check("capAtSentence never exceeds the cap (sentence/word boundary)", capped.length <= 41, `len=${capped.length}`);
}

{
  const base = { text: "hello world", enabled: true, maxChars: 600, defaultPreset: "v2/en_speaker_6" };
  check("mode 'off' never speaks", decideSpeech({ ...base, mode: "off", kind: "answer" }).speak === false);
  check(
    "mode 'manual' speaks only a manual request",
    decideSpeech({ ...base, mode: "manual", kind: "manual" }).speak === true &&
      decideSpeech({ ...base, mode: "manual", kind: "answer" }).speak === false,
  );
  check(
    "mode 'answers' speaks answer/error but not idle-thought",
    decideSpeech({ ...base, mode: "answers", kind: "answer" }).speak === true &&
      decideSpeech({ ...base, mode: "answers", kind: "error" }).speak === true &&
      decideSpeech({ ...base, mode: "answers", kind: "idle-thought" }).speak === false,
  );
  check(
    "mode 'proactive' speaks an idle-thought",
    decideSpeech({ ...base, mode: "proactive", kind: "idle-thought" }).speak === true,
  );
  check(
    "a manual request bypasses the mode gate (the click IS consent)",
    decideSpeech({ ...base, mode: "answers", kind: "manual" }).speak === true,
  );
  check(
    "voice disabled never speaks regardless of mode",
    decideSpeech({ ...base, enabled: false, mode: "proactive", kind: "answer" }).speak === false,
  );
}

{
  check("presetForPersona maps a known persona", presetForPersona("scholar", "fallback") !== "fallback");
  check("presetForPersona falls back for an absent persona", presetForPersona(undefined, "v2/en_speaker_6") === "v2/en_speaker_6");
}

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
