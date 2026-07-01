// The ONE place the frontend turns text into speech. It POSTs the governed
// /api/voice/speak — the SERVER applies every rule (enabled/mode gate, sanitize,
// redact secrets, length cap) — then either plays the returned Bark audio or,
// when the worker is down, speaks the SAME governed text via the browser's Web
// Speech API. The client therefore never decides WHAT is spoken; it only renders
// the server's governed decision. Both paths barge-in (a new utterance cancels
// the previous). Best-effort: any failure is swallowed so voice never breaks the
// answer flow.

import { SerialAudioPlayer } from "../components/pet/audioQueue";
import { apiClient } from "./apiClient";
import { getUiPrefs } from "./uiPrefs";
import type { SpeakResponse, SpeechKind } from "../../shared/voice";
import type { SpinalPersonaId } from "../../shared/spine";

const audio = new SerialAudioPlayer();

function synth(): SpeechSynthesis | null {
  return typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
}

function browserTts(text: string): void {
  const s = synth();
  if (!s || typeof SpeechSynthesisUtterance === "undefined") return;
  const u = new SpeechSynthesisUtterance(text);
  const prefs = getUiPrefs();
  u.rate = prefs.voiceRate;
  u.pitch = prefs.voicePitch;
  if (prefs.voiceURI) {
    const v = s.getVoices().find((x) => x.voiceURI === prefs.voiceURI);
    if (v) u.voice = v;
  }
  s.speak(u);
}

export interface SpeakOpts {
  kind?: SpeechKind;
  persona?: SpinalPersonaId;
}

/**
 * Speak `text` through the governed endpoint. A no-op if the server declines
 * (voice disabled, mode doesn't allow this kind, or nothing speakable).
 */
export async function speak(text: string, opts?: SpeakOpts): Promise<void> {
  if (!text || !text.trim()) return;
  // Best-effort: a server error returns null and we stay silent.
  const resp: SpeakResponse | null = await apiClient
    .voiceSpeak({ text, kind: opts?.kind ?? "manual", persona: opts?.persona })
    .catch(() => null);
  if (!resp || resp.spoken === false) return;
  stopSpeaking(); // barge-in before starting the new utterance
  if (resp.mode === "audio") {
    await audio.play(resp.audioBase64, resp.mimeType);
  } else {
    browserTts(resp.text);
  }
}

/** Barge-in: stop any in-flight audio + browser speech. Idempotent. */
export function stopSpeaking(): void {
  audio.stop();
  synth()?.cancel();
}
