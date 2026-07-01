// The ONE place the frontend turns text into speech. It POSTs the governed
// /api/voice/speak — the SERVER applies every rule (enabled/mode gate, sanitize,
// redact secrets, length cap) — then either plays the returned Bark audio or,
// when the worker is down, speaks the SAME governed text via the browser's Web
// Speech API. The client therefore never decides WHAT is spoken; it only renders
// the server's governed decision. Best-effort: any failure is swallowed so voice
// never breaks the answer flow.
//
// Two ways to speak:
//   speak(text)         — barge-in: interrupts any current/queued speech first.
//                          Use for a single complete utterance (a finished
//                          answer, a manual click, an idle-thought).
//   enqueueSpeech(text)  — sequential: plays after whatever is currently
//                          playing/queued finishes, WITHOUT interrupting it.
//                          Use for streamingSpeech.ts's sentence-by-sentence
//                          narration so each chunk doesn't cut the last one off.

import { SerialAudioPlayer } from "../components/pet/audioQueue";
import { apiClient } from "./apiClient";
import { getUiPrefs } from "./uiPrefs";
import type { SpeakResponse, SpeechKind } from "../../shared/voice";
import type { SpinalPersonaId } from "../../shared/spine";

const audio = new SerialAudioPlayer();

function synth(): SpeechSynthesis | null {
  return typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
}

/** Speaks via the browser's Web Speech API; resolves once the utterance ends. */
function browserTts(text: string): Promise<void> {
  return new Promise((resolve) => {
    const s = synth();
    if (!s || typeof SpeechSynthesisUtterance === "undefined") {
      resolve();
      return;
    }
    const u = new SpeechSynthesisUtterance(text);
    const prefs = getUiPrefs();
    u.rate = prefs.voiceRate;
    u.pitch = prefs.voicePitch;
    if (prefs.voiceURI) {
      const v = s.getVoices().find((x) => x.voiceURI === prefs.voiceURI);
      if (v) u.voice = v;
    }
    u.onend = () => resolve();
    u.onerror = () => resolve();
    s.speak(u);
  });
}

export interface SpeakOpts {
  kind?: SpeechKind;
  persona?: SpinalPersonaId;
}

// Fetch the governed decision + play it to completion, with NO barge-in. The
// shared building block for both speak() (barges in first) and the streaming
// queue (sequenced, no barge-in between chunks).
async function speakOne(text: string, opts?: SpeakOpts): Promise<void> {
  const resp: SpeakResponse | null = await apiClient
    .voiceSpeak({ text, kind: opts?.kind ?? "manual", persona: opts?.persona })
    .catch(() => null);
  if (!resp || resp.spoken === false) return;
  if (resp.mode === "audio") {
    await audio.play(resp.audioBase64, resp.mimeType);
    await audio.waitForIdle(); // wait for the clip to actually FINISH, not just start
  } else {
    await browserTts(resp.text);
  }
}

/**
 * Speak `text` through the governed endpoint, interrupting any current/queued
 * speech first (barge-in). A no-op if the server declines (voice disabled,
 * mode doesn't allow this kind, or nothing speakable).
 */
export async function speak(text: string, opts?: SpeakOpts): Promise<void> {
  if (!text || !text.trim()) return;
  stopSpeaking();
  await speakOne(text, opts);
}

// FIFO queue for sentence-chunked streaming speech: each enqueued chunk plays
// after the previous one finishes, so incremental sentences from a streaming
// answer narrate in order instead of each barging in on the last.
const queue: Array<{ text: string; opts?: SpeakOpts }> = [];
let draining = false;

async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const next = queue.shift();
      if (next) await speakOne(next.text, next.opts);
    }
  } finally {
    draining = false;
  }
}

/**
 * Queue `text` to speak after any currently-playing/queued speech finishes.
 * Does NOT interrupt — pair with stopSpeaking() at the start of a fresh
 * utterance stream (submit()/ask() call sites already do this for barge-in).
 */
export function enqueueSpeech(text: string, opts?: SpeakOpts): void {
  if (!text || !text.trim()) return;
  queue.push({ text, opts });
  void drainQueue();
}

/** Barge-in: stop any in-flight/queued audio + browser speech. Idempotent. */
export function stopSpeaking(): void {
  queue.length = 0;
  audio.stop();
  synth()?.cancel();
}
