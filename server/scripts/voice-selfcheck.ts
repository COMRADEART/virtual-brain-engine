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

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
