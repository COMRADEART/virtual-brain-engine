import { useEffect, useState } from "react";
import { subscribeBrainBus } from "../../engine/brainBus";
import type { BrainBusMessage } from "../../../shared/pipeline";

interface LogEntry {
  id: number;
  time: string;
  msg: string;
}

const MAX_ENTRIES = 6;

function formatTime(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return new Date().toLocaleTimeString("en-GB", { hour12: false });
  return d.toLocaleTimeString("en-GB", { hour12: false });
}

// Translate the curated subset of bus messages worth surfacing as a human-
// readable activity line. High-frequency snapshot events (twin/swarm/organism
// telemetry) are intentionally dropped so the log stays a signal, not noise.
function describe(message: BrainBusMessage): { time: string; msg: string } | null {
  switch (message.type) {
    case "pipeline":
      return {
        time: formatTime(message.timestamp),
        msg: message.detail
          ? `${message.step}: ${message.detail}`
          : `${message.step} · ${message.status}`,
      };
    case "diagnostic":
      return { time: formatTime(message.timestamp), msg: `${message.level}: ${message.message}` };
    case "idle-thought":
      return { time: formatTime(message.timestamp), msg: `Idle recall — ${message.preview}` };
    case "exploration-scheduled":
      return { time: formatTime(message.timestamp), msg: `Exploring ${message.target}` };
    case "perception":
      return { time: formatTime(message.timestamp), msg: `Perceived (${message.kind}) — ${message.preview}` };
    case "agent-status":
      return { time: formatTime(message.timestamp), msg: `${message.agent} → ${message.state}` };
    case "consolidation":
      return { time: formatTime(), msg: `Consolidation ${message.status}: ${message.detail}` };
    default:
      return null;
  }
}

export function SignalLogWidget() {
  const [entries, setEntries] = useState<LogEntry[]>([]);

  useEffect(() => {
    let nextId = 0;
    const unsubscribe = subscribeBrainBus((message) => {
      const described = describe(message);
      if (!described) return;
      setEntries((prev) =>
        [{ id: nextId++, ...described }, ...prev].slice(0, MAX_ENTRIES),
      );
    });
    return unsubscribe;
  }, []);

  return (
    <div className="dashboard-widget signal-log">
      <header className="widget-header">
        <h3 className="widget-title">Signal Log</h3>
      </header>
      <div className="widget-body">
        <div className="log-entries">
          {entries.length === 0 ? (
            <div className="log-entry empty">
              <span className="log-msg">Awaiting neural activity…</span>
            </div>
          ) : (
            entries.map((entry) => (
              <div className="log-entry" key={entry.id}>
                <span className="log-time">{entry.time}</span>{" "}
                <span className="log-msg">{entry.msg}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
