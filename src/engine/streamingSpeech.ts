// Speaks a growing answer sentence-by-sentence AS it streams, instead of
// waiting for the full text. The pipeline/agent-loop SSE stream delivers the
// answer incrementally; without this, voice sits silent until the LAST token
// arrives even though the first few sentences were readable seconds earlier.
//
// Feed the full accumulated text so far on every token delta via push() — it
// finds newly-completed sentence boundaries and enqueues just the new part to
// speak (voicePlayer.enqueueSpeech, which plays chunks back-to-back without
// interrupting each other). Call flush() once the stream ends to speak the
// trailing partial sentence that never hit a boundary.
//
// The enabled check is re-read live on every push()/flush() (not captured
// once at construction) so toggling voice mid-answer takes effect immediately,
// same as the rest of the app's "read live" voice gating. Defaults to the
// shared uiPrefs.voiceEnabled toggle; pass isEnabled to use a different source
// (e.g. the desktop pet's own local voiceOn state).

import { enqueueSpeech, type SpeakOpts } from "./voicePlayer";
import { getUiPrefs } from "./uiPrefs";

// Last index AFTER a sentence-ending punctuation+space, or a newline. -1 if
// the increment has no complete sentence yet (still mid-sentence).
function lastSentenceBreak(text: string): number {
  let best = -1;
  const re = /[.!?]\s|\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    if (end > best) best = end;
  }
  return best;
}

export interface StreamingSpeakerOpts extends SpeakOpts {
  /** Live enabled check, re-read on every push()/flush(). Defaults to uiPrefs.voiceEnabled. */
  isEnabled?: () => boolean;
}

export class StreamingSpeaker {
  private cursor = 0;
  private readonly opts?: SpeakOpts;
  private readonly isEnabled: () => boolean;

  constructor(opts?: StreamingSpeakerOpts) {
    const { isEnabled, ...speakOpts } = opts ?? {};
    this.opts = speakOpts;
    this.isEnabled = isEnabled ?? (() => getUiPrefs().voiceEnabled);
  }

  /** Feed the FULL accumulated text so far (not just the delta). */
  push(fullTextSoFar: string): void {
    if (!this.isEnabled()) return;
    const unspoken = fullTextSoFar.slice(this.cursor);
    const breakAt = lastSentenceBreak(unspoken);
    if (breakAt > 0) {
      enqueueSpeech(unspoken.slice(0, breakAt), this.opts);
      this.cursor += breakAt;
    }
  }

  /** Speak the trailing partial sentence once the stream is done. */
  flush(finalText: string): void {
    if (this.isEnabled()) {
      const remainder = finalText.slice(this.cursor);
      if (remainder.trim()) enqueueSpeech(remainder, this.opts);
    }
    this.cursor = finalText.length;
  }
}
