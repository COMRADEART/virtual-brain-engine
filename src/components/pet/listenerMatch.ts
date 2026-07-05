// PersonListener — the pure, audio-free logic for the pet's always-listening
// companion. Everything testable lives here; the React hook (PersonListener.tsx)
// owns the getUserMedia + MediaRecorder lifecycle and calls into these
// helpers.
//
// The hotword matcher is intentionally simple: case-insensitive substring
// match on the transcript. A real "say my name from across the room" wake-
// word needs an always-on tiny model (Porcupine / openWakeWord) running in
// the worker — that's a follow-up. The utterance detector catches "Brain"
// / "Friday" / "hey brain" with high accuracy in practice; faster-whisper
// returns the transcript in <300ms on CPU for a 3s clip, so we have ~10x
// realtime margin.
//
// ponytail: no dependencies, no React, no DOM. The matcher is a single
// regex walk — and the function is the only one we test directly. If the
// upgrade to a real wake-word engine lands, this is the file that changes.

export const DEFAULT_HOTWORDS = ["brain", "friday", "hey brain", "ok brain"] as const;

export interface HotwordMatch {
  /** The transcript with the hotword (and any preceding filler) removed. */
  prompt: string;
  /** Which hotword matched (lowercased, as registered). */
  hotword: string;
  /** Index of the hotword in the original transcript (for diagnostics). */
  index: number;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildHotwordPattern(hotwords: readonly string[]): RegExp {
  if (hotwords.length === 0) return /(?!)/; // never matches
  const sorted = [...hotwords].sort((a, b) => b.length - a.length); // longest first
  const alt = sorted.map(escapeRegExp).join("|");
  // Word boundaries where they make sense: "ok brain" works, "okbraindoes"
  // would not (no space). We use a non-word boundary on the right so a
  // hotword followed by punctuation still matches.
  return new RegExp(`\\b(?:${alt})\\b`, "i");
}

/**
 * Find a hotword inside `transcript`. Returns the cleaned prompt
 * (hotword + optional preceding filler trimmed) + the matched hotword, or
 * null when nothing matches. The prompt is what we hand to the agent loop.
 */
export function matchHotword(
  transcript: string,
  hotwords: readonly string[] = DEFAULT_HOTWORDS,
): HotwordMatch | null {
  const trimmed = transcript.trim();
  if (!trimmed) return null;
  const pattern = buildHotwordPattern(hotwords);
  const match = pattern.exec(trimmed);
  if (!match) return null;
  const idx = match.index;
  // Drop the hotword; keep anything that came BEFORE it (often a fragment
  // like "uh" / "ok") and anything that came AFTER (the actual ask). Strip
  // a leading comma / dash that usually trails a hotword.
  const before = trimmed.slice(0, idx).replace(/[\s,;:.-]+$/, "");
  const after = trimmed.slice(idx + match[0].length).replace(/^[\s,;:.-]+/, "");
  const prompt = [before, after].filter(Boolean).join(" ").trim();
  if (!prompt) return null; // bare "brain" with no follow-on = ignore
  return { prompt, hotword: match[0].toLowerCase(), index: idx };
}

/**
 * True when a transcript has any non-whitespace content. We drop empty
 * faster-whisper returns (silence) before even checking the hotword — saves
 * the hotword regex on every quiet chunk.
 */
export function isLoudEnough(transcript: string): boolean {
  return transcript.trim().length > 0;
}
