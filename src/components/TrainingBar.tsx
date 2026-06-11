// ---------------------------------------------------------------------------
// TrainingBar — live progress for the brain's OWN from-scratch model.
//
// The server auto-trains the scratch LLM on boot (AUTO_START_SCRATCH_LLM) and
// streams progress over the WS bus as `llm-training` frames; this bar renders
// them. On mount it also asks the server once, so opening the app mid-run
// shows the bar immediately instead of waiting for the next bus frame.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from "react";
import { apiClient } from "../engine/apiClient";
import { subscribeBrainBus } from "../engine/brainBus";
import { toastError, toastSuccess } from "../engine/toastBus";

interface BarState {
  state: "running" | "done" | "error";
  step: number;
  totalSteps: number;
  loss: number | null;
  params: number | null;
  device: string | null;
}

export function TrainingBar() {
  const [bar, setBar] = useState<BarState | null>(null);
  const hideTimer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .learningLlmStatus()
      .then((s) => {
        if (!cancelled && s.state === "running") {
          setBar({
            state: "running",
            step: s.step,
            totalSteps: s.totalSteps,
            loss: s.loss,
            params: s.params,
            device: s.device,
          });
        }
      })
      .catch(() => {
        // Server unreachable — the bus subscription below catches us up.
      });

    const unsubscribe = subscribeBrainBus((msg) => {
      if (msg.type !== "llm-training") return;
      setBar({
        state: msg.state,
        step: msg.step,
        totalSteps: msg.totalSteps,
        loss: msg.loss,
        params: msg.params,
        device: msg.device,
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Terminal transitions: toast once, linger briefly, then hide.
  const state = bar?.state ?? null;
  useEffect(() => {
    if (state !== "done" && state !== "error") return;
    if (state === "done") {
      toastSuccess("The brain's own model finished training");
    } else {
      toastError("Brain model training failed — see the Learning Lab for details");
    }
    hideTimer.current = window.setTimeout(() => setBar(null), 7000);
    return () => {
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    };
  }, [state]);

  if (!bar) return null;
  const pct = bar.totalSteps > 0 ? Math.min(100, (bar.step / bar.totalSteps) * 100) : null;
  const title =
    bar.state === "running"
      ? "Growing the brain's own model"
      : bar.state === "done"
        ? "Brain model trained"
        : "Brain model training failed";

  return (
    <div className={`training-bar training-bar--${bar.state}`} role="status" aria-live="polite">
      <div className="training-bar__head">
        <span className="training-bar__title">{title}</span>
        <span className="training-bar__meta">
          {bar.totalSteps > 0
            ? `step ${bar.step.toLocaleString()}/${bar.totalSteps.toLocaleString()}`
            : "starting…"}
          {bar.loss !== null ? ` · loss ${bar.loss.toFixed(2)}` : ""}
          {bar.params !== null ? ` · ${(bar.params / 1e6).toFixed(1)}M params` : ""}
          {bar.device ? ` · ${bar.device}` : ""}
        </span>
      </div>
      <div className="training-bar__track">
        <div
          className={`training-bar__fill${pct === null ? " training-bar__fill--indeterminate" : ""}`}
          style={pct !== null ? { width: `${pct}%` } : undefined}
        />
      </div>
    </div>
  );
}
