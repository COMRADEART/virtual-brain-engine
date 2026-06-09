// Pet voice capture — the pure, DOM-light pieces of push-to-talk speech input,
// split out from the React hook so they unit-test without a microphone or jsdom
// MediaRecorder support. The hook (usePushToTalk.ts) owns the getUserMedia +
// MediaRecorder lifecycle; everything testable lives here.
//
// The captured audio is sent to the LOCAL faster-whisper endpoint
// (apiClient.perceptionTranscribe → /api/perceive/transcribe), so the pet gains
// hearing WITHOUT any cloud STT — unlike the browser Web Speech API, which on
// Chrome/Edge silently streams mic audio to Google (see Phase 2).

/** Preferred recorder MIME types, best-first. faster-whisper decodes webm/opus
 *  via its PyAV/ffmpeg backend; the empty string lets the browser choose. */
export const RECORDER_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
] as const;

interface MediaRecorderTypeSupport {
  isTypeSupported?(type: string): boolean;
}

/** Pick the first supported recorder MIME, or "" (browser default) if none match. */
export function pickRecorderMime(
  ctor: MediaRecorderTypeSupport | undefined =
    typeof MediaRecorder !== "undefined" ? (MediaRecorder as MediaRecorderTypeSupport) : undefined,
): string {
  if (!ctor?.isTypeSupported) return "";
  for (const candidate of RECORDER_MIME_CANDIDATES) {
    if (ctor.isTypeSupported(candidate)) return candidate;
  }
  return "";
}

/** True when this browser can record from the microphone at all. */
export function isRecordingSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined"
  );
}

/** Minimal blob shape — `Blob` satisfies it; tests pass a fake with arrayBuffer. */
export interface BlobLike {
  arrayBuffer(): Promise<ArrayBuffer>;
  readonly size: number;
}

/** Encode a recorded audio blob to base64 (no data: prefix) for the JSON API. */
export async function blobToBase64(blob: BlobLike): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  // Chunk to stay well under the arg-count limit of String.fromCharCode(...spread).
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
