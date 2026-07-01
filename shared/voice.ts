// Shared contract for the GOVERNED voice ("the brain speaks, with rules"). ZERO
// runtime deps — imported by the server route, the worker client, and the
// frontend voice player. The rules themselves live server-side in
// server/src/voice/speechPolicy.ts; this is just the wire shape.

import type { SpinalPersonaId } from "./spine.js";

// WHY the brain is speaking — gates which voiceMode lets it through.
//   answer      — a completed /api/ask or agent answer.
//   error       — a surfaced error / contradiction note.
//   idle-thought — an unprompted musing (only spoken in "proactive" mode).
//   manual      — the user explicitly asked it to speak this (always allowed
//                 when voice is enabled — the click IS the consent).
export type SpeechKind = "answer" | "error" | "idle-thought" | "manual";

// WHEN the brain is allowed to speak (server CONFIG.voiceMode):
//   off       — never.
//   manual    — only on an explicit request (kind:"manual").
//   answers   — completed answers + errors + manual (the default).
//   proactive — also unprompted idle-thoughts (rate-limited by the caller).
export type VoiceMode = "off" | "manual" | "answers" | "proactive";
export const VOICE_MODES: VoiceMode[] = ["off", "manual", "answers", "proactive"];

// The governed speak request (apiClient → POST /api/voice/speak → route).
export interface SpeakRequest {
  text: string;
  kind?: SpeechKind; // default "manual"
  persona?: SpinalPersonaId; // optional → maps to a voice preset
  voice?: string; // explicit Bark preset override (wins over persona/default)
  preset?: string; // explicit style preset, passed through to the worker
}

// The worker synthesized audio (Bark path).
export interface SpeakAudio {
  spoken: true;
  mode: "audio";
  audioBase64: string;
  mimeType: string;
  sampleRate: number;
  durationSec: number;
  latencyMs: number;
  model: string;
  voice: string;
}

// The worker/Bark was unavailable — the client speaks `text` itself via the
// browser Web Speech API. `text` is ALREADY governed (sanitized + redacted +
// capped) so the client never receives raw model output.
export interface SpeakClientTts {
  spoken: true;
  mode: "client-tts";
  text: string;
  preset: string;
}

// The policy declined to speak (voice disabled, or the mode doesn't allow this
// kind, or nothing was speakable after sanitization). Not an error — a no-op.
export interface SpeakDeclined {
  spoken: false;
  reason: string;
}

export type SpeakResponse = SpeakAudio | SpeakClientTts | SpeakDeclined;
