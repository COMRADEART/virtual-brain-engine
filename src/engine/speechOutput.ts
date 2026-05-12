// TTS wrapper around window.speechSynthesis. Symmetric in shape with the STT
// wrapper in speechInput.ts: feature-detected, no-ops when unsupported, and
// independent of any external state so callers can use it from anywhere.

export function isTtsSupported(): boolean {
  return typeof window !== "undefined" && typeof window.speechSynthesis !== "undefined";
}

// Voices load asynchronously in Chrome — getVoices() may return [] until the
// "voiceschanged" event fires. We cache the resolved list lazily.
let voicesCache: SpeechSynthesisVoice[] | null = null;
let voicesListenerAttached = false;

function refreshVoices(): SpeechSynthesisVoice[] {
  if (!isTtsSupported()) {
    return [];
  }
  voicesCache = window.speechSynthesis.getVoices();
  return voicesCache;
}

function ensureVoicesListener(): void {
  if (voicesListenerAttached || !isTtsSupported()) {
    return;
  }
  voicesListenerAttached = true;
  window.speechSynthesis.addEventListener("voiceschanged", () => {
    voicesCache = window.speechSynthesis.getVoices();
  });
}

export function preferredVoice(): SpeechSynthesisVoice | null {
  if (!isTtsSupported()) {
    return null;
  }
  ensureVoicesListener();
  const list = voicesCache ?? refreshVoices();
  if (list.length === 0) {
    return null;
  }
  // Prefer English voices; default to the first overall if none match.
  const englishLocal = list.find((voice) => voice.lang.toLowerCase().startsWith("en") && voice.localService);
  if (englishLocal) {
    return englishLocal;
  }
  const english = list.find((voice) => voice.lang.toLowerCase().startsWith("en"));
  return english ?? list[0] ?? null;
}

export interface SpeakOptions {
  voice?: SpeechSynthesisVoice | null;
  rate?: number;
  pitch?: number;
  volume?: number;
}

export interface SpeakHandle {
  cancel: () => void;
}

const NO_OP_HANDLE: SpeakHandle = { cancel: () => {} };

export function speakText(text: string, options: SpeakOptions = {}): SpeakHandle {
  if (!isTtsSupported()) {
    return NO_OP_HANDLE;
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return NO_OP_HANDLE;
  }

  ensureVoicesListener();

  const utterance = new SpeechSynthesisUtterance(trimmed);
  utterance.voice = options.voice ?? preferredVoice();
  utterance.rate = options.rate ?? 1.05;
  utterance.pitch = options.pitch ?? 1.0;
  utterance.volume = options.volume ?? 1.0;

  let cancelled = false;
  utterance.onend = () => {
    cancelled = true;
  };

  try {
    window.speechSynthesis.speak(utterance);
  } catch {
    return NO_OP_HANDLE;
  }

  return {
    cancel: () => {
      if (cancelled) {
        return;
      }
      cancelled = true;
      try {
        // Cancelling individual utterances isn't supported — cancel() drains
        // the whole queue. Callers wanting per-utterance cancel should serialise.
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
    },
  };
}

export function cancelAllSpeech(): void {
  if (!isTtsSupported()) {
    return;
  }
  try {
    window.speechSynthesis.cancel();
  } catch {
    // ignore
  }
}
