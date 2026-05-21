// Desktop pet: standalone Tauri companion window. It mirrors live agent events
// and Phase 2 personality state without importing the Tauri API package.

import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Brain } from "lucide-react";
import { subscribeBrainBus } from "../../engine/brainBus";
import type { AgentRuntimeState } from "../../../shared/pipeline";
import type { PersonalityState, Phase2Mood } from "../../../shared/phase2";

type Mood = Phase2Mood | "thinking" | "acting" | "error";

const MOOD_COLOR: Record<Mood, string> = {
  idle: "#5df2ff",
  focused: "#83ffb0",
  curious: "#ffcf5a",
  excited: "#ff8a5d",
  analyzing: "#7aa7ff",
  assisting: "#ff7ab6",
  thinking: "#a985ff",
  acting: "#00ff88",
  error: "#ff4757",
};

const MOOD_LABEL: Record<Mood, string> = {
  idle: "watching",
  focused: "focused",
  curious: "curious",
  excited: "active",
  analyzing: "analyzing",
  assisting: "assisting",
  thinking: "thinking...",
  acting: "working...",
  error: "attention",
};

function moodFor(state: AgentRuntimeState | null, personality: PersonalityState | null): Mood {
  switch (state) {
    case "thinking":
      return "thinking";
    case "acting":
      return "acting";
    case "error":
      return "error";
    default:
      return personality?.mood ?? "idle";
  }
}

type TauriInternals = { invoke(cmd: string, args?: unknown): Promise<unknown> };

function tauriInvoke(): TauriInternals["invoke"] | null {
  if (typeof window === "undefined") return null;
  const internals = (window as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  return internals?.invoke ? internals.invoke.bind(internals) : null;
}

async function focusMainWindow(): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) return;
  try {
    await invoke("show_main_window");
  } catch {
    /* best effort */
  }
}

export function PetWindow(): JSX.Element {
  const [lastState, setLastState] = useState<AgentRuntimeState | null>(null);
  const [personality, setPersonality] = useState<PersonalityState | null>(null);
  const [summary, setSummary] = useState<string>("");
  const [subtitle, setSubtitle] = useState<string>("starting up...");
  const resetTimer = useRef<number | null>(null);

  useEffect(() => {
    const invoke = tauriInvoke();
    if (!invoke) return;
    let stopped = false;
    const load = async () => {
      try {
        const state = (await invoke("pet_personality_state")) as PersonalityState;
        if (!stopped) setPersonality(state);
      } catch {
        /* best effort */
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    return subscribeBrainBus((message) => {
      if (message.type === "agent-status") {
        setLastState(message.state);
        if (resetTimer.current) window.clearTimeout(resetTimer.current);
        if (message.state === "thinking" || message.state === "acting") {
          resetTimer.current = window.setTimeout(() => setLastState("idle"), 8000);
        }
        return;
      }
      if (message.type === "activity-observed") {
        setSubtitle(message.detail);
        const invoke = tauriInvoke();
        if (invoke) {
          void invoke("update_pet_activity", {
            input: {
              activity: message.detail,
              workload: Math.min(1, message.fileCount / 12),
              agentCount: 1,
              projectName: message.projectName,
              novelty: 0.45,
            },
          })
            .then((state) => setPersonality(state as PersonalityState))
            .catch(() => {});
        }
        return;
      }
      if (message.type === "summary-created") {
        setSummary(message.summary);
        setSubtitle(
          message.projectName ? `summarized ${message.projectName}` : "summarized recent work",
        );
      }
    });
  }, []);

  const mood = useMemo(() => moodFor(lastState, personality), [lastState, personality]);
  const color = MOOD_COLOR[mood];
  const focus = Math.round((personality?.focus ?? 0.35) * 100);
  const arousal = Math.round((personality?.arousal ?? 0.25) * 100);
  const pulseSeconds = Math.max(1.6, 3.2 - arousal / 42);
  const orbitSeconds = Math.max(2.2, 5.2 - arousal / 25);

  return (
    <div className="pet-root" onClick={() => void focusMainWindow()} title="Open Brain OS">
      <style>{`
        html, body, #root { background: transparent !important; margin: 0; height: 100%; overflow: hidden; }
        .pet-root {
          width: 100vw; height: 100vh; display: flex; flex-direction: column;
          align-items: center; justify-content: center; gap: 8px; cursor: pointer;
          font-family: ui-monospace, "JetBrains Mono", monospace; user-select: none;
          -webkit-user-select: none;
        }
        .pet-stage { position: relative; width: 118px; height: 118px; display: grid; place-items: center; }
        .pet-ring {
          position: absolute; inset: 0; border-radius: 50%;
          border: 1px solid ${color}66; opacity: 0.9;
          animation: petOrbit ${orbitSeconds}s linear infinite;
        }
        .pet-ring.second { inset: 10px; opacity: 0.55; animation-direction: reverse; }
        .pet-orb {
          position: relative; z-index: 2; width: 96px; height: 96px; border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          color: #0a0a0f; transition: background 220ms ease, box-shadow 220ms ease;
          animation: petPulse ${pulseSeconds}s ease-in-out infinite;
        }
        .pet-orb::after {
          content: ""; position: absolute; width: 18px; height: 6px; border-radius: 999px;
          bottom: 23px; background: rgba(10, 10, 15, 0.54);
          box-shadow: ${mood === "curious" ? "12px -18px 0 -2px rgba(10,10,15,.5)" : "none"};
        }
        @keyframes petPulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.06); }
        }
        @keyframes petOrbit { to { transform: rotate(360deg); } }
        .pet-label { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; }
        .pet-sub {
          font-size: 10px; max-width: 200px; text-align: center; line-height: 1.35;
          color: #8888a0; display: -webkit-box; -webkit-line-clamp: 2;
          -webkit-box-orient: vertical; overflow: hidden;
        }
        .pet-meter {
          display: flex; align-items: center; gap: 6px; color: ${color};
          font-size: 9px; opacity: 0.9;
        }
        .pet-meter-bar {
          width: 56px; height: 3px; border-radius: 999px; background: rgba(255,255,255,0.14); overflow: hidden;
        }
        .pet-meter-bar span { display: block; width: ${focus}%; height: 100%; background: ${color}; }
      `}</style>
      <div className="pet-stage">
        <div className="pet-ring" />
        <div className="pet-ring second" />
        <div
          className="pet-orb"
          style={{ background: color, boxShadow: `0 0 28px 6px ${color}66` }}
          aria-label={`Brain pet - ${MOOD_LABEL[mood]}`}
        >
          <Brain size={44} strokeWidth={1.6} />
        </div>
      </div>
      <div className="pet-label" style={{ color }}>
        {MOOD_LABEL[mood]}
      </div>
      <div className="pet-meter">
        <Activity size={10} />
        <div className="pet-meter-bar"><span /></div>
        <span>{focus}</span>
      </div>
      <div className="pet-sub">{summary || subtitle}</div>
      {personality?.notification ? <div className="pet-sub">{personality.notification}</div> : null}
    </div>
  );
}
