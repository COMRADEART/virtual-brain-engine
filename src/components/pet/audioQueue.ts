// Serial WAV playback for the desktop pet. The old inline `playBase64Wav`
// spawned a fresh `new Audio()` per call with no queue and no cancellation, so
// rapid agent answers overlapped/garbled, the unreferenced Audio could be GC'd
// mid-playback, and toggling voice off couldn't stop in-flight speech (no
// barge-in). This module keeps AT MOST ONE clip playing: a new clip stops +
// revokes the previous, the object URL is held until `onended`, and `stop()`
// gives barge-in. It is the prerequisite for sentence-chunked streaming TTS.
//
// The DOM/Audio dependencies are injected via an `AudioEnv` so the state machine
// is unit-testable with a mock Audio (no jsdom audio support needed).

export interface AudioLike {
  play(): Promise<void>;
  pause(): void;
  onended: (() => void) | null;
  onerror: (() => void) | null;
}

export interface AudioEnv {
  decodeBase64(b64: string): Uint8Array;
  createUrl(bytes: Uint8Array, mime: string): string;
  revokeUrl(url: string): void;
  createAudio(url: string): AudioLike;
}

function defaultEnv(): AudioEnv {
  return {
    decodeBase64(b64: string): Uint8Array {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    },
    createUrl(bytes: Uint8Array, mime: string): string {
      // Cast to BlobPart: lib.dom narrows to ArrayBufferView<ArrayBuffer> but a
      // plain Uint8Array is a valid BlobPart at runtime.
      return URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    },
    revokeUrl(url: string): void {
      URL.revokeObjectURL(url);
    },
    createAudio(url: string): AudioLike {
      // HTMLAudioElement's onended signature is wider than AudioLike's; the
      // narrow shape is all we use.
      return new Audio(url) as unknown as AudioLike;
    },
  };
}

/**
 * One-clip-at-a-time player. `play()` stops any current clip first, so calls are
 * naturally serial and never overlap. Every resource (Audio + object URL) is
 * released on end, error, or the next `stop()`.
 */
export class SerialAudioPlayer {
  private current: AudioLike | null = null;
  private currentUrl: string | null = null;
  private readonly env: AudioEnv;

  constructor(env?: AudioEnv) {
    this.env = env ?? defaultEnv();
  }

  /** True while a clip is loaded/playing. */
  get playing(): boolean {
    return this.current !== null;
  }

  /** Stop and fully release the current clip (barge-in). Idempotent. */
  stop(): void {
    if (this.current) {
      try {
        this.current.pause();
      } catch {
        /* ignore */
      }
      this.current.onended = null;
      this.current.onerror = null;
      this.current = null;
    }
    if (this.currentUrl) {
      try {
        this.env.revokeUrl(this.currentUrl);
      } catch {
        /* ignore */
      }
      this.currentUrl = null;
    }
  }

  /**
   * Play a base64 WAV. Stops the previous clip first. Resolves once playback has
   * STARTED (or immediately if decoding/start fails — best-effort, never throws).
   */
  async play(base64: string, mime = "audio/wav"): Promise<void> {
    if (!base64) return;
    this.stop();
    let url: string;
    let audio: AudioLike;
    try {
      const bytes = this.env.decodeBase64(base64);
      url = this.env.createUrl(bytes, mime);
      audio = this.env.createAudio(url);
    } catch {
      return; // decode/create failed — nothing to release
    }
    this.current = audio;
    this.currentUrl = url;
    const release = () => {
      // Only release if this clip is still the active one (a newer play() may
      // have already replaced + released it).
      if (this.current === audio) {
        audio.onended = null;
        audio.onerror = null;
        this.current = null;
      }
      if (this.currentUrl === url) {
        try {
          this.env.revokeUrl(url);
        } catch {
          /* ignore */
        }
        this.currentUrl = null;
      }
    };
    audio.onended = release;
    audio.onerror = release;
    try {
      await audio.play();
    } catch {
      release(); // autoplay blocked / play rejected — clean up
    }
  }
}

// Module singleton used by the pet. One window = one voice.
const petPlayer = new SerialAudioPlayer();

export function playPetAudio(base64: string, mime = "audio/wav"): Promise<void> {
  return petPlayer.play(base64, mime);
}

export function stopPetAudio(): void {
  petPlayer.stop();
}
