// Phase 3 — perception sidecar UI consumer. Collapsible overlay (full layout
// only) that drives /api/perceive/{status,transcribe,caption} via apiClient.
//
// Gate-safety rules (mirror DigitalTwinPanel.tsx — non-negotiable, the smoke
// tests assume them):
//   * Renders `null` until the WS bus connects. `npm run test:all` boots Vite
//     WITHOUT the server, so the bus never connects and this component renders
//     nothing — it cannot fail the canvas/console-error smoke gates.
//   * No <input type=range> anywhere (smoke-actions grabs the last range slider
//     as the density control). Worker uptime / latency use plain text.
//   * No <button> text colliding with action labels or "L Memory".
//   * Private `.perception-*` CSS namespace.
//   * Mic-permission failure is rendered to UI, NOT logged to console (smoke
//     counts console.error).
//
// What this panel actually does:
//   - Worker status badge polled every 10s WHILE OPEN (not on mount).
//   - Mic button: MediaRecorder (audio/webm) -> base64 -> POST transcribe.
//   - Drop-image: FileReader -> base64 -> POST caption.

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Headphones, Image as ImageIcon, Mic, MicOff, Square } from "lucide-react";
import { subscribeBrainBus, subscribeConnection } from "../engine/brainBus";
import { apiClient } from "../engine/apiClient";
import type { CaptionResult, TranscribeResult, WorkerStatus } from "../../shared/perception";

const STATUS_POLL_MS = 10_000;
const MAX_AUDIO_MS = 60_000; // safety stop; UI exposes a manual stop too.
const RECENT_CAP = 6;

interface PerceptionRecord {
  id: string;
  kind: "transcribe" | "caption";
  text: string;
  model: string;
  latencyMs: number;
  at: number;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error ?? new Error("FileReader failed"));
    r.onload = () => {
      const result = r.result;
      if (typeof result !== "string") return reject(new Error("FileReader did not return a string"));
      // strip data:<mime>;base64, prefix
      const i = result.indexOf(",");
      resolve(i >= 0 ? result.slice(i + 1) : result);
    };
    r.readAsDataURL(blob);
  });
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function statusTone(status: WorkerStatus | null): "down" | "scaffold" | "ready" {
  if (!status || status.status !== "ok") return "down";
  const anyReady = status.models.whisper === "ready" || status.models.caption === "ready";
  if (anyReady) return "ready";
  const anyAvailable =
    status.models.whisper !== "unavailable" || status.models.caption !== "unavailable";
  return anyAvailable ? "scaffold" : "down";
}

