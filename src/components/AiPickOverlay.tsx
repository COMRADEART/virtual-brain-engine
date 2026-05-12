import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { BRAIN_ACTIONS } from "../data/regionDefinitions";
import type { BrainActionId } from "../engine/types";

export interface AiPickEvent {
  action: BrainActionId;
  why?: string;
  // Caller bumps this on every fresh pick so we can dismiss + re-show even
  // when the same action is picked twice in a row.
  sequence: number;
}

interface AiPickOverlayProps {
  pick: AiPickEvent | null;
  visibleMs?: number;
}

const ACTION_LABELS: Record<BrainActionId, string> = Object.fromEntries(
  BRAIN_ACTIONS.map((action) => [action.id, action.label]),
) as Record<BrainActionId, string>;

export function AiPickOverlay({ pick, visibleMs = 4000 }: AiPickOverlayProps): JSX.Element | null {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!pick) {
      setShown(false);
      return;
    }
    setShown(true);
    const timer = window.setTimeout(() => setShown(false), visibleMs);
    return () => window.clearTimeout(timer);
  }, [pick, visibleMs]);

  if (!pick) {
    return null;
  }

  return (
    <div
      className={shown ? "ai-pick-overlay visible" : "ai-pick-overlay"}
      role="status"
      aria-live="polite"
    >
      <Sparkles size={14} />
      <span className="ai-pick-action">Triggered {ACTION_LABELS[pick.action] ?? pick.action}</span>
      {pick.why ? <span className="ai-pick-why">· {pick.why}</span> : null}
    </div>
  );
}
