// Push-to-talk speech input for the pet. Press-and-hold the mic → record →
// release → transcribe via the LOCAL faster-whisper endpoint → hand the text to
// the caller (which feeds it into the agentic loop). The MediaRecorder +
// getUserMedia lifecycle lives here; the testable transforms are in
// voiceCapture.ts.
//
// Graceful degrade: if the browser can't record (no MediaRecorder /
// getUserMedia), `supported` is false and the caller hides the mic button. A
// worker-down transcribe returns a 503 → we report a quiet error, never throw.

import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "../../engine/apiClient";
import { blobToBase64, isRecordingSupported, pickRecorderMime } from "./voiceCapture";

export interface PushToTalk {
  supported: boolean;
  recording: boolean;
  transcribing: boolean;
  /** Begin capturing (press). No-op if unsupported or already recording. */
  start: () => void;
  /** Stop capturing (release); transcribes and invokes onTranscript on success. */
  stop: () => void;
}

export function usePushToTalk(
  onTranscript: (text: string) => void,
  onError?: (message: string) => void,
): PushToTalk {
  const [supported] = useState(isRecordingSupported);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const mimeRef = useRef<string>("");

  const cleanupStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // Stop everything if the component unmounts mid-recording.
  useEffect(() => {
    return () => {
      try {
        recorderRef.current?.state !== "inactive" && recorderRef.current?.stop();
      } catch {
        /* ignore */
      }
      cleanupStream();
    };
  }, [cleanupStream]);

  const start = useCallback(() => {
    if (!supported || recording || transcribing) return;
    chunksRef.current = [];
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        streamRef.current = stream;
        const mime = pickRecorderMime();
        mimeRef.current = mime;
        const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        recorderRef.current = recorder;
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.onstop = () => {
          cleanupStream();
          const type = mimeRef.current || "audio/webm";
          const blob = new Blob(chunksRef.current, { type });
          chunksRef.current = [];
          if (blob.size === 0) {
            setTranscribing(false);
            return;
          }
          setTranscribing(true);
          void (async () => {
            try {
              const audioBase64 = await blobToBase64(blob);
              const result = await apiClient.perceptionTranscribe({ audioBase64, mimeType: type });
              const text = result.text?.trim();
              if (text) onTranscript(text);
              else onError?.("No speech detected.");
            } catch (err) {
              onError?.(
                err instanceof Error && /50[0-9]|fetch|network/i.test(err.message)
                  ? "Transcription unavailable (is the worker running?)"
                  : err instanceof Error
                    ? err.message
                    : "Transcription failed.",
              );
            } finally {
              setTranscribing(false);
            }
          })();
        };
        recorder.start();
        setRecording(true);
      })
      .catch((err) => {
        cleanupStream();
        onError?.(
          err instanceof Error && err.name === "NotAllowedError"
            ? "Microphone permission denied."
            : "Could not access the microphone.",
        );
      });
  }, [supported, recording, transcribing, onTranscript, onError, cleanupStream]);

  const stop = useCallback(() => {
    if (!recording) return;
    setRecording(false);
    try {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop(); // fires onstop → transcribe
      }
    } catch {
      cleanupStream();
    }
  }, [recording, cleanupStream]);

  return { supported, recording, transcribing, start, stop };
}
