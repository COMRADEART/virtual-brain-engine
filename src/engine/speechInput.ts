// Web Speech API wrapper. The global SpeechRecognition types vary across TS lib
// versions, so this module declares the minimum shape it needs and bypasses the
// ambient types entirely. Returns null when the browser doesn't support it (most
// notably Firefox).

interface MinimalSpeechAlt {
  transcript: string;
}

interface MinimalSpeechResult {
  isFinal: boolean;
  // Indexed alternatives — we only read [0].
  0: MinimalSpeechAlt;
}

interface MinimalSpeechEvent {
  resultIndex: number;
  results: {
    readonly length: number;
    [index: number]: MinimalSpeechResult;
  };
}

interface MinimalSpeechErrorEvent {
  error: string;
  message?: string;
}

interface MinimalSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: MinimalSpeechEvent) => void) | null;
  onerror: ((event: MinimalSpeechErrorEvent) => void) | null;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type MinimalSpeechCtor = new () => MinimalSpeechRecognition;

function getCtor(): MinimalSpeechCtor | null {
  if (typeof window === "undefined") {
    return null;
  }
  const w = window as unknown as {
    SpeechRecognition?: MinimalSpeechCtor;
    webkitSpeechRecognition?: MinimalSpeechCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isSpeechSupported(): boolean {
  return getCtor() !== null;
}

export interface SpeechSessionOptions {
  onInterim?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (message: string) => void;
  onListeningChange?: (listening: boolean) => void;
  lang?: string;
}

export interface SpeechSession {
  start: () => void;
  stop: () => void;
  dispose: () => void;
}

// Returns null when the browser has no speech API. Callers should hide the UI.
export function createSpeechSession(options: SpeechSessionOptions): SpeechSession | null {
  const Ctor = getCtor();
  if (!Ctor) {
    return null;
  }

  const session = new Ctor();
  session.continuous = true;
  session.interimResults = true;
  session.lang = options.lang ?? (typeof navigator !== "undefined" ? navigator.language : "en-US");

  let finalText = "";
  let listening = false;
  let disposed = false;

  session.onresult = (event) => {
    let interim = "";
    let newlyFinal = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const transcript = result?.[0]?.transcript ?? "";
      if (result.isFinal) {
        newlyFinal += transcript;
      } else {
        interim += transcript;
      }
    }
    if (newlyFinal) {
      finalText += newlyFinal;
      options.onFinal?.(finalText.trim());
    }
    if (interim) {
      options.onInterim?.((finalText + interim).trim());
    }
  };

  session.onerror = (event) => {
    // "no-speech" and "aborted" are routine and not worth surfacing.
    if (event.error === "no-speech" || event.error === "aborted") {
      return;
    }
    options.onError?.(event.message ?? event.error ?? "speech recognition error");
  };

  session.onstart = () => {
    listening = true;
    options.onListeningChange?.(true);
  };

  session.onend = () => {
    listening = false;
    options.onListeningChange?.(false);
  };

  return {
    start: () => {
      if (disposed || listening) {
        return;
      }
      finalText = "";
      try {
        session.start();
      } catch (error) {
        options.onError?.(error instanceof Error ? error.message : String(error));
      }
    },
    stop: () => {
      if (disposed || !listening) {
        return;
      }
      try {
        session.stop();
      } catch {
        // Already stopped — ignore.
      }
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      try {
        session.abort();
      } catch {
        // ignore
      }
      session.onresult = null;
      session.onerror = null;
      session.onstart = null;
      session.onend = null;
    },
  };
}
