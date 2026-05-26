// Phase 1 (blueprint) — dim ticker overlay for IdleAgent's internal-monologue
// events. When the server's idle agent decides the system has been quiet long
// enough, it re-surfaces a memory; this component renders it as a faint
// bottom-center ticker that fades after a few seconds.
//
// Gate-safety (same rules as PerceptionPanel / DigitalTwinPanel):
//   * Renders `null` until the first idle-thought arrives. test:all without the
//     server never sees one, so this component cannot perturb verify:canvas
//     or smoke-actions (consoleIssues stays empty).
//   * No <input type=range> (would steal the density slider in smoke).
//   * Private `.idle-thought-*` CSS namespace.
//   * Auto-dismissal — never logs to console.

import { useEffect, useState } from "react";
import { subscribeBrainBus } from "../engine/brainBus";

interface IdleThought {
  memoryId: string;
  preview: string;
  importance: number;
  reason: string;
  at: number;
}

// 12s feels about right: long enough to read a 200-char preview, short enough
// that a real /api/ask can clear the screen quickly.
const DWELL_MS = 12_000;

export function IdleThoughtTicker(): JSX.Element | null {
  const [current, setCurrent] = useState<IdleThought | null>(null);

  useEffect(() => {
    return subscribeBrainBus((message) => {
      if (message.type !== "idle-thought") return;
      setCurrent({
        memoryId: message.memoryId,
        preview: message.preview,
        importance: message.importance,
        reason: message.reason,
        at: Date.now(),
      });
    });
  }, []);

  // Auto-dismiss after DWELL_MS. A new thought arriving mid-dwell replaces the
  // current one (rare — server's MIN_THOUGHT_GAP is 5min).
  useEffect(() => {
    if (!current) return;
    const id = window.setTimeout(() => setCurrent(null), DWELL_MS);
    return () => clearTimeout(id);
  }, [current?.at]);

  if (!current) return null;

  return (
    <aside className="idle-thought-ticker" aria-label="Idle thought">
      <span className="idle-thought-prefix">brain idly recalls</span>
      <span className="idle-thought-text">{current.preview}</span>
      <small className="idle-thought-meta">
        {current.reason} · importance {(current.importance * 100).toFixed(0)}%
      </small>
    </aside>
  );
}