export function PerceptionPanel(): JSX.Element | null {
  const [busOk, setBusOk] = useState(false);
  const [status, setStatus] = useState<WorkerStatus | null>(null);
  const [collapsed, setCollapsed] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [pending, setPending] = useState<"transcribe" | "caption" | null>(null);
  const [permError, setPermError] = useState<string | null>(null);
  const [callError, setCallError] = useState<string | null>(null);
  const [recent, setRecent] = useState<PerceptionRecord[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const recordStopTimer = useRef<number | null>(null);

  // (1) Bus connectivity gate — same pattern as DigitalTwinPanel. Until the
  // bus says ok, render null; once ok, allow fetches.
  useEffect(() => subscribeConnection(setBusOk), []);

  // (2) Subscribe to perception broadcasts so the recent-list also fills when
  // another tab triggered the call.
  useEffect(() => {
    return subscribeBrainBus((m) => {
      if (m.type !== "perception") return;
      setRecent((prev) =>
        [
          {
            id: `perc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            kind: m.kind,
            text: m.preview,
            model: m.model,
            latencyMs: m.latencyMs,
            at: Date.now(),
          },
          ...prev,
        ].slice(0, RECENT_CAP),
      );
    });
  }, []);

  // (3) Status polling — only while open AND bus is connected. Cleared on
  // collapse or unmount; cheap (server probe is 200ms-capped).
  useEffect(() => {
    if (!busOk || collapsed) return;
    let cancelled = false;
    const tick = (): void => {
      apiClient
        .perceptionStatus()
        .then((s) => {
          if (!cancelled) setStatus(s);
        })
        .catch(() => {
          if (!cancelled) setStatus({ status: "down", uptimeSec: null, version: null, models: { whisper: "unavailable", caption: "unavailable" } });
        });
    };
    tick();
    const id = window.setInterval(tick, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [busOk, collapsed]);

  const stopRecording = useCallback((): void => {
    if (recordStopTimer.current !== null) {
      clearTimeout(recordStopTimer.current);
      recordStopTimer.current = null;
    }
    const rec = recorder.current;
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        // safety — already stopped
      }
    }
  }, []);

  const startRecording = useCallback(async (): Promise<void> => {
    setPermError(null);
    setCallError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      // Don't log — smoke counts console.error. Surface to UI only.
      const msg = err instanceof Error ? err.message : "Microphone permission denied";
      setPermError(msg);
      return;
    }
    chunks.current = [];
    const rec = new MediaRecorder(stream);
    recorder.current = rec;
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.current.push(e.data);
    };
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      setIsRecording(false);
      const blob = new Blob(chunks.current, { type: rec.mimeType || "audio/webm" });
      void submitAudio(blob);
    };
    rec.start();
    setIsRecording(true);
    recordStopTimer.current = window.setTimeout(stopRecording, MAX_AUDIO_MS);
  }, [stopRecording]);

  const submitAudio = useCallback(async (blob: Blob): Promise<void> => {
    if (blob.size === 0) return;
    setPending("transcribe");
    setCallError(null);
    try {
      const base64 = await blobToBase64(blob);
      const result: TranscribeResult = await apiClient.perceptionTranscribe({
        audioBase64: base64,
        mimeType: blob.type || "audio/webm",
      });
      pushRecord("transcribe", result.text || "(empty)", result.model, result.latencyMs);
    } catch (err) {
      setCallError(extractError(err));
    } finally {
      setPending(null);
    }
  }, []);

  const submitImage = useCallback(async (file: File): Promise<void> => {
    if (!file.type.startsWith("image/")) {
      setCallError("Drop an image file (png/jpg/webp).");
      return;
    }
    setPending("caption");
    setCallError(null);
    try {
      const base64 = await blobToBase64(file);
      const result: CaptionResult = await apiClient.perceptionCaption({ imageBase64: base64 });
      pushRecord("caption", result.caption || "(no caption)", result.model, result.latencyMs);
    } catch (err) {
      setCallError(extractError(err));
    } finally {
      setPending(null);
    }
  }, []);

  function pushRecord(kind: "transcribe" | "caption", text: string, model: string, latencyMs: number): void {
    setRecent((prev) =>
      [
        {
          id: `perc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          kind,
          text: text.length > 200 ? `${text.slice(0, 197)}...` : text,
          model,
          latencyMs,
          at: Date.now(),
        },
        ...prev,
      ].slice(0, RECENT_CAP),
    );
  }

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>): void => {
      e.preventDefault();
      setIsDragOver(false);
      const file = e.dataTransfer?.files?.[0];
      if (file) void submitImage(file);
    },
    [submitImage],
  );

  const onPickImage = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      const file = e.target.files?.[0];
      if (file) void submitImage(file);
      // Reset so picking the same file twice fires onChange again.
      e.target.value = "";
    },
    [submitImage],
  );

  if (!busOk) return null;

  const tone = statusTone(status);
  const statusLabel =
    status === null
      ? "probing..."
      : status.status === "down"
        ? "worker down"
        : tone === "ready"
          ? "ready"
          : "scaffold";

  return (
    <aside className="perception-panel" aria-label="Perception">
      <header className="perception-head">
        <Headphones size={14} />
        <span>Perception</span>
        <small className={`perception-status perception-status-${tone}`}>{statusLabel}</small>
        <button
          type="button"
          className="perception-toggle"
          aria-label={collapsed ? "Expand perception panel" : "Collapse perception panel"}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </header>

      {!collapsed && (
        <div className="perception-body">
          {status && status.status === "down" && (
            <p className="perception-hint">
              Worker offline. Start it from <code>worker/</code> with <code>python main.py</code>.
            </p>
          )}
          {status && status.status === "ok" && tone !== "ready" && (
            <p className="perception-hint">
              Worker up, ML deps not installed. <code>pip install -r requirements-ml.txt</code>.
            </p>
          )}

          <div className="perception-section">
            <h4>Speech → text</h4>
            <div className="perception-row">
              {!isRecording ? (
                <button
                  type="button"
                  className="perception-btn"
                  onClick={() => void startRecording()}
                  disabled={pending !== null}
                >
                  <Mic size={12} /> Start mic
                </button>
              ) : (
                <button type="button" className="perception-btn perception-btn-stop" onClick={stopRecording}>
                  <Square size={12} /> Stop
                </button>
              )}
              {permError && (
                <span className="perception-err">
                  <MicOff size={12} /> {permError}
                </span>
              )}
              {pending === "transcribe" && <span className="perception-pending">transcribing...</span>}
            </div>
          </div>

          <div className="perception-section">
            <h4>Image → caption</h4>
            <div
              className={`perception-drop ${isDragOver ? "perception-drop-over" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragOver(true);
              }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={onDrop}
            >
              <ImageIcon size={14} />
              <span>Drop image or </span>
              <label className="perception-pick">
                pick file
                <input type="file" accept="image/*" onChange={onPickImage} hidden />
              </label>
              {pending === "caption" && <span className="perception-pending"> · captioning...</span>}
            </div>
          </div>

          {callError && <p className="perception-err">{callError}</p>}

          {recent.length > 0 && (
            <div className="perception-section">
              <h4>Recent</h4>
              <ul className="perception-recent">
                {recent.map((r) => (
                  <li key={r.id} className={`perception-rec perception-rec-${r.kind}`}>
                    <span className="perception-rec-kind">{r.kind === "transcribe" ? "🎙" : "🖼"}</span>
                    <span className="perception-rec-text">{r.text}</span>
                    <small className="perception-rec-meta">
                      {r.model.split(":").slice(-1)[0]} · {formatLatency(r.latencyMs)}
                    </small>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

function extractError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
