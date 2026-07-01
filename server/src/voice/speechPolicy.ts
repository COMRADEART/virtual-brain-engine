// PURE governed-speech policy — the rules that decide WHEN and WHAT the brain
// speaks. No DB, no network, no Express, so the voice:selfcheck drives it
// directly. The route applies it at the single /api/voice/speak choke point, so
// the rules hold for every speaker (pet, AskPanel, agent loop) AND for the
// browser-TTS fallback (which only ever receives the already-governed text).
//
// The rules, in order:
//   1. enabled gate      — voice off → never speak.
//   2. mode × kind gate  — voiceMode decides which kinds may speak.
//   3. sanitize          — strip [m:id] markers, section headers, markdown, so
//                          the brain speaks naturally instead of reading markup.
//   4. redact (always)   — redactSecrets() so a surfaced key/token is never read
//                          aloud. NOT a toggle — a safety backstop.
//   5. cap               — truncate to voiceMaxChars at a sentence boundary.

import { redactSecrets } from "../ingest/governance.js";
import type { SpeechKind, VoiceMode } from "../../../shared/voice.js";
import type { SpinalPersonaId } from "../../../shared/spine.js";

// Persona → Bark voice preset. Pure map; an absent/unknown persona uses the
// caller's default preset. Distinct voices so motor pools sound different.
const PERSONA_PRESETS: Record<SpinalPersonaId, string> = {
  scribe: "v2/en_speaker_6",
  scholar: "v2/en_speaker_4",
  courier: "v2/en_speaker_1",
  mechanic: "v2/en_speaker_2",
  connector: "v2/en_speaker_8",
  reflex: "v2/en_speaker_9",
};

export function presetForPersona(persona: SpinalPersonaId | undefined, fallback: string): string {
  if (!persona) return fallback;
  return PERSONA_PRESETS[persona] ?? fallback;
}

// Strip answer scaffolding so the brain SPEAKS instead of reading markup aloud.
export function sanitizeForSpeech(input: string): string {
  let t = input;
  t = t.replace(/\[m:[A-Za-z0-9]+\]/g, ""); // [m:<id>] citation markers
  t = t.replace(/```[\s\S]*?```/g, " "); // fenced code blocks (drop entirely)
  t = t.replace(/^\s*(Known memory:|Inferred reasoning:|Uncertain:)\s*/gim, ""); // section headers
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1"); // links/images → label only
  t = t.replace(/`([^`]*)`/g, "$1"); // inline code
  t = t.replace(/^[ \t]*[#>*+-]+[ \t]?/gm, ""); // line-leading heading/quote/list marks
  t = t.replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1"); // bold/italic/strike
  t = t.replace(/\s+/g, " ").trim(); // collapse whitespace
  return t;
}

// Truncate to <= max chars, preferring the last sentence boundary so speech ends
// on a complete thought. Falls back to a word boundary + ellipsis. Never exceeds
// max (except the single-char "…" when no space exists, still bounded).
export function capAtSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastStop = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "));
  if (lastStop >= max * 0.5) return slice.slice(0, lastStop + 1).trim();
  const lastSpace = slice.lastIndexOf(" ");
  return `${(lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trim()}…`;
}

// Does the current voiceMode permit speaking this KIND?
function modeAllows(mode: VoiceMode, kind: SpeechKind): boolean {
  switch (mode) {
    case "off":
      return false;
    case "manual":
      return kind === "manual";
    case "answers":
      return kind === "manual" || kind === "answer" || kind === "error";
    case "proactive":
      return true; // also idle-thought
  }
  return false;
}

export interface SpeechPolicyInput {
  text: string;
  kind: SpeechKind;
  enabled: boolean;
  mode: VoiceMode;
  maxChars: number;
  persona?: SpinalPersonaId;
  defaultPreset: string;
}

export interface SpeechDecision {
  speak: boolean;
  reason: string;
  text: string; // governed text — ready to synthesize or speak
  preset: string;
  redactions: number;
}

export function decideSpeech(input: SpeechPolicyInput): SpeechDecision {
  const preset = presetForPersona(input.persona, input.defaultPreset);
  if (!input.enabled) {
    return { speak: false, reason: "voice disabled", text: "", preset, redactions: 0 };
  }
  if (!modeAllows(input.mode, input.kind)) {
    return {
      speak: false,
      reason: `voice mode '${input.mode}' does not speak '${input.kind}'`,
      text: "",
      preset,
      redactions: 0,
    };
  }
  const sanitized = sanitizeForSpeech(input.text);
  const { text: redacted, count } = redactSecrets(sanitized);
  const capped = capAtSentence(redacted, Math.max(1, Math.floor(input.maxChars)));
  if (capped.trim().length === 0) {
    return { speak: false, reason: "nothing speakable after sanitization", text: "", preset, redactions: count };
  }
  return { speak: true, reason: "ok", text: capped, preset, redactions: count };
}
