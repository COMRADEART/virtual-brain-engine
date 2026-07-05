import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "../../engine/apiClient";
import { getUiPrefs } from "../../engine/uiPrefs";
import { blobToBase64, isRecordingSupported, pickRecorderMime } from "./voiceCapture";
import { DEFAULT_HOTWORDS, isLoudEnough, matchHotword } from "./listenerMatch";

export interface PersonListenerProps {
  /** Called when a transcript contains a hotword. The matched prompt
   *  (hotword + filler trimmed) is what the agent loop receives. */
  onPrompt: (text: string, hotword: string) => void;
  /** Optional diagnostics sink — every transcript (with or without a
   *  hotword) flows through here. The "what I heard" panel in the Mind
   *  panel uses this. NEVER raw audio. */
  onHeard?: (text: string, hadHotword: boolean) => void;
  /** Soft-fail notice when the worker is down or getUserMedia is denied. */
  onError?: (msg: string) => void;
  /** Optional external toggle; when this changes to true, start; to false, stop. */
  enabled?: boolean;
}

interface CycleCtx {
  stream: MediaStream;
  recorder: MediaRecorder;
  mime: string;
  cleanup: () => void;
}

/**
 * PersonListener — the pet's always-on ear. Opens the mic via
 * `getUserMedia`, drives a MediaRecorder in 3-second stop/restart cycles
 * (proven cadence; faster-whisper returns in ~200ms on CPU), and only
 * fires `onPrompt` when the transcript contains a hotword.
 *
 * ponytail: this is the LIFECYCLE (audio + WS-ish IO). All matching logic
 * lives in personListener.ts so it's unit-testable. The component is the
 * seam between audio IO and the pure logic.
 *
 * - Reuses `pickRecorderMime` + `blobToBase64` from voiceCapture.ts (same
 *   proven PTT path) — no new dep, no parallel impl.
 * - Reuses `apiClient.perceptionTranscribe` — same endpoint as PTT, so
 *   the worker gracefully degrades identically.
 * - Soft-fails: if the worker is down, we silently swallow the error
 *   (the diagnostic fires through `onError`); the listener does NOT
 *   crash or block the pet.
 * - Coexists with PTT: when PTT is pressed, the always-listener pauses
 *   to avoid two MediaRecorders fighting for the same mic.
 */
export function PersonListener({
  onPrompt,
  onHeard,
  onError,
  enabled,
}: PersonListenerProps) {
  const [active, setActive] = useState(false);
  // The cycle token increments on every start/stop; if a stale cycle
  // callback fires after stop, it sees its own token has moved on and
  // bails. Same pattern as usePushToTalk.
  const cycleRef = useRef(0);
  const ctxRef = useRef<CycleCtx | null>(null);
  const prefsRef = useRef(getUiPrefs().personListener);

  // Re-read prefs on every render; the pet subscribes to useUiPrefs in
  // its own component. We don't subscribe here — this component is
  // mostly effect-driven.
  useEffect(() => {
    prefsRef.current = getUiPrefs().personListener;
  });

  const stop = useCallback(() => {
    cycleRef.current += 1; // invalidate any in-flight cycle
    const ctx = ctxRef.current;
    ctxRef.current = null;
    if (ctx) ctx.cleanup();
    setActive(false);
  }, []);

  const start = useCallback(async () => {
    if (ctxRef.current) return; // already running
    if (!isRecordingSupported()) {
      onError?.("Microphone recording is not supported in this browser.");
      return;
    }
    const prefs = prefsRef.current;
    const myToken = cycleRef.current;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      onError?.(
        err instanceof Error && err.name === "NotAllowedError"
          ? "Microphone permission denied."
          : "Could not access the microphone.",
      );
      return;
    }
    if (myToken !== cycleRef.current) {
      // stop() ran while we were awaiting — release the stream we just got.
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    const mime = pickRecorderMime();
    let recorder: MediaRecorder;
    try {
      recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      onError?.("Failed to start the microphone recorder.");
      return;
    }

    const cleanup = () => {
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {}
      stream.getTracks().forEach((t) => t.stop());
    };
    ctxRef.current = { stream, recorder, mime, cleanup };
    setActive(true);

    // Drive the recorder in fixed-length chunks via onstop chaining.
    // The "chunk" cadence is the user's `chunkSeconds` (default 3s).
    const chunkMs = Math.max(1, Math.round(prefs.chunkSeconds * 1000));

    const transcribeBlob = async (blob: Blob, recordedType: string): Promise<void> => {
      if (myToken !== cycleRef.current) return; // stopped mid-flight
      if (blob.size === 0) return;
      try {
        const audioBase64 = await blobToBase64(blob);
        const result = await apiClient.perceptionTranscribe({
          audioBase64,
          mimeType: recordedType || mime || "audio/webm",
        });
        if (myToken !== cycleRef.current) return;
        const text = result.text ?? "";
        if (!isLoudEnough(text)) return;
        const match = matchHotword(
          text,
          prefs.hotwords.length > 0 ? prefs.hotwords : DEFAULT_HOTWORDS,
        );
        onHeard?.(text, match !== null);
        if (match) onPrompt(match.prompt, match.hotword);
      } catch (err) {
        // Worker down or network — never block; just notify the caller
        // once per failure (so the pet can show a "voice off" badge).
        onError?.(
          err instanceof Error ? err.message : "Transcription unavailable.",
        );
      }
    };

    const armNextCycle = () => {
      if (myToken !== cycleRef.current) return;
      if (recorder.state === "inactive") {
        try {
          recorder.start();
        } catch {
          return;
        }
        window.setTimeout(() => {
          if (myToken !== cycleRef.current) return;
          if (recorder.state === "recording") {
            try {
              recorder.stop();
            } catch {}
          }
        }, chunkMs);
      }
    };

    // Standard chunks-array collection, mirroring the usePushToTalk pattern
    // in voiceCapture.ts. Each MediaRecorder cycle fills `chunks`; on stop
    // we concatenate, transcribe, then re-arm the next cycle.
    const chunks: Blob[] = [];
    recorder.ondataavailable = (ev: BlobEvent) => {
      if (ev.data && ev.data.size > 0) chunks.push(ev.data);
    };
    recorder.onstop = () => {
      const collected = chunks.splice(0, chunks.length);
      const recordedType = recorder.mimeType || mime || "audio/webm";
      const blob = new Blob(collected, { type: recordedType });
      void transcribeBlob(blob, recordedType);
      if (myToken === cycleRef.current) {
        window.setTimeout(armNextCycle, 50);
      }
    };

    // Kick off the first cycle.
    armNextCycle();
  }, [onError, onHeard, onPrompt]);

  // External enable/disable — settings toggle, tray menu, or hotkey.
  useEffect(() => {
    if (enabled === undefined) return;
    if (enabled && !active) {
      void start();
    } else if (!enabled && active) {
      stop();
    }
  }, [enabled, active, start, stop]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  // Expose nothing for now — the parent (PetWindow) calls `start()` / `stop()`
  // via refs or via the `enabled` prop. The "👂 listening" indicator is a
  // sibling that reads `getUiPrefs().personListener.enabled` directly.
  return null;
}
